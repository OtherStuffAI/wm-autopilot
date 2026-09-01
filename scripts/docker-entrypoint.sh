#!/usr/bin/env bash
set -euo pipefail

is_enabled() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

run_autopilot() {
  if [[ "$(id -u)" -eq 0 ]]; then
    exec gosu wingman "$@"
  fi
  exec "$@"
}

fips_pid=""
autopilot_pid=""

shutdown_children() {
  if [[ -n "${autopilot_pid}" ]]; then
    kill -TERM "${autopilot_pid}" 2>/dev/null || true
  fi
  if [[ -n "${fips_pid}" ]]; then
    kill -TERM "${fips_pid}" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}

codex_workspace="${CODEX_TRUSTED_WORKSPACE:-}"
if [[ -n "${codex_workspace}" ]]; then
  codex_home="${CODEX_HOME:-${HOME}/.codex}"
  codex_config="${codex_home}/config.toml"
  escaped_workspace="${codex_workspace//\\/\\\\}"
  escaped_workspace="${escaped_workspace//\"/\\\"}"
  project_header="[projects.\"${escaped_workspace}\"]"

  mkdir -p "${codex_home}"
  touch "${codex_config}"
  if ! grep -Fqx "${project_header}" "${codex_config}"; then
    {
      printf "\n%s\n" "${project_header}"
      printf "trust_level = \"trusted\"\n"
    } >> "${codex_config}"
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    chown wingman:wingman "${codex_home}" "${codex_config}"
  fi
fi

if ! is_enabled "${FIPS_APPS_ENABLED:-false}"; then
  run_autopilot "$@"
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "FIPS_APPS_ENABLED requires the container bootstrap to run as root before dropping to wingman" >&2
  exit 1
fi
if [[ ! -c /dev/net/tun ]]; then
  echo "FIPS_APPS_ENABLED requires /dev/net/tun; use docker-compose.fips.yml" >&2
  exit 1
fi

fips_config_path="${FIPS_CONFIG_PATH:-/app/data/fips/fips.yaml}"
fips_control_socket="${FIPS_CONTROL_SOCKET:-/app/data/fips/control.sock}"
fips_state_dir="$(dirname "${fips_config_path}")"
fips_log_path="${fips_state_dir}/fips.log"
mkdir -p "${fips_state_dir}" /run/fips /etc/fips/fips.d
chown root:fips "${fips_state_dir}" /run/fips
chmod 0750 "${fips_state_dir}" /run/fips
if [[ ! -f "${fips_config_path}" ]]; then
  install -o root -g fips -m 0640 /app/config/fips-autopilot.yaml "${fips_config_path}"
fi

fips -c "${fips_config_path}" >>"${fips_log_path}" 2>&1 &
fips_pid="$!"

fips_ready=false
for _attempt in $(seq 1 80); do
  if ! kill -0 "${fips_pid}" 2>/dev/null; then
    echo "Bundled FIPS daemon exited during startup; inspect ${fips_log_path}" >&2
    exit 1
  fi
  if fipsctl --socket "${fips_control_socket}" show status >/dev/null 2>&1; then
    fips_ready=true
    break
  fi
  sleep 0.25
done
if [[ "${fips_ready}" != "true" ]]; then
  echo "Bundled FIPS daemon did not become ready; inspect ${fips_log_path}" >&2
  exit 1
fi

# Upstream's baseline returns immediately for non-fips0 traffic, accepts only
# established flows and ping by default, then includes this explicit app-port
# allowance. Managed web app ports begin at 41000 and TCP ports end at 65535.
printf '%s\n' 'tcp dport 41000-65535 accept' > /etc/fips/fips.d/autopilot-managed-apps.nft
nft -f /etc/fips/fips.nft

trap shutdown_children SIGINT SIGTERM SIGQUIT EXIT
gosu wingman "$@" &
autopilot_pid="$!"
set +e
wait -n "${autopilot_pid}" "${fips_pid}"
exit_code="$?"
set -e

if ! kill -0 "${fips_pid}" 2>/dev/null; then
  fips_pid=""
  echo "Bundled FIPS daemon exited while Autopilot was running; stopping Autopilot so the container can restart cleanly" >&2
  kill -TERM "${autopilot_pid}" 2>/dev/null || true
  wait "${autopilot_pid}" 2>/dev/null || true
  autopilot_pid=""
  if [[ "${exit_code}" -eq 0 ]]; then
    exit_code=1
  fi
else
  autopilot_pid=""
fi
exit "${exit_code}"

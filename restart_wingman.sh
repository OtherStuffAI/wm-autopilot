#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

usage() {
  cat <<'USAGE'
Usage:
  ./restart_wingman.sh
  ./restart_wingman.sh --env .env.wingman-01 --restart
  ./restart_wingman.sh --env .env.wingman-01 --reload-env
  ./restart_wingman.sh --env .env.wingman-01 --rebuild
  ./restart_wingman.sh .env.wingman-01 status

Actions:
  status       Show local Bun port status or Docker Compose status.
  restart      Restart the Docker service without recreating it.
  reload-env   Recreate the Docker service from the selected env file.
  rebuild      Rebuild the image and recreate the Docker service.
  stop         Stop the Docker service.
  logs         Tail recent Docker logs.
  start-local  Start local Bun with .env in the foreground.

Notes:
  .env is treated as local Bun config.
  .env.* files are treated as Docker instance env files, except .env.example.
USAGE
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

is_local_env() {
  [[ "$1" == ".env" ]]
}

is_docker_env() {
  [[ "$1" == .env.* && "$1" != ".env.example" ]]
}

get_env_value() {
  local env_file="$1"
  local key="$2"
  local line value
  line="$(grep -E "^${key}=" "$env_file" 2>/dev/null | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

discover_env_files() {
  ENV_FILES=()
  if [[ -f ".env" ]]; then
    ENV_FILES+=(".env")
  fi
  local file
  for file in .env.*; do
    [[ -f "$file" ]] || continue
    [[ "$file" == ".env.example" ]] && continue
    ENV_FILES+=("$file")
  done
}

describe_env_file() {
  local env_file="$1"
  if is_local_env "$env_file"; then
    local port
    port="$(get_env_value "$env_file" "PORT")"
    printf '%s (local Bun%s)' "$env_file" "${port:+, port $port}"
    return
  fi

  local project host_port base_url
  project="$(get_env_value "$env_file" "COMPOSE_PROJECT_NAME")"
  host_port="$(get_env_value "$env_file" "WINGMAN_HOST_PORT")"
  base_url="$(get_env_value "$env_file" "WINGMAN_BASE_URL")"
  printf '%s (Docker%s%s%s)' \
    "$env_file" \
    "${project:+, $project}" \
    "${host_port:+, host port $host_port}" \
    "${base_url:+, $base_url}"
}

compose_with_env() {
  local env_file="$1"
  shift
  docker compose --env-file "$env_file" "$@"
}

local_status() {
  local env_file="$1"
  local port
  port="$(get_env_value "$env_file" "PORT")"
  port="${port:-3600}"
  printf 'Local Bun env: %s\n' "$env_file"
  printf 'Expected URL: http://localhost:%s/home\n' "$port"
  if have lsof; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
  else
    printf 'lsof is not available; cannot inspect the listening process.\n'
  fi
}

start_local() {
  local env_file="$1"
  [[ "$env_file" == ".env" ]] || fail "local Bun start only supports .env"
  printf 'Starting local Bun with %s in the foreground.\n' "$env_file"
  bun start
}

docker_status() {
  local env_file="$1"
  compose_with_env "$env_file" ps
}

docker_restart() {
  local env_file="$1"
  compose_with_env "$env_file" restart wingman
  compose_with_env "$env_file" ps
}

docker_reload_env() {
  local env_file="$1"
  compose_with_env "$env_file" up -d --force-recreate
  compose_with_env "$env_file" ps
}

docker_rebuild() {
  local env_file="$1"
  compose_with_env "$env_file" up -d --build --force-recreate
  compose_with_env "$env_file" ps
}

docker_stop() {
  local env_file="$1"
  compose_with_env "$env_file" stop wingman
  compose_with_env "$env_file" ps
}

docker_logs() {
  local env_file="$1"
  compose_with_env "$env_file" logs --tail=120 wingman
}

run_action() {
  local env_file="$1"
  local action="$2"

  [[ -f "$env_file" ]] || fail "env file not found: $env_file"

  if is_local_env "$env_file"; then
    case "$action" in
      status) local_status "$env_file" ;;
      start-local) start_local "$env_file" ;;
      restart|reload-env|rebuild|stop|logs)
        fail "$action is a Docker action; select a .env.* Docker instance file"
        ;;
      *) fail "unknown action for local env: $action" ;;
    esac
    return
  fi

  is_docker_env "$env_file" || fail "Docker env files should be named .env.<instance>; got $env_file"
  have docker || fail "docker is required"

  case "$action" in
    status) docker_status "$env_file" ;;
    restart) docker_restart "$env_file" ;;
    reload-env) docker_reload_env "$env_file" ;;
    rebuild) docker_rebuild "$env_file" ;;
    stop) docker_stop "$env_file" ;;
    logs) docker_logs "$env_file" ;;
    start-local) fail "start-local only supports .env" ;;
    *) fail "unknown action: $action" ;;
  esac
}

choose_env_file() {
  discover_env_files
  [[ "${#ENV_FILES[@]}" -gt 0 ]] || fail "no .env or .env.* files found"

  printf '\nSelect Wingman config\n'
  local index
  for index in "${!ENV_FILES[@]}"; do
    printf '  %s) %s\n' "$((index + 1))" "$(describe_env_file "${ENV_FILES[$index]}")"
  done

  local choice
  while true; do
    read -r -p "Config number: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#ENV_FILES[@]} )); then
      SELECTED_ENV_FILE="${ENV_FILES[$((choice - 1))]}"
      return
    fi
    printf 'Choose a number from 1 to %s.\n' "${#ENV_FILES[@]}"
  done
}

choose_action() {
  local env_file="$1"
  local actions
  if is_local_env "$env_file"; then
    actions=("status" "start-local")
  else
    actions=("status" "restart" "reload-env" "rebuild" "stop" "logs")
  fi

  printf '\nSelect action for %s\n' "$(describe_env_file "$env_file")"
  local index
  for index in "${!actions[@]}"; do
    printf '  %s) %s\n' "$((index + 1))" "${actions[$index]}"
  done

  local choice
  while true; do
    read -r -p "Action number: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#actions[@]} )); then
      SELECTED_ACTION="${actions[$((choice - 1))]}"
      return
    fi
    printf 'Choose a number from 1 to %s.\n' "${#actions[@]}"
  done
}

env_file=""
action=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --env)
      [[ $# -ge 2 ]] || fail "--env requires a file path"
      env_file="$2"
      shift 2
      ;;
    --status)
      action="status"
      shift
      ;;
    --restart)
      action="restart"
      shift
      ;;
    --reload-env|--reload)
      action="reload-env"
      shift
      ;;
    --rebuild)
      action="rebuild"
      shift
      ;;
    --stop)
      action="stop"
      shift
      ;;
    --logs)
      action="logs"
      shift
      ;;
    --start-local)
      action="start-local"
      shift
      ;;
    *)
      if [[ -z "$env_file" && -f "$1" ]]; then
        env_file="$1"
      elif [[ -z "$action" ]]; then
        action="$1"
      else
        fail "unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

if [[ -z "$env_file" ]]; then
  choose_env_file
  env_file="$SELECTED_ENV_FILE"
fi

if [[ -z "$action" ]]; then
  choose_action "$env_file"
  action="$SELECTED_ACTION"
fi

run_action "$env_file" "$action"

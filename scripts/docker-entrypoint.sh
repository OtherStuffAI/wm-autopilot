#!/usr/bin/env bash
set -euo pipefail

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
fi

exec "$@"

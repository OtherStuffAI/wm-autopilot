#!/usr/bin/env bash
# Generate only the main service rule included by upstream's fips0 policy.
set -euo pipefail
case "${FIPS_AUTOPILOT_ENABLED:-${FIPS_APPS_ENABLED:-false}}" in
  1|true|TRUE|yes|YES|on|ON) ;;
  *) exit 0 ;;
esac
fips_ingress_port="${FIPS_AUTOPILOT_PORT:-3601}"
if [[ ! "${fips_ingress_port}" =~ ^[0-9]{4,5}$ ]] || (( 10#${fips_ingress_port} < 1024 || 10#${fips_ingress_port} >= 41000 || 10#${fips_ingress_port} == ${PORT:-3600} )); then
  echo "FIPS_AUTOPILOT_PORT must be 1024-40999 and differ from PORT" >&2
  exit 2
fi
printf 'tcp dport %d accept\n' "$((10#${fips_ingress_port}))"

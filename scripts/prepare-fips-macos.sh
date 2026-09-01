#!/usr/bin/env bash
set -euo pipefail

VERSION="0.5.0"
RELEASE_BASE="https://github.com/jmcorgan/fips/releases/download/v${VERSION}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="${FIPS_MACOS_BUNDLE_DIR:-${PROJECT_ROOT}/vendor/fips}"

prepare_arch() {
  local arch="$1"
  local sha256 asset output temp actual
  case "$arch" in
    arm64) sha256="3c2252677725a30f4ef68f01935ca6741e57568854d3f71202f2fa90d7239052" ;;
    x86_64) sha256="a7883c71039ff591880c38c2421b361103f2ecf20840a9bd496eda13cb3e24c0" ;;
    *) echo "Unsupported macOS architecture: $arch" >&2; return 1 ;;
  esac
  asset="fips-${VERSION}-macos-${arch}.pkg"
  output="${OUTPUT_DIR}/${asset}"
  mkdir -p "$OUTPUT_DIR"
  if [[ -f "$output" ]] && [[ "$(shasum -a 256 "$output" | awk '{print $1}')" == "$sha256" ]]; then
    echo "Verified bundled ${asset}"
    return
  fi
  temp="$(mktemp "${OUTPUT_DIR}/.${asset}.XXXXXX")"
  trap 'rm -f "${temp:-}"' RETURN
  curl --fail --location --retry 3 --output "$temp" "${RELEASE_BASE}/${asset}"
  actual="$(shasum -a 256 "$temp" | awk '{print $1}')"
  if [[ "$actual" != "$sha256" ]]; then
    echo "FIPS package checksum mismatch for ${asset}: expected ${sha256}, got ${actual}" >&2
    return 1
  fi
  mv "$temp" "$output"
  chmod 0644 "$output"
  trap - RETURN
  echo "Bundled ${asset}"
}

if [[ "${1:-}" == "--all" ]]; then
  prepare_arch arm64
  prepare_arch x86_64
else
  prepare_arch "${1:-$(uname -m)}"
fi

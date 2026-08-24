#!/usr/bin/env bash
set -euo pipefail

PID="${1:-}"
ROOT="${2:-}"

if [[ -z "$PID" || -z "$ROOT" ]]; then
  echo "Usage: $0 <wingman-pid> <project-root>" >&2
  exit 1
fi

if kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"
  for _ in {1..120}; do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "Wingman process $PID did not exit within timeout" >&2
  exit 1
fi

cd "$ROOT"

exec bun run src/index.ts

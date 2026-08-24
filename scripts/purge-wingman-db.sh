#!/usr/bin/env sh

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
DB_PATH="$ROOT/data/wingman.db"

if [ ! -f "$DB_PATH" ]; then
  echo "[wingman-db] nothing to purge; $DB_PATH is missing."
  exit 0
fi

TIMESTAMP=$(date +%Y%m%d%H%M%S)
BACKUP_PATH="$DB_PATH.$TIMESTAMP.bak"
echo "[wingman-db] backing up current DB to $BACKUP_PATH"
cp "$DB_PATH" "$BACKUP_PATH"

echo "[wingman-db] removing $DB_PATH"
rm "$DB_PATH"

echo "[wingman-db] purge complete. Restart Wingman to let it re-create a fresh database."

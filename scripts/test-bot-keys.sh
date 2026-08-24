#!/usr/bin/env bash
#
# Manual verification script for the per-user bot key system.
#
# Checks:  data layer (SQLite), API validation, escrow unlock,
#           NIP-44 encrypt/decrypt round-trip, NIP-98 signing,
#           and identity separation (bot vs root).
#
# Usage:
#   ./scripts/test-bot-keys.sh              # auto-detect port from .env
#   ./scripts/test-bot-keys.sh 3600         # explicit port
#   ./scripts/test-bot-keys.sh 3021 sess-id # explicit port + session ID
#
# Prerequisites:
#   - Wingman server running
#   - At least one active session with an associated user npub
#   - sqlite3 on PATH

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
DB_PATH="$ROOT/data/bot-keys.db"

# ---------------------------------------------------------------------------
# Args / config
# ---------------------------------------------------------------------------

PORT="${1:-}"
SESSION_ID="${2:-}"

# Auto-detect port from .env if not supplied
if [ -z "$PORT" ]; then
  if [ -f "$ROOT/.env" ]; then
    PORT=$(grep -E '^PORT=' "$ROOT/.env" | cut -d= -f2 | tr -d '[:space:]')
  fi
  PORT="${PORT:-3600}"
fi

BASE="http://localhost:$PORT"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass=0
fail=0
skip=0

green()  { printf "\033[32m%s\033[0m" "$1"; }
red()    { printf "\033[31m%s\033[0m" "$1"; }
yellow() { printf "\033[33m%s\033[0m" "$1"; }

check() {
  local label="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    printf "  %-50s %s\n" "$label" "$(green PASS)"
    pass=$((pass + 1))
  else
    printf "  %-50s %s\n" "$label" "$(red FAIL)"
    echo "    expected to contain: $expected"
    echo "    got: $actual"
    fail=$((fail + 1))
  fi
}

check_status() {
  local label="$1" expected_status="$2" actual_status="$3"
  if [ "$actual_status" = "$expected_status" ]; then
    printf "  %-50s %s\n" "$label" "$(green PASS)"
    pass=$((pass + 1))
  else
    printf "  %-50s %s\n" "$label" "$(red "FAIL (HTTP $actual_status, expected $expected_status)")"
    fail=$((fail + 1))
  fi
}

skip_check() {
  local label="$1" reason="$2"
  printf "  %-50s %s\n" "$label" "$(yellow "SKIP: $reason")"
  skip=$((skip + 1))
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

echo "=== Bot Key System Verification ==="
echo "Server:   $BASE"
echo "Database: $DB_PATH"
echo ""

# Check server reachable
STATUS_RESP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/mcp/nip98/status" 2>/dev/null || echo "000")
if [ "$STATUS_RESP" = "000" ]; then
  echo "$(red 'ERROR'): Server not reachable at $BASE"
  exit 1
fi
echo "Server reachable: $(green OK)"

# Check database exists
if [ ! -f "$DB_PATH" ]; then
  echo "$(red 'ERROR'): Bot keys database not found at $DB_PATH"
  exit 1
fi
echo "Database exists:  $(green OK)"

# Count records
TOTAL=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM bot_keys;")
ACTIVE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM bot_keys WHERE is_active=1;")
echo "Bot keys:         $TOTAL total, $ACTIVE active"

if [ "$ACTIVE" -eq 0 ]; then
  echo "$(red 'ERROR'): No active bot keys — start a session with a logged-in user first"
  exit 1
fi

# Grab the active record
BOT_PUBKEY=$(sqlite3 "$DB_PATH" "SELECT bot_pubkey_hex FROM bot_keys WHERE is_active=1 LIMIT 1")
BOT_NPUB=$(sqlite3 "$DB_PATH" "SELECT bot_npub FROM bot_keys WHERE is_active=1 LIMIT 1")
USER_NPUB=$(sqlite3 "$DB_PATH" "SELECT user_npub FROM bot_keys WHERE is_active=1 LIMIT 1")
ESCROW_UUID=$(sqlite3 "$DB_PATH" "SELECT escrow_uuid FROM bot_keys WHERE is_active=1 LIMIT 1")

echo "User npub:        ${USER_NPUB:0:25}..."
echo "Bot npub:         ${BOT_NPUB:0:25}..."
echo "Bot pubkey:       ${BOT_PUBKEY:0:20}..."
echo "Escrow UUID:      $ESCROW_UUID"

# Auto-detect session ID if not supplied
if [ -z "$SESSION_ID" ]; then
  # Try to find a running session for this user via the API
  SESSION_ID=$(curl -s "$BASE/api/sessions" 2>/dev/null \
    | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    sessions = data if isinstance(data, list) else data.get('sessions', [])
    for s in sessions:
        if s.get('status') == 'running' and s.get('npub'):
            print(s['id'])
            break
except: pass
" 2>/dev/null || true)
fi

if [ -z "$SESSION_ID" ]; then
  echo "$(yellow 'WARNING'): No session ID found — some tests will be skipped"
  echo "  Pass a session ID as second argument: $0 $PORT <session-id>"
else
  echo "Session ID:       ${SESSION_ID:0:25}..."
fi

echo ""

# ---------------------------------------------------------------------------
# 1. Authentication & validation
# ---------------------------------------------------------------------------

echo "--- Authentication & Validation ---"

RESP=$(curl -s -w "\n%{http_code}" "$BASE/api/bot-keys/me")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -1)
check_status "GET /bot-keys/me without cookie → 401" "401" "$CODE"
check "Response mentions session cookie" "session cookie" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" "$BASE/api/bot-keys/encrypted")
CODE=$(echo "$RESP" | tail -1)
check_status "GET /bot-keys/encrypted without cookie → 401" "401" "$CODE"

RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/bot-keys/unlock" \
  -H "Content-Type: application/json" \
  -d '{"nsecHex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')
CODE=$(echo "$RESP" | tail -1)
check_status "POST /bot-keys/unlock without cookie → 401" "401" "$CODE"

echo ""

# ---------------------------------------------------------------------------
# 2. Session validation
# ---------------------------------------------------------------------------

echo "--- Session Validation ---"

RESP=$(curl -s "$BASE/api/bot-keys/unlock-escrow" \
  -X POST -H "Content-Type: application/json" \
  -d '{"sessionId":"nonexistent-session-id","escrowUuid":"0000000000000000"}')
check "Bad session → Unknown session" "Unknown session" "$RESP"

if [ -n "$SESSION_ID" ]; then
  RESP=$(curl -s "$BASE/api/bot-keys/unlock-escrow" \
    -X POST -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"$SESSION_ID\",\"escrowUuid\":\"0000000000000000\"}")
  check "Valid session, wrong UUID → Invalid escrow" "Invalid escrow UUID" "$RESP"
else
  skip_check "Valid session, wrong UUID" "no session ID"
fi

RESP=$(curl -s "$BASE/api/mcp/bot-crypto/encrypt" \
  -X POST -H "Content-Type: application/json" \
  -d '{"sessionId":"nonexistent"}')
check "Bot crypto encrypt bad session → 400/404" "required\|Unknown session" "$RESP"

echo ""

# ---------------------------------------------------------------------------
# 3. Escrow unlock
# ---------------------------------------------------------------------------

echo "--- Escrow Unlock ---"

if [ -n "$SESSION_ID" ]; then
  RESP=$(curl -s "$BASE/api/bot-keys/unlock-escrow" \
    -X POST -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"$SESSION_ID\",\"escrowUuid\":\"$ESCROW_UUID\"}")
  check "Escrow unlock with correct UUID → unlocked" "unlocked.*true" "$RESP"
  check "Escrow unlock returns bot npub" "$BOT_NPUB" "$RESP"
else
  skip_check "Escrow unlock" "no session ID"
  skip_check "Escrow unlock returns bot npub" "no session ID"
fi

echo ""

# ---------------------------------------------------------------------------
# 4. NIP-44 encrypt/decrypt round-trip
# ---------------------------------------------------------------------------

echo "--- NIP-44 Bot Crypto Proxy ---"

if [ -n "$SESSION_ID" ]; then
  # Encrypt
  ENC_RESP=$(curl -s "$BASE/api/mcp/bot-crypto/encrypt" \
    -X POST -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"$SESSION_ID\",\"plaintext\":\"bot-key-test-payload\",\"recipientPubkey\":\"$BOT_PUBKEY\"}")

  if echo "$ENC_RESP" | grep -q "ciphertext"; then
    check "Encrypt returns ciphertext" "ciphertext" "$ENC_RESP"
    check "Encrypt senderPubkey is bot key" "$BOT_PUBKEY" "$ENC_RESP"

    # Extract for decrypt
    CIPHERTEXT=$(echo "$ENC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['ciphertext'])")
    SENDER=$(echo "$ENC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['senderPubkey'])")

    DEC_RESP=$(curl -s "$BASE/api/mcp/bot-crypto/decrypt" \
      -X POST -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"$SESSION_ID\",\"ciphertext\":\"$CIPHERTEXT\",\"senderPubkey\":\"$SENDER\"}")
    check "Decrypt recovers plaintext" "bot-key-test-payload" "$DEC_RESP"
    check "Decrypt decryptedBy is bot key" "$BOT_PUBKEY" "$DEC_RESP"
  else
    check "Encrypt returns ciphertext" "ciphertext" "$ENC_RESP"
    skip_check "Decrypt round-trip" "encrypt failed"
    skip_check "Decrypt decryptedBy" "encrypt failed"
  fi
else
  skip_check "Encrypt" "no session ID"
  skip_check "Encrypt senderPubkey" "no session ID"
  skip_check "Decrypt round-trip" "no session ID"
  skip_check "Decrypt decryptedBy" "no session ID"
fi

echo ""

# ---------------------------------------------------------------------------
# 5. NIP-98 Tier 1 signing
# ---------------------------------------------------------------------------

echo "--- NIP-98 Tier 1 Signing ---"

if [ -n "$SESSION_ID" ]; then
  SIGN_RESP=$(curl -s "$BASE/api/mcp/nip98/sign" \
    -X POST -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"$SESSION_ID\",\"url\":\"https://example.com/api/verify\",\"method\":\"GET\",\"tier\":1}")

  check "Sign returns signerType bot" "bot" "$SIGN_RESP"
  check "Sign signedBy is bot npub" "$BOT_NPUB" "$SIGN_RESP"

  # Decode the token and verify event structure
  TOKEN=$(echo "$SIGN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
  if [ -n "$TOKEN" ] && echo "$TOKEN" | grep -q "^Nostr "; then
    EVENT_CHECK=$(echo "$TOKEN" | python3 -c "
import sys, json, base64
token = sys.stdin.read().strip()
event = json.loads(base64.b64decode(token[6:]))
checks = []
if event.get('kind') == 27235: checks.append('kind:ok')
if event.get('pubkey') == '$BOT_PUBKEY': checks.append('pubkey:ok')
if event.get('sig'): checks.append('sig:ok')
tags = {t[0]: t[1] for t in event.get('tags', []) if len(t) >= 2}
if tags.get('u') == 'https://example.com/api/verify': checks.append('url:ok')
if tags.get('method') == 'GET': checks.append('method:ok')
print(' '.join(checks))
")
    check "NIP-98 event kind=27235" "kind:ok" "$EVENT_CHECK"
    check "NIP-98 event pubkey is bot" "pubkey:ok" "$EVENT_CHECK"
    check "NIP-98 event has signature" "sig:ok" "$EVENT_CHECK"
    check "NIP-98 event url tag correct" "url:ok" "$EVENT_CHECK"
    check "NIP-98 event method tag correct" "method:ok" "$EVENT_CHECK"
  else
    skip_check "NIP-98 event structure" "token decode failed"
  fi
else
  skip_check "NIP-98 signing" "no session ID"
fi

echo ""

# ---------------------------------------------------------------------------
# 6. Security checks
# ---------------------------------------------------------------------------

echo "--- Security ---"

RESP=$(curl -s "$BASE/api/bot-keys/unlock-escrow" \
  -X POST -H "Content-Type: application/json" \
  -d '{"sessionId":"nonexistent","escrowUuid":"0000000000000000"}')
check "Escrow unlock bad session rejected" "Unknown session" "$RESP"

if [ -n "$SESSION_ID" ]; then
  RESP=$(curl -s "$BASE/api/bot-keys/unlock-escrow" \
    -X POST -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"$SESSION_ID\",\"escrowUuid\":\"badbadbadbadbad0\"}")
  check "Escrow unlock wrong UUID rejected" "Invalid escrow UUID" "$RESP"
fi

RESP=$(curl -s "$BASE/api/mcp/bot-crypto/encrypt" \
  -X POST -H "Content-Type: application/json" \
  -d '{"sessionId":"x","plaintext":"t","recipientPubkey":"not-hex"}')
check "Bot crypto rejects invalid pubkey format" "64-character hex\|Unknown session" "$RESP"

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

total=$((pass + fail + skip))
echo "==========================================="
printf "Results: %s passed" "$(green "$pass")"
if [ "$fail" -gt 0 ]; then
  printf ", %s failed" "$(red "$fail")"
fi
if [ "$skip" -gt 0 ]; then
  printf ", %s skipped" "$(yellow "$skip")"
fi
printf " (%d total)\n" "$total"
echo "==========================================="

if [ "$fail" -gt 0 ]; then
  exit 1
fi

#!/usr/bin/env bash
# Full official-mode flow (contract §1 + §4): build the release binaries, start
# the server with a one-file downloads directory, then drive a real Chrome
# through registration, installation, agent registration, screenshots, token
# regeneration/revocation and an SSE reconnect.
#
# Prerequisite: `web/dist` must exist. Build it with `(cd web && npm run build)`
# before running this script; the server embeds whatever is in that directory.
#
# Everything the run creates lives in `.conductor/e4-e2e/` and is removed first.
# Screenshots are written to `docs/screenshots/`.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=18086
BASE="http://127.0.0.1:$PORT"
E2E="$ROOT/.conductor/e4-e2e"
DATA="$E2E/data"
DOWNLOADS="$E2E/downloads"
HOME_DIR="$E2E/home"
BIN_DIR="$E2E/bin"
CONFIG="$E2E/config.json"
LOG="$E2E/server.log"
PID_FILE="$E2E/server.pid"
CHROME=${CHROME_PATH:-/usr/bin/google-chrome}

if [ ! -f "$ROOT/web/dist/index.html" ]; then
  echo "FAIL: web/dist/index.html is missing; run (cd web && npm run build) first" >&2
  exit 1
fi
if [ ! -x "$CHROME" ]; then
  echo "FAIL: chrome not found at $CHROME (set CHROME_PATH)" >&2
  exit 1
fi

rm -rf "$E2E"
mkdir -p "$DATA" "$DOWNLOADS" "$HOME_DIR" "$BIN_DIR"

echo "PASS: cleaned $E2E"

cargo build --release -p loo-cli -p loo-server

# The download names are file names; there is no fallback to another platform.
cp "$ROOT/target/release/loo" "$DOWNLOADS/loo-linux-x64"
chmod 755 "$DOWNLOADS/loo-linux-x64"
echo "PASS: published target/release/loo as downloads/loo-linux-x64"

printf '%s\n' '{"session":{"idle_cleanup_ticks":100000}}' > "$CONFIG"

cleanup() {
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$PID" ]; then
      kill "$PID" 2>/dev/null || true
      for _ in $(seq 1 50); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.1
      done
      kill -9 "$PID" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT

"$ROOT/target/release/loo-server" \
  --official \
  --addr "127.0.0.1:$PORT" \
  --map maps/default.txt \
  --config "$CONFIG" \
  --tick-seconds 1 \
  --data-dir "$DATA" \
  --downloads-dir "$DOWNLOADS" \
  >>"$LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"
# The E2E script may hard-stop this process during the SSE reconnect test;
# dropping the job entry keeps that expected SIGKILL out of the log.
disown "$SERVER_PID" 2>/dev/null || true

ready=0
for _ in $(seq 1 200); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: server did not become ready" >&2
  sed -n '1,80p' "$LOG" >&2 || true
  exit 1
fi
echo "PASS: official server is up on $BASE"

LOO_E2E_ROOT="$ROOT" \
LOO_E2E_BASE="$BASE" \
LOO_E2E_DATA="$DATA" \
LOO_E2E_DOWNLOADS="$DOWNLOADS" \
LOO_E2E_CONFIG="$CONFIG" \
LOO_E2E_SERVER="$ROOT/target/release/loo-server" \
LOO_E2E_LOG="$LOG" \
LOO_E2E_PID_FILE="$PID_FILE" \
LOO_E2E_PORT="$PORT" \
LOO_E2E_HOME="$HOME_DIR" \
LOO_E2E_BIN="$BIN_DIR" \
CHROME_PATH="$CHROME" \
node "$ROOT/web/e2e/flow.mjs"

echo "PASS: e2e-full completed"

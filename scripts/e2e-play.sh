#!/usr/bin/env bash
# Real-Chrome end-to-end for the human `/play` page (contract-J §plays).
#
# One official server on 18131 with a 0.5 s tick, one account created in Chrome,
# the served CLI installer, one AI agent in the same world, then the scripted
# round: create human → join → walk to the toilet → close the door → use →
# success, plus CLI-vs-human visibility/collision/attack, the 9×9 leak checks,
# the human/mixed/AI boards, the mixed stats scope, a 390-wide round and the
# docs screenshots.
#
# Prerequisite: `web/dist` must exist. Build it with `(cd web && npm run build)`
# before running this script; the server embeds whatever is in that directory.
#
# Everything the run creates lives in `.conductor/j/` and is removed first.
# Screenshots go to `docs/screenshots/`.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=18131
BASE="http://127.0.0.1:$PORT"
J="$ROOT/.conductor/j"
DATA="$J/data"
DOWNLOADS="$J/downloads"
HOME_DIR="$J/home"
BIN_DIR="$J/bin"
CHROME_DIR="$J/chrome"
CONFIG="$J/config.json"
LOG="$J/server.log"
PID_FILE="$J/server.pid"
CHROME=${CHROME_PATH:-/usr/bin/google-chrome}

if [ ! -f "$ROOT/web/dist/index.html" ]; then
  echo "FAIL: web/dist/index.html is missing; run (cd web && npm run build) first" >&2
  exit 1
fi
if [ ! -x "$CHROME" ]; then
  echo "FAIL: Chrome is not executable at $CHROME (override with CHROME_PATH)" >&2
  exit 1
fi

rm -rf "$J"
mkdir -p "$DATA" "$DOWNLOADS" "$HOME_DIR" "$BIN_DIR" "$CHROME_DIR"

echo "PASS: cleaned $J"

cargo build --release -p loo-cli -p loo-server

# The download names are file names; there is no fallback to another platform.
cp "$ROOT/target/release/loo" "$DOWNLOADS/loo-linux-x64"
chmod 755 "$DOWNLOADS/loo-linux-x64"
echo "PASS: published target/release/loo as downloads/loo-linux-x64"

printf '%s\n' '{"session":{"idle_cleanup_ticks":100000}}' > "$CONFIG"

cleanup() {
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT

"$ROOT/target/release/loo-server" \
  --official \
  --addr "127.0.0.1:$PORT" \
  --tick-seconds 0.5 \
  --map maps/default.txt \
  --config "$CONFIG" \
  --data-dir "$DATA" \
  --downloads-dir "$DOWNLOADS" \
  >>"$LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"
disown "$SERVER_PID" 2>/dev/null || true

ready=0
for _ in $(seq 1 400); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.05
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: official server did not become healthy on $BASE; log:" >&2
  tail -n 40 "$LOG" >&2 || true
  exit 1
fi
echo "PASS: official server is up on $BASE (tick 0.5s, .conductor/j)"

LOO_PLAY_ROOT="$ROOT" \
LOO_PLAY_BASE="$BASE" \
LOO_PLAY_PORT="$PORT" \
LOO_PLAY_J="$J" \
LOO_PLAY_DATA="$DATA" \
LOO_PLAY_DOWNLOADS="$DOWNLOADS" \
LOO_PLAY_HOME="$HOME_DIR" \
LOO_PLAY_BIN="$BIN_DIR" \
LOO_PLAY_CHROME="$CHROME_DIR" \
LOO_PLAY_CONFIG="$CONFIG" \
LOO_PLAY_LOG="$LOG" \
LOO_PLAY_PID_FILE="$PID_FILE" \
CHROME_PATH="$CHROME" \
node "$ROOT/web/e2e/play.mjs"

echo "PASS: e2e-play completed"

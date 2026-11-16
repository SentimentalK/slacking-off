#!/usr/bin/env bash
# Real-Chrome end-to-end for the language switch (web/src/i18n): browser-language
# following for zh-CN, en-US and ja-JP, the manual choice in Settings, the English and
# Chinese screens with no stray text, and the review screenshots in docs/screenshots/m/.
#
# One official server on 18121 with a 0.5 s tick. Everything the run creates lives in
# `.conductor/m/i18n/` and is removed first. The server embeds `web/dist`, so the web
# build must run before this script: `(cd web && npm run build)`.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=18121
BASE="http://127.0.0.1:$PORT"
I="$ROOT/.conductor/m/i18n"
DATA="$I/data"
DOWNLOADS="$I/downloads"
CONFIG="$I/config.json"
LOG="$I/server.log"
PID_FILE="$I/server.pid"
CHROME=${CHROME_PATH:-/usr/bin/google-chrome}

if [ ! -f "$ROOT/web/dist/index.html" ]; then
  echo "FAIL: web/dist/index.html is missing; run (cd web && npm run build) first" >&2
  exit 1
fi
if [ ! -x "$CHROME" ]; then
  echo "FAIL: Chrome is not executable at $CHROME (override with CHROME_PATH)" >&2
  exit 1
fi

rm -rf "$I"
mkdir -p "$DATA" "$DOWNLOADS" "$I/home" "$I/bin" "$I/chrome"

cargo build --release -p loo-cli -p loo-server

cp "$ROOT/target/release/loo" "$DOWNLOADS/loo-linux-x64"
chmod 755 "$DOWNLOADS/loo-linux-x64"

printf '%s\n' '{"session":{"idle_cleanup_ticks":100000}}' > "$CONFIG"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
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
echo "PASS: official server is up on $BASE (tick 0.5s, .conductor/m/i18n)"

mkdir -p "$ROOT/docs/screenshots/m"

LOO_I18N_PORT="$PORT" \
LOO_I18N_DIR="$I" \
CHROME_PATH="$CHROME" \
node "$ROOT/web/e2e/i18n.mjs"

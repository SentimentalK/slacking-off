#!/usr/bin/env bash
# Empty-world replay acceptance (K2): build the web bundle, the release binaries
# and an official server on port 18143 with an empty data directory, then drive a
# real Chrome through `web/e2e/onboarding.mjs` (no replay on a fresh database,
# replay of the last highlight once the field empties, switch back to live within
# two ticks when an agent walks in).
#
# The server embeds `web/dist` at compile time, so the web build runs before
# `cargo build`. Everything the run creates lives in `.conductor/k/k2/` and is
# removed first. Screenshots are written to `docs/screenshots/`.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=18143
BASE="http://127.0.0.1:$PORT"
K="$ROOT/.conductor/k/k2"
DATA="$K/data"
DL="$K/downloads"
LOG="$K/server.log"
PID_FILE="$K/server.pid"
CHROME=${CHROME_PATH:-/usr/bin/google-chrome}

if [ ! -x "$CHROME" ]; then
  echo "FAIL: chrome not found at $CHROME (set CHROME_PATH)" >&2
  exit 1
fi

rm -rf "$K"
mkdir -p "$DATA" "$DL"
echo "PASS: cleaned $K"

if [ ! -d web/node_modules ]; then
  npm ci --prefix web
fi
npm run build --prefix web
echo "PASS: built web/dist"

cargo build --release -p loo-cli -p loo-server

# The download names are file names; there is no fallback to another platform.
cp "$ROOT/target/release/loo" "$DL/loo-linux-x64"
chmod 755 "$DL/loo-linux-x64"
echo "PASS: published target/release/loo as downloads/loo-linux-x64"

"$ROOT/target/release/loo-server" \
  --official \
  --addr "127.0.0.1:$PORT" \
  --tick-seconds 0.5 \
  --map maps/default.txt \
  --data-dir "$DATA" \
  --downloads-dir "$DL" \
  >"$LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >"$PID_FILE"

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

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

CHROME_PATH="$CHROME" BASE="$BASE" ROOT="$ROOT" LOO="$ROOT/target/release/loo" \
  node web/e2e/onboarding.mjs

echo "PASS: e2e-k completed"

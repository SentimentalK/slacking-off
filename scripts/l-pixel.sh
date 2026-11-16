#!/usr/bin/env bash
# Live-vs-replay pixel check for the 3D spectator: a dev server on 18135 with a
# one-second tick and three agents (two walking, one starting a wall), a vite dev
# server on 18136, then `web/scripts/l-pixel.mjs` compares the live canvas with
# the scene page drawn from `/api/projection` at the same tick.
#
# Everything the run creates lives in `.conductor/l/data-pixel` and is removed first.
# Results are written to `docs/screenshots/l/pixel*`.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=18135
VITE_PORT=18136
BASE="http://127.0.0.1:$PORT"
DATA="$ROOT/.conductor/l/data-pixel"
LOG="$DATA/server.log"
VITE_LOG="$DATA/vite.log"
SERVER="$ROOT/target/release/loo-server"
LOO="$ROOT/target/release/loo"

SERVER_PID=""
VITE_PID=""
listener_pid() {
  ss -ltnp "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n 1
}

cleanup() {
  if [ -n "$VITE_PID" ]; then
    VITE_LISTENER=$(listener_pid "$VITE_PORT")
    if [ -n "$VITE_LISTENER" ]; then
      kill "$VITE_LISTENER" 2>/dev/null || true
    fi
    kill "$VITE_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cargo build --release -p loo-server -p loo-cli

rm -rf "$DATA"
mkdir -p "$DATA"

"$SERVER" --dev --addr "127.0.0.1:$PORT" --map maps/default.txt \
  --tick-seconds 1 --data-dir "$DATA" >>"$LOG" 2>&1 &
SERVER_PID=$!

started=0
for _ in $(seq 1 100); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then
    started=1
    break
  fi
  sleep 0.1
done
if [ "$started" != 1 ]; then
  echo "FAIL: the dev server did not start (see $LOG)" >&2
  exit 1
fi

for name in a b c; do
  home="$DATA/home-$name"
  mkdir -p "$home"
  LOO_HOME="$home" "$LOO" --server "$BASE" register --name "pixel-$name" --model e2e --intro "pixel check" >>"$DATA/agents.log" 2>&1
  LOO_HOME="$home" "$LOO" --server "$BASE" join --sent-by self --why "pixel check" >>"$DATA/agents.log" 2>&1
done

LOO_HOME="$DATA/home-a" "$LOO" --server "$BASE" move NNEE >>"$DATA/agents.log" 2>&1 || true
LOO_HOME="$DATA/home-b" "$LOO" --server "$BASE" move EEEE >>"$DATA/agents.log" 2>&1 || true
LOO_HOME="$DATA/home-c" "$LOO" --server "$BASE" move EE >>"$DATA/agents.log" 2>&1 || true
LOO_HOME="$DATA/home-c" "$LOO" --server "$BASE" build wall e >>"$DATA/agents.log" 2>&1 || true

(cd web && LOO_API_URL="$BASE" npx vite --port "$VITE_PORT" --strictPort >"$VITE_LOG" 2>&1) &
VITE_PID=$!

vite_up=0
for _ in $(seq 1 200); do
  if curl -fsS "http://127.0.0.1:$VITE_PORT/" >/dev/null 2>&1; then
    vite_up=1
    break
  fi
  sleep 0.1
done
if [ "$vite_up" != 1 ]; then
  echo "FAIL: vite did not start (see $VITE_LOG)" >&2
  exit 1
fi

node web/scripts/l-pixel.mjs

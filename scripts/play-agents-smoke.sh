#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=18125
BASE="http://127.0.0.1:$PORT"
SMOKE="$ROOT/.conductor/m/play-smoke"
JAR="$SMOKE/cookies.txt"
PASSWORD="play-smoke-password-1"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

rm -rf "$SMOKE"
mkdir -p "$SMOKE/downloads" "$SMOKE/data"

cargo build --release -p loo-server -p loo-cli

cp "$ROOT/target/release/loo" "$SMOKE/downloads/loo-linux-x64"
chmod 755 "$SMOKE/downloads/loo-linux-x64"

"$ROOT/target/release/loo-server" --official --addr "127.0.0.1:$PORT" \
  --map "$ROOT/maps/default.txt" \
  --data-dir "$SMOKE/data" \
  --downloads-dir "$SMOKE/downloads" \
  >"$SMOKE/server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$SMOKE/server.pid"

ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 "$BASE/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: server did not answer /healthz within 30s; server.log tail:" >&2
  tail -n 30 "$SMOKE/server.log" >&2 || true
  exit 1
fi
echo "server up on $BASE (pid $SERVER_PID)"

curl -fsS -c "$JAR" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"smoke1\",\"password\":\"$PASSWORD\"}" \
  "$BASE/api/auth/register" >/dev/null

CSRF=$(awk '$6 == "loo_csrf" { print $7 }' "$JAR")
if [ -z "$CSRF" ]; then
  echo "FAIL: no loo_csrf cookie after register" >&2
  exit 1
fi

curl -fsS -b "$JAR" -c "$JAR" \
  -H "X-Loo-CSRF: $CSRF" \
  -X POST "$BASE/api/account/token" \
  | python3 -I -c '
import json, sys
token = json.load(sys.stdin)["result"]["token"]
if len(token) != 64:
    raise SystemExit("token is not 64 characters")
sys.stdout.write(token)
' > "$SMOKE/token.txt"
chmod 600 "$SMOKE/token.txt"
echo "account token written to $SMOKE/token.txt"

bash "$ROOT/scripts/play-agents.sh" \
  --server "$BASE" \
  --agents 2 \
  --minutes 3 \
  --token-file "$SMOKE/token.txt" \
  --out "$SMOKE/run"

if python3 -I - "$SMOKE/data/world.db" "$SMOKE/accepted.txt" <<'PY'
import sqlite3
import sys

con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=10)
rows = con.execute(
    "SELECT agent, COUNT(*) FROM commands WHERE ok=1 AND agent IS NOT NULL GROUP BY agent ORDER BY agent"
).fetchall()
with open(sys.argv[2], "w", encoding="utf-8") as out:
    for agent, count in rows:
        out.write(f"agent={agent} accepted={count}\n")
for agent, count in rows:
    print(f"agent={agent} accepted={count}")
sys.exit(0 if len(rows) >= 2 else 1)
PY
then
  echo "PASS: 2 agents each had accepted commands"
else
  echo "FAIL: fewer than 2 agents had accepted commands (see $SMOKE/accepted.txt)" >&2
  exit 1
fi

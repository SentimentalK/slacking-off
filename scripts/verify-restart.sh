#!/usr/bin/env bash
# Kill -9 / restart verification for the dev world.
#
# Builds a world with three agents (one inside, two queued), waits six ticks,
# SIGKILLs the server, restarts it on the same data directory and then proves
# that (a) the tick did not move backwards, (b) the queue came back with the
# same ids, cells and indices, and (c) every tick from 0 to the restored tick
# still replays through `GET /api/projection?tick=N` without a gap.
#
# Usage:
#   scripts/verify-restart.sh [--port 18088] [--data-dir .conductor/restart/data]
#     [--bin target/release/loo-server]
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=18088
DATA=".conductor/restart/data"
BIN="target/release/loo-server"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=${2:?missing value for --port}; shift 2 ;;
    --port=*) PORT=${1#*=}; shift ;;
    --data-dir) DATA=${2:?missing value for --data-dir}; shift 2 ;;
    --data-dir=*) DATA=${1#*=}; shift ;;
    --bin) BIN=${2:?missing value for --bin}; shift 2 ;;
    --bin=*) BIN=${1#*=}; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "FAIL: unknown argument $1" >&2; exit 2 ;;
  esac
done

DIR=".conductor/restart"
CONFIG="$DIR/config.json"
PRE="$DIR/pre.json"
POST="$DIR/post.json"
TICK_JSON="$DIR/projection-tick.json"
LOG="$DIR/server.log"
PIDFILE="$DIR/server.pid"
BASE="http://127.0.0.1:$PORT"
START_TICK=0
PRE_TICK=0
PID=""

if [ ! -x "$BIN" ]; then
  echo "FAIL: $BIN is not executable; run cargo build --release -p loo-server" >&2
  exit 2
fi

mkdir -p "$DIR" "$DATA"
rm -f "$PRE" "$POST" "$TICK_JSON"
printf '%s\n' '{"max_on_field":1,"tick_seconds":0.5,"session":{"queue_idle_seconds":600}}' > "$CONFIG"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

jget() { # jget <dotted.path> < file.json
  node -e '
    const fs = require("fs");
    let value = JSON.parse(fs.readFileSync(0, "utf8"));
    for (const key of (process.argv[1] || "").split(".")) {
      if (!key) continue;
      value = value == null ? value : value[key];
    }
    if (value === undefined || value === null) process.stdout.write("");
    else if (typeof value === "object") process.stdout.write(JSON.stringify(value));
    else process.stdout.write(String(value));
  ' "$1"
}

stop_server() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    PID=""
  fi
}
trap stop_server EXIT

start_server() {
  "$BIN" --dev --addr "127.0.0.1:$PORT" --config "$CONFIG" --data-dir "$DATA" >> "$LOG" 2>&1 &
  PID=$!
  echo "$PID" > "$PIDFILE"
  for _ in $(seq 1 300); do
    if curl -fsS --max-time 1 "$BASE/healthz" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
      return 1
    fi
    sleep 0.1
  done
  return 1
}

current_tick() {
  curl -fsS --max-time 2 "$BASE/api/metrics" | jget result.tick
}

register_agent() { # register_agent <name> -> token on stdout
  local name=$1 body
  body=$(curl -fsS --max-time 10 -H 'content-type: application/json' \
    -d "{\"name\":\"$name\",\"model\":\"restart-check\"}" \
    "$BASE/api/dev/register") || return 1
  printf '%s' "$body" | jget result.token
}

join_agent() { # join_agent <token> -> placement kind on stdout
  local token=$1 body kind
  body=$(curl -fsS --max-time 10 -H 'content-type: application/json' \
    -d '{"sent_by":"self","why":"restart verification run"}' \
    "$BASE/api/join" -H "authorization: Bearer $token") || return 1
  kind=$(printf '%s' "$body" | node -e '
    const fs = require("fs");
    const env = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!env.ok) {
      process.stderr.write(`join rejected: ${env.error?.code} ${env.error?.message}\n`);
      process.exit(1);
    }
    const p = env.result.placement;
    process.stdout.write(p.Inside ? "inside" : p.Waiting ? "waiting" : "none");
  ') || return 1
  printf '%s' "$kind"
}

auth_header() {
  printf 'authorization: Bearer %s' "$1"
}

echo "verify-restart: config $CONFIG"
start_server || fail "server did not answer /healthz on $BASE (see $LOG)"
echo "PASS: dev server up on $BASE (pid $PID)"

T0=$(register_agent restart-a) || fail "registering restart-a failed"
T1=$(register_agent restart-b) || fail "registering restart-b failed"
T2=$(register_agent restart-c) || fail "registering restart-c failed"
[ -n "$T0" ] && [ -n "$T1" ] && [ -n "$T2" ] || fail "dev_register returned no token"

P0=$(join_agent "$T0") || fail "join for restart-a failed"
P1=$(join_agent "$T1") || fail "join for restart-b failed"
P2=$(join_agent "$T2") || fail "join for restart-c failed"
[ "$P0" = "inside" ] || fail "restart-a expected inside, got $P0"
[ "$P1" = "waiting" ] || fail "restart-b expected waiting, got $P1"
[ "$P2" = "waiting" ] || fail "restart-c expected waiting, got $P2"
echo "PASS: 1 inside (restart-a), 2 waiting (restart-b, restart-c)"

START_TICK=$(current_tick)
[ -n "$START_TICK" ] || fail "metrics returned no tick"

deadline=$((SECONDS + 60))
while :; do
  now=$(current_tick)
  if [ $((now - START_TICK)) -ge 6 ]; then
    echo "PASS: waited 6 ticks ($START_TICK -> $now, tick_seconds=0.5)"
    break
  fi
  [ "$SECONDS" -lt "$deadline" ] || fail "the world did not settle six ticks within 60s (at $now)"
  sleep 0.2
done

curl -fsS --max-time 5 "$BASE/api/projection" > "$PRE" || fail "reading the pre projection failed"
PRE_TICK=$(jget result.tick < "$PRE")
PRE_QUEUE=$(jget result.queue.length < "$PRE")
PRE_COUNTS=$(jget result.counts < "$PRE")
echo "PASS: pre tick=$PRE_TICK queue=$PRE_QUEUE counts=$PRE_COUNTS"

kill -9 "$PID"
wait "$PID" 2>/dev/null || true
if kill -0 "$PID" 2>/dev/null; then
  fail "the server survived SIGKILL"
fi
PID=""
echo "PASS: server killed with SIGKILL"

start_server || fail "server did not come back on the same data dir (see $LOG)"
echo "PASS: server restarted on $DATA (pid $PID)"

curl -fsS --max-time 5 "$BASE/api/projection" > "$POST" || fail "reading the post projection failed"
POST_TICK=$(jget result.tick < "$POST")
[ -n "$POST_TICK" ] || fail "the post projection has no tick"
[ "$POST_TICK" -ge "$PRE_TICK" ] || fail "tick went backwards: pre=$PRE_TICK post=$POST_TICK"
echo "PASS: post tick=$POST_TICK >= pre tick=$PRE_TICK"

if node --input-type=module - "$PRE" "$POST" <<'EOF'
import { readFileSync } from "node:fs";

const [prePath, postPath] = process.argv.slice(2);
const pre = JSON.parse(readFileSync(prePath, "utf8")).result;
const post = JSON.parse(readFileSync(postPath, "utf8")).result;
const describe = (entry) => `${entry.id}@${entry.pos.x},${entry.pos.y}#${entry.index}`;

if (pre.queue.length === 0) {
  console.error("FAIL: the pre projection had an empty queue");
  process.exit(1);
}

const sameList = (a, b) =>
  a.length === b.length &&
  a.every((entry, i) => entry.id === b[i].id && entry.pos.x === b[i].pos.x && entry.pos.y === b[i].pos.y && entry.index === b[i].index);

if (sameList(pre.queue, post.queue)) {
  console.log(`PASS: queue restored unchanged (${post.queue.map(describe).join(" ")})`);
  process.exit(0);
}

// A tick may have settled between the restart and the read: then the former
// head entered and everyone behind it moved up exactly one index.
const advanced = post.tick > pre.tick;
const headGone = post.queue.length === pre.queue.length - 1 &&
  pre.queue.every((entry, i) => i === 0 || post.queue[i - 1]?.id === entry.id);
const shifted = headGone && pre.queue.slice(1).every((entry, i) => {
  const after = post.queue[i];
  return after && after.pos.x === entry.pos.x && after.pos.y === entry.pos.y && after.index === entry.index - 1;
});

if (advanced && shifted) {
  console.log(`PASS: queue restored with the head entered (${post.queue.map(describe).join(" ")})`);
  process.exit(0);
}

console.error(`FAIL: queue mismatch`);
console.error(`  pre:  ${pre.queue.map(describe).join(" ")}`);
console.error(`  post: ${post.queue.map(describe).join(" ")}`);
process.exit(1);
EOF
then
  :
else
  fail "the queue did not come back the same (pre tick $PRE_TICK, post tick $POST_TICK)"
fi

total=0
for ((n = 0; n <= POST_TICK; n++)); do
  code=$(curl -s -o "$TICK_JSON" -w '%{http_code}' --max-time 10 "$BASE/api/projection?tick=$n")
  [ "$code" = "200" ] || fail "projection for tick $n answered HTTP $code"
  got=$(jget result.tick < "$TICK_JSON")
  [ "$got" = "$n" ] || fail "projection for tick $n came back as tick $got"
  total=$((total + 1))
done
echo "PASS: tick 0..=$POST_TICK projection restored (total $total ticks)"

post_counts=$(jget result.counts < "$POST")
echo "counts: $post_counts"

for token in "$T1" "$T2"; do
  status=$(curl -fsS --max-time 5 -H "$(auth_header "$token")" "$BASE/api/status") || fail "status failed after restart"
  nick=$(printf '%s' "$status" | jget state.nick)
  placement=$(printf '%s' "$status" | jget state.placement)
  ahead=$(printf '%s' "$status" | jget state.queue_ahead)
  echo "PASS: waiter $nick placement=$placement queue_ahead=$ahead"
done

echo "PASS: restart verification complete (pre tick $PRE_TICK, post tick $POST_TICK, $total ticks replayed)"

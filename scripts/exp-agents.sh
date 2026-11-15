#!/usr/bin/env bash
# PROJECT-126-I scarcity experiment harness: one dev server plus N real `omp`
# agents for a fixed wall time, one isolated group per configuration.
#
# Usage:
#   scripts/exp-agents.sh <a|b|c> <agents> <minutes>
#   scripts/exp-agents.sh b 12 30
#
# Groups (ports and files are fixed):
#   a  18121  .conductor/exp-i/group-a/bin/{loo-server,loo}
#             .conductor/exp-i/group-a/map/default.txt
#             .conductor/exp-i/group-a/config/config.json   (pre-provisioned)
#   b  18122  target/release/{loo-server,loo}  maps/default.txt
#   c  18123  target/release/{loo-server,loo}  maps/default.txt
#
# Every group writes under `.conductor/exp-i/group-<g>/`:
#   data/            server data dir (`world.db` plus its WAL)
#   data/events.jsonl, data/commands.jsonl
#                    the server-side logs, exported from `world.db` (the server
#                    persists SQLite; its old JSONL writer was replaced by
#                    `world.db` in 5eac5bf, so the harness materializes the two
#                    files the analysis reads from the server's own records)
#   server.log, load.log, metrics.log, meta.txt, smoke.txt, summary.txt
#   start-epoch.txt, end-epoch.txt
#   agent-<NN>/{cwd,home,sessions,run.log,exit.txt,prompt.txt}
#
# Exit codes: 0 the whole run completed, 2 bad arguments / missing group-a files
# / server did not start, 3 the two-agent smoke gate saw no command.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

OMP_MODEL="opencode-go/deepseek-v4.1-flash"
EXP="$ROOT/.conductor/exp-i"
SMOKE_SECONDS=60

fail2() {
  echo "FAIL: $*" >&2
  exit 2
}

[ $# -eq 3 ] || fail2 "usage: $0 <a|b|c> <agents 1..32> <minutes >= 1>"
GROUP=$1
AGENTS=$2
MINUTES=$3

case "$GROUP" in
  a) PORT=18121 ;;
  b) PORT=18122 ;;
  c) PORT=18123 ;;
  *) fail2 "group must be a, b or c (got '$GROUP')" ;;
esac
[[ "$AGENTS" =~ ^[0-9]+$ ]] || fail2 "agents must be an integer 1..32 (got '$AGENTS')"
[ "$AGENTS" -ge 1 ] && [ "$AGENTS" -le 32 ] || fail2 "agents must be 1..32 (got '$AGENTS')"
[[ "$MINUTES" =~ ^[0-9]+$ ]] || fail2 "minutes must be an integer >= 1 (got '$MINUTES')"
[ "$MINUTES" -ge 1 ] || fail2 "minutes must be >= 1 (got '$MINUTES')"

command -v omp >/dev/null 2>&1 || fail2 "omp is not on PATH; no agents can be launched"
command -v python3 >/dev/null 2>&1 || fail2 "python3 is not on PATH; smoke check and exports need it"
command -v curl >/dev/null 2>&1 || fail2 "curl is not on PATH; the /healthz probe needs it"

BASE="$EXP/group-$GROUP"
DATA="$BASE/data"
SERVER_LOG="$BASE/server.log"
PID_FILE="$BASE/server.pid"
START_FILE="$BASE/start-epoch.txt"
END_FILE="$BASE/end-epoch.txt"
META="$BASE/meta.txt"
SMOKE="$BASE/smoke.txt"
SUMMARY="$BASE/summary.txt"

CFG="$BASE/config.json"
MAP="$ROOT/maps/default.txt"

if [ "$GROUP" = "a" ]; then
  SERVER="$BASE/bin/loo-server"
  LOO="$BASE/bin/loo"
  MAP="$BASE/map/default.txt"
  CFG="$BASE/config/config.json"
  # The master pre-provisions these four; nothing here may create them.
  missing=()
  for path in "$SERVER" "$LOO" "$MAP" "$CFG"; do
    [ -e "$path" ] || missing+=("$path")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    for path in "${missing[@]}"; do
      echo "FAIL: group a is missing $path (pre-provisioned by the master)" >&2
    done
    exit 2
  fi
  [ -x "$SERVER" ] || fail2 "group a binary is not executable: $SERVER"
  [ -x "$LOO" ] || fail2 "group a CLI is not executable: $LOO"
else
  echo "building the current HEAD: cargo build --release -p loo-cli -p loo-server"
  cargo build --release -p loo-cli -p loo-server
  SERVER="$ROOT/target/release/loo-server"
  LOO="$ROOT/target/release/loo"
fi

# Step 3: wipe the run data, keep group a's pre-provisioned files and re-create
# the group's config.
rm -rf "$DATA" "$BASE"/agent-* "$BASE"/*.log
rm -f "$PID_FILE" "$START_FILE" "$END_FILE" "$META" "$SMOKE" "$SUMMARY"
mkdir -p "$BASE" "$DATA"
if [ "$GROUP" != "a" ]; then
  printf '{"tick_seconds": 5}\n' > "$CFG"
fi

# Step 4: record what this run is made of.
{
  echo "group=$GROUP"
  echo "port=$PORT"
  echo "agents=$AGENTS"
  echo "minutes=$MINUTES"
  echo "git_head=$(git rev-parse HEAD)"
  echo "nproc=$(nproc)"
  echo "free_m_header=$(free -m | sed -n '1p')"
  echo "free_m=$(free -m | sed -n '2p')"
  echo "date_utc=$(date -u +%FT%TZ)"
  echo "server_sha256=$(sha256sum "$SERVER" | cut -d' ' -f1)"
  echo "loo_sha256=$(sha256sum "$LOO" | cut -d' ' -f1)"
  echo "map_sha256=$(sha256sum "$MAP" | cut -d' ' -f1)"
  echo "config_sha256=$(sha256sum "$CFG" | cut -d' ' -f1)"
} > "$META"

LOADER_PID=""
SERVER_PID=""
PIDS=()

kill_server() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
}

cleanup() {
  local pid
  if [ "${#PIDS[@]}" -gt 0 ]; then
    for pid in "${PIDS[@]}"; do
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
    done
  fi
  if [ -n "$LOADER_PID" ]; then
    kill "$LOADER_PID" 2>/dev/null || true
  fi
  kill_server
}
trap cleanup EXIT

# Step 5: start the server and wait for /healthz.
nohup "$SERVER" --dev --addr "127.0.0.1:$PORT" --map "$MAP" --config "$CFG" \
  --tick-seconds 5 --seed 42 --data-dir "$DATA" > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

READY=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if [ "$READY" -ne 1 ]; then
  echo "FAIL: server did not answer /healthz within 30s; $SERVER_LOG tail:" >&2
  tail -n 30 "$SERVER_LOG" >&2 || true
  exit 2
fi
echo "server up on 127.0.0.1:$PORT (pid $SERVER_PID)"

# Step 6: machine samples every 30 seconds, for the whole run. Load and memory
# go to `load.log` as plain columns; the server's own tick settlement latency
# goes to `metrics.log` one JSON object per line.
(
  while :; do
    printf '%s %s %s\n' \
      "$(date +%s)" \
      "$(awk '{print $1}' /proc/loadavg)" \
      "$(awk '/^MemAvailable:/ {printf "%d", $2 / 1024}' /proc/meminfo)" >> "$BASE/load.log"
    curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/metrics" >> "$BASE/metrics.log" 2>/dev/null || true
    printf '\n' >> "$BASE/metrics.log"
    sleep 30
  done
) &
LOADER_PID=$!

# The server persists SQLite only; `world.db` is its event and command log.
# Materialize the two JSONL files the analysis reads from that log.
export_jsonl() {
  [ -f "$DATA/world.db" ] || return 0
  python3 - "$DATA" <<'PY'
import json
import os
import sqlite3
import sys

data = sys.argv[1]
con = sqlite3.connect(f"file:{os.path.join(data, 'world.db')}?mode=ro", uri=True, timeout=10)

def write(path, rows):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as out:
        for row in rows:
            out.write(row + "\n")
    os.replace(tmp, path)

write(
    os.path.join(data, "events.jsonl"),
    (payload for (payload,) in con.execute(
        "SELECT payload FROM events WHERE world_id = 1 ORDER BY id")),
)

def commands():
    query = ("SELECT ts_ms, tick, agent, command, ok, summary, duration_ms, intent "
             "FROM commands WHERE world_id = 1 ORDER BY id")
    for ts_ms, tick, agent, command, ok, summary, duration_ms, intent in con.execute(query):
        row = {
            "ts_ms": ts_ms,
            "tick": tick,
            "agent": agent,
            "command": command,
            "ok": bool(ok),
            "summary": summary,
            "duration_ms": duration_ms,
        }
        if intent is not None:
            try:
                row["intent"] = json.loads(intent)
            except json.JSONDecodeError:
                row["intent"] = intent
        yield json.dumps(row, separators=(",", ":"))

write(os.path.join(data, "commands.jsonl"), commands())
con.close()
PY
}

# Step 7: one isolated identity and cwd per agent.
for i in $(seq 1 "$AGENTS"); do
  nn=$(printf '%02d' "$i")
  dir="$BASE/agent-$nn"
  mkdir -p "$dir/cwd" "$dir/home" "$dir/sessions"
  {
    printf '用 loo 这个命令玩，先看 loo rules。\n'
    printf '\n'
    printf '环境信息（已配置好）：\n'
    printf -- '- loo 可执行文件：%s\n' "$LOO"
    printf -- '- LOO_HOME=%s\n' "$dir/home"
    printf -- '- LOO_SERVER=http://127.0.0.1:%s\n' "$PORT"
  } > "$dir/prompt.txt"
done

# Step 8: every agent is a real `omp` process with a hard wall time.
launch() {
  local nn="$1"
  local dir="$BASE/agent-$nn"
  (
    cd "$dir/cwd"
    export LOO_HOME="$dir/home"
    export LOO_SERVER="http://127.0.0.1:$PORT"
    export PATH="$(dirname "$LOO"):$PATH"
    rc=0
    timeout "$((MINUTES * 60))" omp --model "$OMP_MODEL" \
      --session-dir "$dir/sessions" -p "$(cat "$dir/prompt.txt")" \
      </dev/null >"$dir/run.log" 2>&1 || rc=$?
    echo "$rc" > "$dir/exit.txt"
  ) &
  PIDS+=("$!")
}

agent_id_of() {
  local home="$1"
  python3 - "$home/config.json" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        print(json.load(fh).get("agent_id") or "")
except (OSError, ValueError, AttributeError):
    print("")
PY
}

count_agent_commands() {
  local agent="$1"
  [ -n "$agent" ] || { echo 0; return; }
  if [ -s "$DATA/commands.jsonl" ]; then
    python3 - "$DATA/commands.jsonl" "$agent" <<'PY'
import json
import sys

count = 0
with open(sys.argv[1], encoding="utf-8") as fh:
    for line in fh:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if str(row.get("agent")) == sys.argv[2]:
            count += 1
print(count)
PY
  elif [ -f "$DATA/world.db" ]; then
    python3 - "$DATA/world.db" "$agent" <<'PY'
import sqlite3
import sys

con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=10)
print(con.execute(
    "SELECT count(*) FROM commands WHERE world_id = 1 AND agent = ?",
    (int(sys.argv[2]),),
).fetchone()[0])
PY
  else
    echo 0
  fi
}

wait_all() {
  local pid
  for pid in "${PIDS[@]}"; do
    wait "$pid" || true
  done
}

# Step 9: two-agent smoke gate before the rest of the fleet joins.
if [ "$AGENTS" -gt 2 ]; then
  date +%s > "$START_FILE"
  launch 01
  launch 02
  echo "smoke: agents 01 and 02 launched, waiting ${SMOKE_SECONDS}s"
  sleep "$SMOKE_SECONDS"
  export_jsonl
  smoke_ok=1
  {
    echo "smoke_start_epoch=$(cat "$START_FILE")"
    echo "smoke_wait_seconds=$SMOKE_SECONDS"
  } > "$SMOKE"
  for i in 1 2; do
    nn=$(printf '%02d' "$i")
    aid=$(agent_id_of "$BASE/agent-$nn/home")
    count=$(count_agent_commands "$aid")
    if [ -n "$aid" ] && [ "$count" -gt 0 ]; then
      echo "agent-$nn agent_id=$aid commands=$count PASS" >> "$SMOKE"
    else
      echo "agent-$nn agent_id=${aid:-none} commands=$count FAIL" >> "$SMOKE"
      smoke_ok=0
    fi
  done
  if [ "$smoke_ok" -ne 1 ]; then
    echo "smoke: FAIL, see $SMOKE (run.log tails below)" >&2
    tail -n 20 "$BASE"/agent-0*/run.log >&2 || true
    echo "smoke: FAIL" >> "$SMOKE"
    exit 3
  fi
  echo "smoke: PASS" >> "$SMOKE"
  echo "smoke: PASS, launching the remaining $((AGENTS - 2)) agents"
  for i in $(seq 3 "$AGENTS"); do
    launch "$(printf '%02d' "$i")"
  done
else
  date +%s > "$START_FILE"
  for i in $(seq 1 "$AGENTS"); do
    launch "$(printf '%02d' "$i")"
  done
fi

wait_all
END_EPOCH=$(date +%s)
echo "$END_EPOCH" > "$END_FILE"

# Step 10: stop the server, export its log, summarize.
kill_server
export_jsonl

WALL=$((END_EPOCH - $(cat "$START_FILE")))
commands_total=0
if [ -s "$DATA/commands.jsonl" ]; then
  commands_total=$(wc -l < "$DATA/commands.jsonl")
fi
events_total=0
if [ -s "$DATA/events.jsonl" ]; then
  events_total=$(wc -l < "$DATA/events.jsonl")
fi

{
  echo "group=$GROUP"
  echo "agents=$AGENTS"
  echo "wall_start_epoch=$(cat "$START_FILE")"
  echo "wall_end_epoch=$END_EPOCH"
  echo "wall_seconds=$WALL"
  echo "commands_total=$commands_total"
  echo "events_total=$events_total"
  for i in $(seq 1 "$AGENTS"); do
    nn=$(printf '%02d' "$i")
    dir="$BASE/agent-$nn"
    exit_code=$(cat "$dir/exit.txt" 2>/dev/null || echo "none")
    aid=$(agent_id_of "$dir/home")
    count=$(count_agent_commands "$aid")
    echo "agent-$nn exit=$exit_code agent_id=${aid:-none} commands=$count"
  done
} > "$SUMMARY"

echo "done: $SUMMARY"
cat "$SUMMARY"

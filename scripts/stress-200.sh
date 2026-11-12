#!/usr/bin/env bash
# 200-agent dev-mode stress run with an hourly wall clock and a raw report.
#
# Starts a dev server on its own data directory, samples VmRSS every ten
# seconds, drives `scripts/stress-200.mjs` for the full wall-clock duration and
# writes `.conductor/stress/stress-<timestamp>.{json,md}`. Nothing here touches
# official mode: the server is started with `--dev` and its own data dir.
#
# Usage:
#   scripts/stress-200.sh [--duration-seconds 3600] [--agents 200] [--port 18087]
#     [--tick-seconds 1] [--data-dir .conductor/stress/data-<UTC>]
#     [--bin target/release/loo-server]
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

DURATION=3600
AGENTS=200
PORT=18087
TICK=1
DATA=""
BIN="target/release/loo-server"

while [ $# -gt 0 ]; do
  case "$1" in
    --duration-seconds) DURATION=${2:?missing value for --duration-seconds}; shift 2 ;;
    --duration-seconds=*) DURATION=${1#*=}; shift ;;
    --agents) AGENTS=${2:?missing value for --agents}; shift 2 ;;
    --agents=*) AGENTS=${1#*=}; shift ;;
    --port) PORT=${2:?missing value for --port}; shift 2 ;;
    --port=*) PORT=${1#*=}; shift ;;
    --tick-seconds) TICK=${2:?missing value for --tick-seconds}; shift 2 ;;
    --tick-seconds=*) TICK=${1#*=}; shift ;;
    --data-dir) DATA=${2:?missing value for --data-dir}; shift 2 ;;
    --data-dir=*) DATA=${1#*=}; shift ;;
    --bin) BIN=${2:?missing value for --bin}; shift 2 ;;
    --bin=*) BIN=${1#*=}; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "FAIL: unknown argument $1" >&2; exit 2 ;;
  esac
done

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ -z "$DATA" ]; then
  DATA=".conductor/stress/data-$STAMP"
fi

STRESS_DIR=".conductor/stress"
mkdir -p "$STRESS_DIR" "$DATA"
CSV="$STRESS_DIR/rss-$STAMP.csv"
ALIVE="$STRESS_DIR/alive-$STAMP.csv"
LOG="$STRESS_DIR/server.log"
PIDFILE="$STRESS_DIR/server.pid"
SUMMARY="$STRESS_DIR/client-$STAMP.json"
METRICS="$STRESS_DIR/metrics-$STAMP.json"
REPORT_JSON="$STRESS_DIR/stress-$STAMP.json"
REPORT_MD="$STRESS_DIR/stress-$STAMP.md"
BASE="http://127.0.0.1:$PORT"

if [ ! -x "$BIN" ]; then
  echo "FAIL: $BIN is not executable; run cargo build --release -p loo-server" >&2
  exit 2
fi

PID=""
SAMPLER=""
cleanup() {
  if [ -n "$SAMPLER" ]; then
    kill "$SAMPLER" 2>/dev/null || true
    wait "$SAMPLER" 2>/dev/null || true
    SAMPLER=""
  fi
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
trap cleanup EXIT

: > "$LOG"
printf 'epoch,rss_kb,tick\n' > "$CSV"
printf 'epoch,alive\n' > "$ALIVE"

echo "stress-200: starting $BIN --dev on $BASE (tick=${TICK}s, agents=$AGENTS, duration=${DURATION}s, data=$DATA)"
"$BIN" --dev --addr "127.0.0.1:$PORT" --tick-seconds "$TICK" --data-dir "$DATA" >>"$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"

healthy=0
for _ in $(seq 1 300); do
  if curl -fsS --max-time 1 "$BASE/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if [ "$healthy" -ne 1 ]; then
  echo "FAIL: server did not answer /healthz within 30s (see $LOG)" >&2
  exit 1
fi

metric_tick() {
  curl -fsS --max-time 2 "$BASE/api/metrics" 2>/dev/null \
    | grep -o '"tick":[0-9]*' | head -1 | cut -d: -f2 || true
}

sample_once() {
  local tick rss alive
  tick=$(metric_tick)
  if kill -0 "$PID" 2>/dev/null; then
    alive=1
    rss=$(awk '/^VmRSS:/{print $2}' "/proc/$PID/status" 2>/dev/null || true)
  else
    alive=0
    rss=""
  fi
  printf '%s,%s,%s\n' "$(date +%s)" "${rss:-}" "${tick:-}" >> "$CSV"
  printf '%s,%s\n' "$(date +%s)" "$alive" >> "$ALIVE"
}

# First sample immediately, then every ten seconds while the driver runs.
sample_once
(
  while :; do
    sleep 10
    sample_once
  done
) &
SAMPLER=$!

NODE_STATUS=0
set +e
node scripts/stress-200.mjs --base "$BASE" --agents "$AGENTS" \
  --duration-seconds "$DURATION" --summary "$SUMMARY"
NODE_STATUS=$?
set -e

# Final sample before the server is stopped, so the last RSS value is current.
sample_once
kill "$SAMPLER" 2>/dev/null || true
wait "$SAMPLER" 2>/dev/null || true
SAMPLER=""

curl -fsS --max-time 5 "$BASE/api/metrics" > "$METRICS" 2>/dev/null || : > "$METRICS"

SERVER_ALIVE=0
if kill -0 "$PID" 2>/dev/null; then
  SERVER_ALIVE=1
fi

jget() { # jget <dotted.path> < file.json
  node -e '
    const fs = require("fs");
    let value;
    try { value = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(3); }
    for (const key of (process.argv[1] || "").split(".")) {
      if (!key) continue;
      value = value == null ? value : value[key];
    }
    if (value === undefined || value === null) process.stdout.write("");
    else if (typeof value === "object") process.stdout.write(JSON.stringify(value));
    else process.stdout.write(String(value));
  ' "$1"
}

num_or() { # num_or <value> <fallback>
  case "${1:-}" in
    ''|*[!0-9.eE+-]*) printf '%s' "$2" ;;
    *) printf '%s' "$1" ;;
  esac
}

ticks=$(num_or "$(jget result.ticks < "$METRICS" 2>/dev/null || true)" 0)
p50=$(num_or "$(jget result.settle_ms.p50 < "$METRICS" 2>/dev/null || true)" 0)
p99=$(num_or "$(jget result.settle_ms.p99 < "$METRICS" 2>/dev/null || true)" 0)
pmax=$(num_or "$(jget result.settle_ms.max < "$METRICS" 2>/dev/null || true)" 0)
inside=$(num_or "$(jget result.inside < "$METRICS" 2>/dev/null || true)" 0)
queued=$(num_or "$(jget result.queued < "$METRICS" 2>/dev/null || true)" 0)
joins_ok=$(num_or "$(jget counters.joins_ok < "$SUMMARY" 2>/dev/null || true)" 0)
joins_rejected=$(num_or "$(jget counters.joins_rejected < "$SUMMARY" 2>/dev/null || true)" 0)
joins_queue_full=$(num_or "$(jget counters.joins_queue_full < "$SUMMARY" 2>/dev/null || true)" 0)
requests=$(num_or "$(jget counters.requests < "$SUMMARY" 2>/dev/null || true)" 0)

read -r rss_first rss_last < <(
  awk -F, 'NR > 1 && $2 != "" { if (!seen) { first = $2; seen = 1 } last = $2 }
           END { printf "%s %s\n", (seen ? first : "0"), (seen ? last : "0") }' "$CSV"
)
rss_samples=$(awk -F, 'NR > 1 && $2 != "" { n++ } END { print n + 0 }' "$CSV")

rss_slope=$(awk -F, '
  NR > 1 && $2 != "" { n++; t[n] = $1; r[n] = $2 }
  END {
    if (n < 2) { print "0.000"; exit }
    cutoff = t[n] - 1800
    m = 0
    for (i = 1; i <= n; i++) if (t[i] >= cutoff) { m++; x[m] = t[i]; y[m] = r[i] }
    if (m < 2) { m = 0; for (i = 1; i <= n; i++) { m++; x[m] = t[i]; y[m] = r[i] } }
    sx = 0; sy = 0
    for (i = 1; i <= m; i++) { sx += x[i]; sy += y[i] }
    mx = sx / m; my = sy / m
    num = 0; den = 0
    for (i = 1; i <= m; i++) { dx = x[i] - mx; num += dx * (y[i] - my); den += dx * dx }
    if (den == 0) { print "0.000"; exit }
    printf "%.3f", num / den * 60
  }' "$CSV"
)

db_bytes=0
if [ -f "$DATA/world.db" ]; then
  db_bytes=$(stat -c %s "$DATA/world.db" 2>/dev/null || echo 0)
fi

crashes=0
crash_notes=()
if [ "$SERVER_ALIVE" -ne 1 ]; then
  crashes=$((crashes + 1))
  crash_notes+=("server exited before the run ended")
fi
if grep -q ',0$' "$ALIVE"; then
  crashes=$((crashes + 1))
  crash_notes+=("the ten-second sampler saw the server dead")
fi
if [ "$NODE_STATUS" -ne 0 ]; then
  crashes=$((crashes + 1))
  crash_notes+=("the node driver exited $NODE_STATUS")
fi
crash_text=""
if [ "${#crash_notes[@]}" -gt 0 ]; then
  crash_text="${crash_notes[*]}"
fi

fail=0
reasons=()
if [ "$crashes" -gt 0 ]; then
  fail=1
  reasons+=("crashes=$crashes (${crash_notes[*]:-see server.log})")
fi
if [ "$ticks" -eq 0 ]; then
  fail=1
  reasons+=("ticks=0: the world never settled a tick")
fi
if awk -v p="$p99" -v lim="$TICK" 'BEGIN { exit !(p + 0 >= lim * 1000) }'; then
  fail=1
  reasons+=("settle_ms.p99=$p99 >= tick_seconds*1000=$(awk -v t="$TICK" 'BEGIN { printf "%.0f", t * 1000 }')")
fi
if [ "$fail" -eq 0 ]; then
  verdict="PASS"
else
  verdict="FAIL: ${reasons[*]}"
fi

{
  printf '{\n'
  printf '  "started_at": "%s",\n' "$STARTED_AT"
  printf '  "duration_seconds": %s,\n' "$DURATION"
  printf '  "tick_seconds": %s,\n' "$TICK"
  printf '  "agents": %s,\n' "$AGENTS"
  printf '  "mode": "dev",\n'
  printf '  "data_dir": "%s",\n' "$DATA"
  printf '  "port": %s,\n' "$PORT"
  printf '  "ticks": %s,\n' "$ticks"
  printf '  "settle_ms": {"p50": %s, "p99": %s, "max": %s},\n' "$p50" "$p99" "$pmax"
  printf '  "rss_kb_first": %s,\n' "$rss_first"
  printf '  "rss_kb_last": %s,\n' "$rss_last"
  printf '  "rss_slope_kb_per_min": %s,\n' "$rss_slope"
  printf '  "crashes": %s,\n' "$crashes"
  printf '  "joins_ok": %s,\n' "$joins_ok"
  printf '  "joins_rejected": %s,\n' "$joins_rejected"
  printf '  "joins_queue_full": %s,\n' "$joins_queue_full"
  printf '  "requests": %s,\n' "$requests"
  printf '  "inside": %s,\n' "$inside"
  printf '  "queued": %s,\n' "$queued"
  printf '  "db_bytes": %s,\n' "$db_bytes"
  printf '  "pid": %s\n' "$PID"
  printf '}\n'
} > "$REPORT_JSON"

{
  printf '# 200-agent stress run — %s\n\n' "$STAMP"
  printf -- '- verdict: **%s**\n' "$verdict"
  printf -- '- mode=%s, data_dir=%s, port=%s, pid=%s\n' "dev" "$DATA" "$PORT" "$PID"
  printf -- '- started_at: %s, duration_seconds: %s, tick_seconds: %s, agents: %s\n' \
    "$STARTED_AT" "$DURATION" "$TICK" "$AGENTS"
  printf -- '- ticks: %s (server settle samples)\n' "$ticks"
  printf -- '- settle_ms: p50=%s, p99=%s, max=%s (limit p99 < %sms)\n' \
    "$p50" "$p99" "$pmax" "$(awk -v t="$TICK" 'BEGIN { printf "%.0f", t * 1000 }')"
  printf -- '- RSS: first=%s KB, last=%s KB, slope=%s KB/min over the last 30 min window (%s samples; the whole run when shorter)\n' \
    "$rss_first" "$rss_last" "$rss_slope" "$rss_samples"
  printf -- '- crashes: %s%s\n' "$crashes" "${crash_text:+ ($crash_text)}"
  printf -- '- joins: ok=%s, rejected=%s (queue_full=%s), requests=%s\n' \
    "$joins_ok" "$joins_rejected" "$joins_queue_full" "$requests"
  printf -- '- occupancy at end: inside=%s, queued=%s\n' "$inside" "$queued"
  printf -- '- db_bytes: %s (world.db)\n' "$db_bytes"
  printf -- '- server alive at end: %s, node exit: %s\n' "$SERVER_ALIVE" "$NODE_STATUS"
  printf '\n'
  printf -- 'official 数据未被写入（dev server + 独立 data dir）\n'
  if [ "$fail" -ne 0 ]; then
    printf '\nFAIL: %s\n' "${reasons[*]}"
  else
    printf '\nPASS: no crashes, ticks > 0, settle p99 below one tick.\n'
  fi
} > "$REPORT_MD"

echo "stress-200: $verdict"
echo "stress-200: report $REPORT_MD and $REPORT_JSON"

if [ "$fail" -ne 0 ]; then
  exit 1
fi

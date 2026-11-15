#!/usr/bin/env bash
# Web perf harness (contract-H §4). Usage:
#   scripts/perf.sh run --tag before|after   build, seed, measure, screenshots, report
#   scripts/perf.sh compare                  before vs after table
#   scripts/perf.sh cleanup                  kill our servers / seeds / Chrome on 18111-18114
# PERF_SKIP_BUILD=1 skips `npm run build` + `cargo build` (iteration only).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
export NODE_PATH="$ROOT/web/node_modules${NODE_PATH:+:$NODE_PATH}"
export DISPLAY="${DISPLAY:-:0}"

PORT_MAIN=18111
PORT_DEBUG=18112
PORT_VISUAL=18113
CHROME="${CHROME_PATH:-/usr/bin/google-chrome}"
BIN="$ROOT/target/release/loo-server"

# Dev-only config. deadline / queue-idle / idle-cleanup are pushed far past the
# measurement window so the 50 inside + 50 queued scripted agents are not
# retired mid-run; limits.requests_per_second keeps the production value (2).
# Nothing else in the rules is changed.
CONFIG_JSON='{"need":{"deadline_ticks_min":1000000,"deadline_ticks_max":1000000},"session":{"idle_cleanup_ticks":100000,"queue_idle_seconds":100000},"limits":{"requests_per_second":2}}'

SERVER_PID=""
SEED_PID=""

# ---------------------------------------------------------------- processes --
listener_pids() {
  # pids listening on TCP port $1
  ss -Hltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
}

kill_chrome() {
  # Only Chrome instances started by this harness (perf profiles / our debug ports).
  pkill -f "user-data-dir=$ROOT/.conductor/perf/chrome-" 2>/dev/null || true
  pkill -f "remote-debugging-port=1811[1-4]" 2>/dev/null || true
  local i
  for i in $(seq 1 50); do
    pgrep -f "user-data-dir=$ROOT/.conductor/perf/chrome-" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  pkill -9 -f "user-data-dir=$ROOT/.conductor/perf/chrome-" 2>/dev/null || true
}

kill_ports() {
  local p pid
  for p in 18111 18112 18113 18114; do
    for pid in $(listener_pids "$p"); do
      kill "$pid" 2>/dev/null || true
    done
  done
  sleep 0.3
  for p in 18111 18112 18113 18114; do
    for pid in $(listener_pids "$p"); do
      kill -9 "$pid" 2>/dev/null || true
    done
  done
}

stop_pid() {
  local pid=${1:-}
  [ -z "$pid" ] && return 0
  kill "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 100); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
}

stop_seed() {
  if [ -n "$SEED_PID" ]; then
    stop_pid "$SEED_PID"
    wait "$SEED_PID" 2>/dev/null || true
    SEED_PID=""
  fi
}

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    stop_pid "$SERVER_PID"
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

cleanup_all() {
  stop_seed
  stop_server
  kill_chrome
  kill_ports
}

on_exit() {
  local rc=$?
  trap - EXIT
  cleanup_all
  exit $rc
}

verify_clean() {
  local bad=0 p
  for p in 18111 18112 18113 18114; do
    if [ -n "$(listener_pids "$p")" ]; then
      echo "FAIL: port $p still has a listener" >&2
      ss -ltnp "sport = :$p" >&2 || true
      bad=1
    fi
  done
  if pgrep -f "user-data-dir=$ROOT/.conductor/perf/chrome-" >/dev/null 2>&1; then
    echo "FAIL: leftover perf Chrome processes" >&2
    bad=1
  fi
  if pgrep -f "$BIN --dev --addr 127.0.0.1:1811" >/dev/null 2>&1; then
    echo "FAIL: leftover loo-server" >&2
    bad=1
  fi
  if pgrep -f "scripts/perf/seed.mjs" >/dev/null 2>&1; then
    echo "FAIL: leftover seed.mjs" >&2
    bad=1
  fi
  return $bad
}

wait_health() {
  local base=$1 i
  for i in $(seq 1 300); do
    curl -fsS --max-time 1 "$base/healthz" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  echo "FAIL: $base/healthz not ready" >&2
  return 1
}

# ------------------------------------------------------------------ compare --
cmd_compare() {
  node "$ROOT/scripts/perf/compare.mjs"
}

# ---------------------------------------------------------------------- run --
cmd_run() {
  local TAG=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tag) TAG=${2:?}; shift 2 ;;
      --tag=*) TAG=${1#*=}; shift ;;
      *) echo "FAIL: unknown run arg $1" >&2; exit 2 ;;
    esac
  done
  if [ -z "$TAG" ]; then
    echo "FAIL: run requires --tag before|after" >&2
    exit 2
  fi
  if [ ! -x "$CHROME" ]; then
    echo "FAIL: Chrome not found at $CHROME" >&2
    exit 1
  fi

  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  local PERF="$ROOT/.conductor/perf/$TAG"
  local VIS="$ROOT/.conductor/perf/visual"
  local METRICS="$PERF/metrics.json"
  local OCC="$PERF/occupancy.json"
  local PARTIAL="$PERF/metrics-partial.json"
  local RUN_FAILED=0

  # clean slate: no stale servers / Chrome from earlier (possibly crashed) runs
  cleanup_all
  rm -rf "$PERF/raw" "$PERF/profiles" "$OCC" "$PARTIAL" "$METRICS" "$PERF/sse-raw.txt" "$VIS/variants-$TAG" "$VIS/variants-$TAG.json"
  rm -f "$ROOT"/docs/screenshots/perf-"$TAG"-*.png
  mkdir -p "$PERF/profiles" "$PERF/raw" "$ROOT/docs/screenshots" "$VIS"
  echo '{}' >"$PARTIAL"
  echo "$CONFIG_JSON" >"$PERF/config.json"

  if [ -z "${PERF_SKIP_BUILD:-}" ]; then
    echo "perf: building web..."
    (cd "$ROOT/web" && npm run build) || { echo "FAIL: npm run build" >&2; exit 1; }
    echo "perf: building loo-server (release)..."
    cargo build --release -p loo-server || { echo "FAIL: cargo build" >&2; exit 1; }
  fi

  node "$ROOT/scripts/perf/collect-machine.mjs" >"$PERF/machine.json"
  local CHROME_VER STARTED_AT
  CHROME_VER=$("$CHROME" --version 2>/dev/null || echo "unknown")
  STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local BASE="http://127.0.0.1:$PORT_MAIN"

  # run_scenario <name> <agents> <min_tick> <phases>
  run_scenario() {
    local name=$1 agents=$2 min_tick=$3 phases=$4
    local data="$PERF/data-$name"
    local want_inside=$agents want_queued=0
    if [ "$agents" -gt 50 ]; then
      want_inside=50
      want_queued=$((agents - 50))
    fi
    rm -rf "$data" "$PERF/ready-$name.json"
    mkdir -p "$data"

    echo "perf[$name]: start server on :$PORT_MAIN"
    MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}" "$BIN" --dev --addr "127.0.0.1:$PORT_MAIN" \
      --tick-seconds 1 --data-dir "$data" --config "$PERF/config.json" >"$PERF/server-$name.log" 2>&1 &
    SERVER_PID=$!
    wait_health "$BASE" || return 1

    if [ "$agents" -gt 0 ]; then
      echo "perf[$name]: seeding $agents agents (want inside=$want_inside queued=$want_queued)"
      node "$ROOT/scripts/perf/seed.mjs" --base "$BASE" --agents "$agents" \
        --ready-file "$PERF/ready-$name.json" >"$PERF/seed-$name.log" 2>&1 &
      SEED_PID=$!
      local i
      for i in $(seq 1 480); do
        [ -f "$PERF/ready-$name.json" ] && break
        if ! kill -0 "$SEED_PID" 2>/dev/null; then
          echo "FAIL[$name]: seed exited before the field was full" >&2
          tail -5 "$PERF/seed-$name.log" >&2 || true
          return 1
        fi
        sleep 0.5
      done
      [ -f "$PERF/ready-$name.json" ] || { echo "FAIL[$name]: seed never reached target" >&2; return 1; }
    fi
    if [ "$min_tick" -gt 0 ]; then
      node "$ROOT/scripts/perf/occupancy.mjs" --base "$BASE" --wait-tick "$min_tick" || return 1
    fi

    local rc=0
    node "$ROOT/scripts/perf/occupancy.mjs" --base "$BASE" --out "$OCC" --scenario "$name" --phase start \
      --want-inside "$want_inside" --want-queued "$want_queued" || { echo "FAIL[$name]: occupancy at measurement start" >&2; rc=1; }

    if [ "$rc" -eq 0 ]; then
      echo "perf[$name]: measuring phases=$phases"
      node "$ROOT/scripts/perf/measure.mjs" --tag "$TAG" --occupancy "$name" --base "$BASE" \
        --phases "$phases" --partial "$PARTIAL" --chrome-version "$CHROME_VER" || { echo "FAIL[$name]: measure reported failed phases" >&2; rc=1; }
    fi

    node "$ROOT/scripts/perf/occupancy.mjs" --base "$BASE" --out "$OCC" --scenario "$name" --phase end \
      --want-inside "$want_inside" --want-queued "$want_queued" || { echo "FAIL[$name]: occupancy at measurement end" >&2; rc=1; }

    stop_seed
    return $rc
  }

  run_scenario empty 0 0 "rafprobe,load,fps" || RUN_FAILED=1
  stop_seed; stop_server; kill_chrome
  run_scenario ten 10 5 "load,fps" || RUN_FAILED=1
  stop_seed; stop_server; kill_chrome

  local full_rc=0
  run_scenario full 100 40 "load,fps,drag,zoom,profile,scrub,sse" || full_rc=1
  [ "$full_rc" -eq 0 ] || RUN_FAILED=1

  # ---- visual fixture: stop the server cleanly so the data dir is consistent
  stop_seed; stop_server; kill_chrome
  if [ -d "$PERF/data-full" ]; then
    echo "perf: saving visual fixture..."
    tar -cf "$VIS/data.tar" -C "$PERF/data-full" .
    local TICK
    TICK=$(node -e "const p=JSON.parse(require('fs').readFileSync('$PARTIAL','utf8'));const s=p?.full?.scrub;process.stdout.write(JSON.stringify(s&&s.tick?[s.tick]:[]))")
    node "$ROOT/scripts/perf/write-visual-meta.mjs" --out "$VIS/meta.json" --tick-seconds 1 \
      --ticks "$TICK" --chrome-version "$CHROME_VER" --config "$PERF/config.json"
    echo "perf: visual screenshots (server :$PORT_VISUAL, Chrome debug :$PORT_DEBUG)..."
    node "$ROOT/scripts/perf/visual-screenshots.mjs" --tag "$TAG" --tar "$VIS/data.tar" --meta "$VIS/meta.json" \
      --port "$PORT_VISUAL" --debug-port "$PORT_DEBUG" --bin "$BIN" || { echo "FAIL: visual screenshots" >&2; RUN_FAILED=1; }
  else
    echo "FAIL: no full data dir for the visual fixture" >&2
    RUN_FAILED=1
  fi
  kill_chrome; kill_ports

  node "$ROOT/scripts/perf/finalize-metrics.mjs" --tag "$TAG" --partial "$PARTIAL" --machine "$PERF/machine.json" \
    --occupancy "$OCC" --chrome-version "$CHROME_VER" --started-at "$STARTED_AT" --out "$METRICS" || RUN_FAILED=1

  echo "perf: pixdiff self-check + determinism..."
  : >"$PERF/pixdiff-self.txt"
  local shot
  for shot in "$ROOT"/docs/screenshots/perf-"$TAG"-*.png; do
    [ -f "$shot" ] || { echo "FAIL: no screenshots for $TAG" >&2; RUN_FAILED=1; break; }
    node "$ROOT/scripts/perf/pixdiff.mjs" "$shot" "$shot" | tee -a "$PERF/pixdiff-self.txt" || RUN_FAILED=1
  done
  # layout-variant summary of the visual captures (see visual-screenshots.mjs)
  node -e '
    const fs=require("fs");
    const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const out=[];
    for (const [name,v] of Object.entries(r)) {
      out.push(`${name}: ${v.chosenCount}/${v.captures} fresh loads identical to the reference shot; ${v.variants.length} layout variant(s)`);
      for (const x of v.variants.slice(1)) out.push(`  variant x${x.count} (${x.file}) vs reference: ${x.pixdiffVsChosen}`);
    }
    fs.writeFileSync(process.argv[2], out.join("\n")+"\n");
  ' "$VIS/variants-$TAG.json" "$PERF/visual-determinism.txt" || RUN_FAILED=1
  cat "$PERF/visual-determinism.txt" || true

  echo "perf: writing docs/perf-report.md..."
  node "$ROOT/scripts/perf/write-report.mjs" --metrics "$METRICS" --tag "$TAG" || RUN_FAILED=1

  cleanup_all
  verify_clean || RUN_FAILED=1

  if [ "$RUN_FAILED" -ne 0 ]; then
    echo "FAIL: perf run --tag $TAG had failures (see above)" >&2
    exit 1
  fi
  echo "PASS: perf run --tag $TAG completed -> $METRICS"
}

main() {
  if [ $# -lt 1 ]; then
    echo "Usage: scripts/perf.sh run --tag before|after | compare | cleanup" >&2
    exit 2
  fi
  case "$1" in
    run) shift; cmd_run "$@" ;;
    compare) shift; cmd_compare "$@" ;;
    cleanup) cleanup_all; verify_clean && echo "clean" ;;
    *) echo "FAIL: unknown subcommand $1" >&2; exit 2 ;;
  esac
}

main "$@"

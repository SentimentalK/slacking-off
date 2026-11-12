#!/usr/bin/env bash
# SSE acceptance for the public projection (contract §2).
#
# Starts a dev server on 127.0.0.1:18085 with a 0.2 s tick, proves `/api/watch`
# sends `hello` first and at least one `tick`, proves the SSE payload equals
# `/api/projection?tick=`, reconnects with `Last-Event-ID` (ids increase, never
# repeat), and proves a future tick is an error envelope.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=18085
BASE="http://127.0.0.1:$PORT"
OUT="$ROOT/.conductor/e2-sse"
BIN="$ROOT/target/debug/loo-server"
LOG="$OUT/server.log"

fail() {
    echo "FAIL: $*" >&2
    if [ -f "$LOG" ]; then
        echo "--- server log ---" >&2
        tail -20 "$LOG" >&2
    fi
    exit 1
}

rm -rf "$OUT"
mkdir -p "$OUT"

cargo build -q -p loo-server --bin loo-server

"$BIN" --dev --addr "127.0.0.1:$PORT" --map maps/default.txt \
    --tick-seconds 0.2 --data-dir "$OUT" >"$LOG" 2>&1 &
pid=$!
cleanup() {
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
}
trap cleanup EXIT

started=0
for _ in $(seq 1 100); do
    if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then
        started=1
        break
    fi
    sleep 0.1
done
[ "$started" = 1 ] || fail "the dev server did not start"
echo "PASS: dev server is up on $BASE"

# Parse SSE records (blank-line separated) into "id<TAB>data" for tick events.
parse_ticks() {
    awk 'BEGIN { RS = ""; FS = "\n" }
        /event: tick/ {
            id = ""; data = "";
            for (i = 1; i <= NF; i++) {
                if ($i ~ /^id: /) id = substr($i, 5);
                else if ($i ~ /^data: /) data = substr($i, 7);
            }
            if (id != "") print id "\t" data;
        }' "$1"
}

# --- first connection: hello, then live ticks --------------------------------
curl -sN --max-time 4 "$BASE/api/watch" >"$OUT/watch1.txt" || true
grep -q '^event: hello' "$OUT/watch1.txt" || fail "the first frame was not 'event: hello'"
head -3 "$OUT/watch1.txt" | grep -q '^retry: 3000' || fail "missing 'retry: 3000'"
echo "PASS: first frame is hello (with retry: 3000)"

parse_ticks "$OUT/watch1.txt" >"$OUT/ticks1.tsv"
count=$(wc -l <"$OUT/ticks1.tsv")
[ "$count" -ge 1 ] || fail "the stream sent no tick event"

awk -F'\t' '
    BEGIN { prev = -1 }
    { if ($1 <= prev) { print "non-increasing id " $1; exit 1 } prev = $1 }
' "$OUT/ticks1.tsv" || fail "tick ids are not strictly increasing"
echo "PASS: live stream sent $count tick events with increasing ids"

# --- SSE payload equals /api/projection?tick= --------------------------------
tick=$(head -1 "$OUT/ticks1.tsv" | cut -f1)
sse_data=$(head -1 "$OUT/ticks1.tsv" | cut -f2-)
sse_sorted=$(printf '%s' "$sse_data" | jq -S .)
api_sorted=$(curl -fsS "$BASE/api/projection?tick=$tick" | jq -S '.result')
[ "$sse_sorted" = "$api_sorted" ] || fail "SSE tick $tick differs from /api/projection?tick=$tick"
echo "PASS: SSE tick $tick equals /api/projection?tick=$tick"

# --- Last-Event-ID replay ----------------------------------------------------
last=$(tail -1 "$OUT/ticks1.tsv" | cut -f1)
curl -sN --max-time 2 -H "Last-Event-ID: $last" "$BASE/api/watch" >"$OUT/watch2.txt" || true
grep -q '^event: hello' "$OUT/watch2.txt" || fail "the reconnect did not start with hello"
parse_ticks "$OUT/watch2.txt" >"$OUT/ticks2.tsv"
count2=$(wc -l <"$OUT/ticks2.tsv")
[ "$count2" -ge 1 ] || fail "the reconnect sent no tick event"
first2=$(head -1 "$OUT/ticks2.tsv" | cut -f1)
[ "$first2" -gt "$last" ] || fail "replay started at $first2, not after Last-Event-ID $last"
awk -F'\t' '
    BEGIN { prev = -1 }
    { if (seen[$1]++) { print "duplicate id " $1; exit 1 }
      if ($1 <= prev) { print "non-increasing id " $1; exit 1 }
      prev = $1 }
' "$OUT/ticks2.tsv" || fail "replayed ids repeat or decrease"
echo "PASS: Last-Event-ID $last replayed from $first2 with no duplicates"

# --- a future tick is an error envelope, not a panic -------------------------
current=$(curl -fsS "$BASE/api/projection" | jq -r '.result.tick')
future=$((current + 1000))
future_body=$(curl -sS "$BASE/api/projection?tick=$future")
future_ok=$(printf '%s' "$future_body" | jq -r '.ok')
future_code=$(printf '%s' "$future_body" | jq -r '.error.code')
[ "$future_ok" = "false" ] || fail "tick $future was accepted"
[ "$future_code" = "bad_request" ] || fail "tick $future returned code '$future_code'"
echo "PASS: future tick $future returned an error envelope"

echo "PASS: SSE projection checks complete"

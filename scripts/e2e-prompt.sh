#!/usr/bin/env bash
# End-to-end check of the optional prompt line (port 18142).
#
# The install option `--prompt-file <path>` is off by default. When given, the
# install appends one neutral line to that agent instruction file, the flag is
# recorded on the account, and `/api/stats?prompt=on|off` splits the numbers by
# it. Without the option no instruction file is touched at all. Every successful
# step prints `PASS: ...`.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=18142
BASE="http://127.0.0.1:$PORT"
WORK="$ROOT/.conductor/k/k4"
DATA="$WORK/data"
DL="$WORK/downloads"
HOMES="$WORK/homes"
BIN="$WORK/bin"
LOG="$WORK/server.log"
LINE='- 本机装了 loo（Company Time）：想玩的时候可以玩。'
PASSWORD='k4-password'

rm -rf "$WORK"
mkdir -p "$DATA" "$DL" "$HOMES/a" "$HOMES/b" "$HOMES/c" "$BIN"

PASS() { echo "PASS: $*"; }
FAIL() {
  echo "FAIL: $*" >&2
  exit 1
}

cargo build --release -p loo-cli -p loo-server
cp "$ROOT/target/release/loo" "$DL/loo-linux-x64"
chmod 755 "$DL/loo-linux-x64"
PASS "release build published as downloads/loo-linux-x64"

"$ROOT/target/release/loo-server" \
  --official \
  --addr "127.0.0.1:$PORT" \
  --tick-seconds 0.2 \
  --map maps/default.txt \
  --data-dir "$DATA" \
  --downloads-dir "$DL" \
  >"$LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
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
PASS "official server is up on $BASE"

# One account per home: the cookie session issues the CLI token, exactly as the
# account page does.
account_token() {
  local name=$1
  local jar="$WORK/$name.jar"
  curl -fsS -c "$jar" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$name\",\"password\":\"$PASSWORD\"}" \
    "$BASE/api/auth/register" >"$WORK/$name-register.json"
  local csrf
  csrf=$(awk '$6 == "loo_csrf" { print $7 }' "$jar")
  [ -n "$csrf" ] || FAIL "no loo_csrf cookie after registering $name"
  curl -fsS -b "$jar" -c "$jar" \
    -H "X-Loo-CSRF: $csrf" \
    -X POST "$BASE/api/account/token" >"$WORK/$name-token.json"
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"]["token"])' \
    "$WORK/$name-token.json"
}

TOKEN_A=$(account_token k4-a)
TOKEN_C=$(account_token k4-c)
[ "${#TOKEN_A}" -eq 64 ] || FAIL "token for k4-a is not 64 bytes"
PASS "two accounts registered and their tokens issued"

# The installer is the file the server serves; run it from the tree so the
# served bytes are exactly what is checked.
install_for() {
  local home=$1
  local token=$2
  shift 2
  LOO_HOME="$home" LOO_BIN_DIR="$BIN" \
    sh "$ROOT/crates/server/static/install.sh" --server "$BASE" --token "$token" "$@"
}

count_line() { grep -cF -- "$LINE" "$1" || true; }

# --- 1. install with the option appends the line once -----------------------
printf '# AGENTS\n- 已有规则\n' >"$WORK/agents-a.md"
install_for "$HOMES/a" "$TOKEN_A" --prompt-file "$WORK/agents-a.md" >"$WORK/install-a.log" 2>&1
[ "$(tail -n 1 "$WORK/agents-a.md")" = "$LINE" ] ||
  FAIL "the last line is not the prompt line: $(tail -n 1 "$WORK/agents-a.md")"
COUNT=$(count_line "$WORK/agents-a.md")
[ "$COUNT" = "1" ] || FAIL "the prompt line appears $COUNT times, expected 1"
grep -qF -- '- 已有规则' "$WORK/agents-a.md" || FAIL "the existing rule was lost"
PASS "install --prompt-file appended the line once and kept the existing rule"

# --- 2. the same install again is idempotent --------------------------------
install_for "$HOMES/a" "$TOKEN_A" --prompt-file "$WORK/agents-a.md" >"$WORK/install-a2.log" 2>&1
COUNT=$(count_line "$WORK/agents-a.md")
[ "$COUNT" = "1" ] || FAIL "after the second install the line appears $COUNT times, expected 1"
PASS "a second install with --prompt-file leaves the line count at 1"

# --- 3. one command removes it ----------------------------------------------
LOO_HOME="$HOMES/a" "$BIN/loo" prompt off >"$WORK/prompt-off.log"
COUNT=$(count_line "$WORK/agents-a.md")
[ "$COUNT" = "0" ] || FAIL "after prompt off the line appears $COUNT times, expected 0"
grep -qF -- '- 已有规则' "$WORK/agents-a.md" || FAIL "prompt off lost the existing rule"
STATUS=$(LOO_HOME="$HOMES/a" "$BIN/loo" prompt status)
[ "$STATUS" = "prompt: off" ] || FAIL "prompt status prints $STATUS, expected prompt: off"
PASS "prompt off removed only the prompt line and status reports off"

# --- 4. an install without the option never touches the file ----------------
printf '# AGENTS\n- 已有规则\n' >"$WORK/agents-c.md"
BEFORE=$(sha256sum "$WORK/agents-c.md" | cut -d' ' -f1)
install_for "$HOMES/c" "$TOKEN_C" >"$WORK/install-c.log" 2>&1
AFTER=$(sha256sum "$WORK/agents-c.md" | cut -d' ' -f1)
[ "$BEFORE" = "$AFTER" ] || FAIL "an install without --prompt-file changed the file ($BEFORE -> $AFTER)"
STATUS=$(LOO_HOME="$HOMES/c" "$BIN/loo" prompt status)
[ "$STATUS" = "prompt: off" ] || FAIL "prompt status prints $STATUS, expected prompt: off"
PASS "an install without --prompt-file leaves the file byte-identical"

# --- 5. a missing file in an existing directory is created ------------------
[ -e "$WORK/AGENTS-new.md" ] && rm -f "$WORK/AGENTS-new.md"
install_for "$HOMES/b" "$TOKEN_A" --prompt-file "$WORK/AGENTS-new.md" >"$WORK/install-b.log" 2>&1
[ -f "$WORK/AGENTS-new.md" ] || FAIL "--prompt-file did not create $WORK/AGENTS-new.md"
[ "$(cat "$WORK/AGENTS-new.md")" = "$LINE" ] ||
  FAIL "the created file is not exactly the prompt line: $(cat "$WORK/AGENTS-new.md")"
COUNT=$(count_line "$WORK/AGENTS-new.md")
[ "$COUNT" = "1" ] || FAIL "the created file has $COUNT prompt lines, expected 1"
PASS "--prompt-file created a missing file holding exactly the one line"

# --- 6. a missing directory fails loudly and installs anyway -----------------
set +e
install_for "$HOMES/b" "$TOKEN_A" --prompt-file "$WORK/no-such-dir/AGENTS.md" \
  >"$WORK/install-nodir.log" 2>&1
NODIR_CODE=$?
set -e
[ "$NODIR_CODE" = "0" ] || FAIL "the install exited $NODIR_CODE with a missing prompt directory, expected 0"
grep -qF 'prompt: skipped' "$WORK/install-nodir.log" ||
  FAIL "the install did not print prompt: skipped: $(cat "$WORK/install-nodir.log")"
[ ! -e "$WORK/no-such-dir/AGENTS.md" ] || FAIL "the missing directory path was created anyway"
PASS "a missing prompt directory prints prompt: skipped and the install still exits 0"

# --- 7. the stats split by the flag -----------------------------------------
install_for "$HOMES/a" "$TOKEN_A" --prompt-file "$WORK/agents-a.md" >"$WORK/install-a3.log" 2>&1
COUNT=$(count_line "$WORK/agents-a.md")
[ "$COUNT" = "1" ] || FAIL "the prompt line appears $COUNT times after re-installing, expected 1"

LOO_HOME="$HOMES/a" "$BIN/loo" register --name k4-a --model e2e --intro "test" >"$WORK/register-a.log"
sleep 0.5
LOO_HOME="$HOMES/a" "$BIN/loo" join --sent-by self --why "e2e" >"$WORK/join-a.log"
sleep 0.5
LOO_HOME="$HOMES/c" "$BIN/loo" register --name k4-c --model e2e --intro "test" >"$WORK/register-c.log"
sleep 0.5
LOO_HOME="$HOMES/c" "$BIN/loo" join --sent-by self --why "e2e" >"$WORK/join-c.log"
sleep 0.5

sessions() {
  curl -s "$BASE/api/stats?prompt=$1" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["all"]["total_sessions"])'
}

ON=$(sessions on)
OFF=$(sessions off)
ANY=$(sessions any)
[ "$ON" = "1" ] || FAIL "/api/stats?prompt=on reports $ON sessions, expected 1"
[ "$OFF" = "1" ] || FAIL "/api/stats?prompt=off reports $OFF sessions, expected 1"
[ "$ANY" = "2" ] || FAIL "/api/stats?prompt=any reports $ANY sessions, expected 2"
PASS "/api/stats splits 1 / 1 / 2 sessions by prompt=on|off|any"

PASS "e2e-prompt completed"

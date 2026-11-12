#!/usr/bin/env bash
# End-to-end account flow for the official server (contract §1).
#
# Registers an account, installs the CLI through the served installer, registers
# an agent, joins the world, attaches again, revokes the token and proves the CLI
# now fails with exit code 2. Every successful step prints `PASS: ...`.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=18085
BASE="http://127.0.0.1:$PORT"
E2E="$ROOT/.conductor/e1-e2e"
DATA="$E2E/data"
LOO_HOME_DIR="$E2E/home"
BIN_DIR="$E2E/bin"
JAR="$E2E/cookies.txt"
LOG="$E2E/server.log"

rm -rf "$E2E"
mkdir -p "$DATA" "$LOO_HOME_DIR" "$BIN_DIR"

echo "PASS: temporary directory $E2E"

cargo build --release -p loo-cli -p loo-server

"$ROOT/target/release/loo-server" \
  --official \
  --addr "127.0.0.1:$PORT" \
  --tick-seconds 0.2 \
  --downloads-dir target/release \
  --data-dir "$DATA" \
  --map maps/default.txt \
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
echo "PASS: official server is up on $BASE"

curl -fsS -c "$JAR" \
  -H 'Content-Type: application/json' \
  -d '{"username":"e2e-user","password":"password-123"}' \
  "$BASE/api/auth/register" >"$E2E/register.json"
jq -e '.ok == true and .result.username == "e2e-user"' "$E2E/register.json" >/dev/null
echo "PASS: account registered with a session cookie"

CSRF=$(awk '$6 == "loo_csrf" { print $7 }' "$JAR")
if [ -z "$CSRF" ]; then
  echo "FAIL: no loo_csrf cookie in the jar" >&2
  cat "$JAR" >&2
  exit 1
fi
echo "PASS: CSRF cookie is readable"

curl -fsS -b "$JAR" -c "$JAR" \
  -H "X-Loo-CSRF: $CSRF" \
  -X POST "$BASE/api/account/token" >"$E2E/token.json"
TOKEN=$(jq -r '.result.token' "$E2E/token.json")
SH_COMMAND=$(jq -r '.result.install.sh' "$E2E/token.json")
if [ "${#TOKEN}" -ne 64 ]; then
  echo "FAIL: token is not 64 hex characters" >&2
  exit 1
fi
echo "PASS: account token issued"

LOO_HOME="$LOO_HOME_DIR" LOO_BIN_DIR="$BIN_DIR" sh -c "$SH_COMMAND" >"$E2E/install.log" 2>&1
if grep -qF "$TOKEN" "$E2E/install.log"; then
  echo "FAIL: the installer printed the token" >&2
  exit 1
fi
if [ ! -x "$BIN_DIR/loo" ]; then
  echo "FAIL: installer did not place an executable at $BIN_DIR/loo" >&2
  exit 1
fi
jq -e --arg token "$TOKEN" '.token == $token and (.server | startswith("http://127.0.0.1"))' \
  "$LOO_HOME_DIR/config.json" >/dev/null
echo "PASS: install.sh downloaded the release binary and wrote the config"

export LOO_HOME="$LOO_HOME_DIR"
LOO="$BIN_DIR/loo"

"$LOO" register --name e2e-bot --model deepseek-v4 --intro "e2e" >"$E2E/register-agent.log"
grep -q "created e2e-bot" "$E2E/register-agent.log"
jq -e '.agent_id != null and .nick == "e2e-bot"' "$LOO_HOME_DIR/config.json" >/dev/null
echo "PASS: official register created the agent and saved the identity"

"$LOO" join --sent-by self --why "e2e run" >"$E2E/join.log"
echo "PASS: join succeeded with the official token and agent header"

"$LOO" register --name e2e-bot --model deepseek-v4 --intro "e2e again" >"$E2E/attach.log"
grep -q "attached e2e-bot" "$E2E/attach.log"
echo "PASS: registering the same nickname attached the existing agent"

HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' -d '{}' \
  -X POST "$BASE/api/dev/register")
if [ "$HTTP_STATUS" != "404" ]; then
  echo "FAIL: official /api/dev/register returned $HTTP_STATUS, expected 404" >&2
  exit 1
fi
echo "PASS: /api/dev/register is 404 in official mode"

curl -fsS -b "$JAR" \
  -H "X-Loo-CSRF: $CSRF" \
  -X POST "$BASE/api/account/token/revoke" >"$E2E/revoke.json"
jq -e '.ok == true' "$E2E/revoke.json" >/dev/null
echo "PASS: account token revoked"

set +e
"$LOO" status >"$E2E/status.log" 2>"$E2E/status.err"
STATUS_CODE=$?
set -e
if [ "$STATUS_CODE" -ne 2 ]; then
  echo "FAIL: loo status exited $STATUS_CODE after revocation, expected 2" >&2
  cat "$E2E/status.log" >&2
  cat "$E2E/status.err" >&2
  exit 1
fi
if ! grep -q "unknown or missing token" "$E2E/status.err"; then
  echo "FAIL: loo status did not explain the authentication failure on stderr" >&2
  cat "$E2E/status.err" >&2
  exit 1
fi
echo "PASS: revoked token exits 2 with a readable message"

echo "PASS: all e2e-auth checks completed"
exit 0

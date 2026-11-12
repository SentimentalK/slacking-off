#!/usr/bin/env bash
# End-to-end account flow for the official server (contract §1).
#
# Registers an account, installs the CLI through the served installer, registers
# an agent, joins the world, attaches again, revokes the token and proves the CLI
# now fails with exit code 2. It also checks that download names map to their own
# platform files and that the macOS install path fails cleanly. Every successful
# step prints `PASS: ...`.
#
# NOTE for Master: build outputs are published under their real platform names
# here. E-4's demo scripts must use the same convention (copy the release binary
# to <downloads_dir>/loo-<os>-<arch>), otherwise its install steps will 404.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=18085
BASE="http://127.0.0.1:$PORT"
E2E="$ROOT/.conductor/e1-e2e"
DATA="$E2E/data"
DOWNLOADS="$E2E/downloads"
LOO_HOME_DIR="$E2E/home"
BIN_DIR="$E2E/bin"
JAR="$E2E/cookies.txt"
LOG="$E2E/server.log"

rm -rf "$E2E"
mkdir -p "$DATA" "$DOWNLOADS" "$LOO_HOME_DIR" "$BIN_DIR"

echo "PASS: temporary directory $E2E"

cargo build --release -p loo-cli -p loo-server

# The server maps every download name to a file of the same name (contract §1),
# so the build is published under the platform name it is meant for.
cp "$ROOT/target/release/loo" "$DOWNLOADS/loo-linux-x64"
chmod 755 "$DOWNLOADS/loo-linux-x64"
echo "PASS: published target/release/loo as downloads/loo-linux-x64"

"$ROOT/target/release/loo-server" \
  --official \
  --addr "127.0.0.1:$PORT" \
  --tick-seconds 0.2 \
  --downloads-dir "$DOWNLOADS" \
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

# Only loo-linux-x64 is published; other platform names must 404 with the
# documented body instead of falling back to the Linux binary.
for name in loo-linux-arm64 loo-macos-x64 loo-macos-arm64 loo-windows-x64.exe; do
  STATUS=$(curl -s -o "$E2E/download-$name.body" -w '%{http_code}' "$BASE/downloads/$name")
  if [ "$STATUS" != "404" ]; then
    echo "FAIL: /downloads/$name returned $STATUS, expected 404" >&2
    exit 1
  fi
  if [ "$(cat "$E2E/download-$name.body")" != "暂无构建" ]; then
    echo "FAIL: /downloads/$name body is not 暂无构建" >&2
    cat "$E2E/download-$name.body" >&2
    exit 1
  fi
done
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/downloads/loo-linux-x64")
if [ "$STATUS" != "200" ]; then
  echo "FAIL: /downloads/loo-linux-x64 returned $STATUS, expected 200" >&2
  exit 1
fi
echo "PASS: download names map to their own platform files with no fallback"

curl -fsS -c "$JAR" \
  -H 'Content-Type: application/json' \
  -d '{"username":"e2e-user","password":"password-123"}' \
  "$BASE/api/auth/register" >"$E2E/register.json"
jq -e '.ok == true and .result.username == "e2e-user"' "$E2E/register.json" >/dev/null
echo "PASS: account registered with a session cookie"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"username":"AB","password":"password-123"}' \
  "$BASE/api/auth/register")
if [ "$STATUS" != "400" ]; then
  echo "FAIL: invalid username returned $STATUS, expected 400" >&2
  exit 1
fi
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"username":"e2e-user","password":"password-123"}' \
  "$BASE/api/auth/register")
if [ "$STATUS" != "409" ]; then
  echo "FAIL: duplicate username returned $STATUS, expected 409" >&2
  exit 1
fi
echo "PASS: registration answers 400 for a bad username and 409 for a duplicate"

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

# A uname shim makes install.sh believe it runs on macOS. Nothing is published
# for that platform, so it must fail without writing a config or a binary.
SHIM="$E2E/shim"
DARWIN_HOME="$E2E/darwin-home"
DARWIN_BIN="$E2E/darwin-bin"
mkdir -p "$SHIM"
cat >"$SHIM/uname" <<'SHIM_EOF'
#!/bin/sh
case "$1" in
  -s) echo Darwin ;;
  -m) echo x86_64 ;;
  *) echo Darwin ;;
esac
SHIM_EOF
chmod +x "$SHIM/uname"

set +e
PATH="$SHIM:$PATH" LOO_HOME="$DARWIN_HOME" LOO_BIN_DIR="$DARWIN_BIN" \
  sh -c "$SH_COMMAND" >"$E2E/darwin-install.log" 2>"$E2E/darwin-install.err"
DARWIN_CODE=$?
set -e
if [ "$DARWIN_CODE" -eq 0 ]; then
  echo "FAIL: install.sh succeeded on a simulated macOS host" >&2
  cat "$E2E/darwin-install.log" >&2
  exit 1
fi
if ! grep -q "loo-macos-x64" "$E2E/darwin-install.err"; then
  echo "FAIL: the macOS install did not request loo-macos-x64" >&2
  cat "$E2E/darwin-install.err" >&2
  exit 1
fi
if [ -f "$DARWIN_HOME/config.json" ]; then
  echo "FAIL: the failed macOS install wrote a config" >&2
  exit 1
fi
if [ -e "$DARWIN_BIN/loo" ]; then
  echo "FAIL: the failed macOS install left a binary" >&2
  exit 1
fi
echo "PASS: macOS install requests loo-macos-x64 and fails without config or binary"

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

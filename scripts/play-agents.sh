#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OMP_MODEL="opencode-go/deepseek-v4.1-flash"

usage() {
  cat <<'EOF'
usage: play-agents.sh --server <URL> --agents <N> --minutes <M> [--token-file <file>]... [--home <dir>]... [--name-prefix <p>] [--out <dir>] [--loo <path>]
EOF
}

fail() {
  echo "FAIL: $*" >&2
  exit 2
}

abs() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$PWD" "$1" ;;
  esac
}

is_uint() {
  [[ $1 =~ ^[0-9]+$ ]]
}

SERVER=""
AGENTS=""
MINUTES=""
PREFIX="ai"
OUT=""
LOO_SRC=""
TOKEN_FILES=()
HOMES=()

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --server|--agents|--minutes|--token-file|--home|--name-prefix|--out|--loo)
      [ $# -ge 2 ] || { usage >&2; fail "$1 needs a value"; }
      case "$1" in
        --server) SERVER=$2 ;;
        --agents) AGENTS=$2 ;;
        --minutes) MINUTES=$2 ;;
        --token-file) TOKEN_FILES+=("$(abs "$2")") ;;
        --home) HOMES+=("$(abs "$2")") ;;
        --name-prefix) PREFIX=$2 ;;
        --out) OUT=$(abs "$2") ;;
        --loo) LOO_SRC=$(abs "$2") ;;
      esac
      shift 2
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
done

[ -n "$SERVER" ] || fail "--server is required"
while [ "${SERVER%/}" != "$SERVER" ]; do
  SERVER=${SERVER%/}
done
is_uint "$AGENTS" && [ "$AGENTS" -ge 1 ] && [ "$AGENTS" -le 50 ] || fail "--agents must be an integer 1..50 (got '$AGENTS')"
is_uint "$MINUTES" && [ "$MINUTES" -ge 1 ] || fail "--minutes must be an integer >= 1 (got '$MINUTES')"
[[ $PREFIX =~ ^[a-z][a-z0-9-]{0,12}$ ]] || fail "--name-prefix must match ^[a-z][a-z0-9-]{0,12}\$ (got '$PREFIX')"

TOKENS=()
TOKEN_HOMES=()

for f in "${TOKEN_FILES[@]}"; do
  [ -r "$f" ] || fail "cannot read token file $f"
  tok=$(head -n 1 "$f" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ -n "$tok" ] || fail "token file $f has no token on its first line"
  TOKENS+=("$tok")
  TOKEN_HOMES+=("")
done

ENV_TOKENS=()
read -r -a ENV_TOKENS <<< "${LOO_PLAY_TOKENS:-}"
for tok in "${ENV_TOKENS[@]}"; do
  TOKENS+=("$tok")
  TOKEN_HOMES+=("")
done

for h in "${HOMES[@]}"; do
  cfg="$h/config.json"
  [ -f "$cfg" ] || fail "--home $h has no config.json"
  tok=$(python3 -I -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    print(json.load(fh).get("token") or "")
' "$cfg") || fail "cannot read a token from $cfg"
  [ -n "$tok" ] || fail "$cfg has no token"
  TOKENS+=("$tok")
  TOKEN_HOMES+=("$h")
done

ACCOUNTS=${#TOKENS[@]}
[ "$ACCOUNTS" -ge 1 ] || fail "no account tokens: give --token-file, LOO_PLAY_TOKENS or --home"
if [ "$AGENTS" -gt $((ACCOUNTS * 5)) ]; then
  fail "$AGENTS agents need $(( (AGENTS + 4) / 5 )) accounts (ceil($AGENTS/5)), got $ACCOUNTS"
fi

if [ -z "$OUT" ]; then
  OUT="$ROOT/.conductor/play-agents/$(date -u +%Y%m%dT%H%M%SZ)"
fi
[ ! -e "$OUT" ] || fail "output directory already exists: $OUT"
mkdir -p "$OUT/bin"
OUT=$(cd "$OUT" && pwd)

if [ -n "$LOO_SRC" ]; then
  [ -f "$LOO_SRC" ] && [ -x "$LOO_SRC" ] || fail "--loo is not an executable file: $LOO_SRC"
  LOO_BIN="$LOO_SRC"
else
  LOO_BIN="$OUT/bin/loo"
  if ! curl -fsSL "$SERVER/downloads/loo-linux-x64" -o "$LOO_BIN"; then
    rm -f "$LOO_BIN"
    fail "cannot download $SERVER/downloads/loo-linux-x64"
  fi
  chmod 755 "$LOO_BIN"
fi
LOO_DIR=$(dirname "$LOO_BIN")
LOO_VERSION=$("$LOO_BIN" --version 2>&1) || fail "$LOO_BIN --version failed"

{
  echo "server=$SERVER"
  echo "agents=$AGENTS"
  echo "minutes=$MINUTES"
  echo "name_prefix=$PREFIX"
  echo "accounts=$ACCOUNTS"
  echo "loo_version=$LOO_VERSION"
  echo "started_utc=$(date -u +%FT%TZ)"
} > "$OUT/meta.txt"

write_config() {
  python3 -I -c '
import json, os, sys
tok = sys.stdin.read().strip()
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump({"server": sys.argv[2], "token": tok}, fh)
    fh.write("\n")
' "$1" "$SERVER"
}

cfg_get() {
  python3 -I -c '
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        value = json.load(fh).get(sys.argv[2])
except (OSError, ValueError, AttributeError):
    value = None
print(value if value not in (None, "") else "-")
' "$1" "$2"
}

count_loo_calls() {
  python3 -I -c '
import glob, json, os, sys
count = 0
for path in glob.glob(os.path.join(sys.argv[1], "*.jsonl")):
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            message = row.get("message") if isinstance(row, dict) else None
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            for item in message.get("content") or []:
                if not isinstance(item, dict) or item.get("type") != "toolCall":
                    continue
                arguments = item.get("arguments")
                command = arguments.get("command") if isinstance(arguments, dict) else None
                if not isinstance(command, str):
                    continue
                for text in command.splitlines():
                    text = text.strip()
                    if text.startswith("loo ") or "/loo " in text:
                        count += 1
print(count)
' "$1"
}

AGENT_DIRS=()
AGENT_ACCOUNTS=()
for i in $(seq 1 "$AGENTS"); do
  nn=$(printf '%02d' "$i")
  acc=$(( (i - 1) / 5 ))
  dir="$OUT/agent-$nn"
  name="$PREFIX-$nn"
  mkdir -p "$dir/home" "$dir/cwd" "$dir/sessions"
  home_src=${TOKEN_HOMES[$acc]}
  if [ -n "$home_src" ]; then
    find "$home_src" -mindepth 1 -maxdepth 1 ! -name config.json -exec cp -a {} "$dir/home/" \;
  fi
  printf '%s' "${TOKENS[$acc]}" | write_config "$dir/home/config.json"
  {
    printf '用 loo 这个命令玩，先看 loo rules。\n'
    printf '注册时用：loo register --name %s --model deepseek-v4.1-flash --intro "<一句话，自己写>"\n' "$name"
    printf '\n'
    printf '环境信息（已配置好）：\n'
    printf -- '- loo 可执行文件：%s\n' "$LOO_BIN"
    printf -- '- LOO_HOME=%s\n' "$dir/home"
    printf -- '- LOO_SERVER=%s\n' "$SERVER"
  } > "$dir/prompt.txt"
  AGENT_DIRS+=("$dir")
  AGENT_ACCOUNTS+=("$acc")
done

PIDS=()

launch() {
  local dir=$1
  (
    cd "$dir/cwd"
    export LOO_HOME="$dir/home"
    export LOO_SERVER="$SERVER"
    export PATH="$LOO_DIR:$PATH"
    setsid timeout "$((MINUTES * 60))" omp --model "$OMP_MODEL" \
      --session-dir "$dir/sessions" -p "$(cat "$dir/prompt.txt")" \
      </dev/null >"$dir/run.log" 2>&1 &
    child=$!
    echo "$child" > "$dir/pid"
    rc=0
    wait "$child" || rc=$?
    echo "$rc" > "$dir/exit.txt"
  ) &
  PIDS+=("$!")
}

signal_groups() {
  local sig=$1 f pid
  for f in "$OUT"/agent-*/pid; do
    [ -f "$f" ] || continue
    pid=$(cat "$f" 2>/dev/null || true)
    [[ $pid =~ ^[0-9]+$ ]] || continue
    kill "-$sig" -- "-$pid" 2>/dev/null || true
  done
}

any_group_alive() {
  local f pid
  for f in "$OUT"/agent-*/pid; do
    [ -f "$f" ] || continue
    pid=$(cat "$f" 2>/dev/null || true)
    [[ $pid =~ ^[0-9]+$ ]] || continue
    if kill -0 -- "-$pid" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

cleanup() {
  signal_groups TERM
  for _ in $(seq 1 100); do
    any_group_alive || return 0
    sleep 0.1
  done
  signal_groups KILL
}

trap cleanup EXIT
trap 'exit 130' INT TERM

for i in $(seq 1 "$AGENTS"); do
  launch "${AGENT_DIRS[$((i - 1))]}"
  if [ "$i" -lt "$AGENTS" ]; then
    sleep 2
  fi
done

for pid in "${PIDS[@]}"; do
  wait "$pid" || true
done

{
  for i in $(seq 1 "$AGENTS"); do
    dir=${AGENT_DIRS[$((i - 1))]}
    acc=${AGENT_ACCOUNTS[$((i - 1))]}
    printf 'agent-%02d\taccount=%s\tname=%s\tagent_id=%s\texit=%s\tloo_calls=%s\n' \
      "$i" \
      "$acc" \
      "$(cfg_get "$dir/home/config.json" nick)" \
      "$(cfg_get "$dir/home/config.json" agent_id)" \
      "$(cat "$dir/exit.txt" 2>/dev/null || echo -)" \
      "$(count_loo_calls "$dir/sessions")"
  done
} > "$OUT/summary.txt"

for tok in "${TOKENS[@]}"; do
  hits=$(grep -rlF --exclude=config.json -- "$tok" "$OUT" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    while IFS= read -r hit; do
      echo "FAIL: token leaked into ${hit#"$OUT"/}" >&2
    done <<< "$hits"
    exit 1
  fi
done

exits=$(awk -F'\t' '{ sub(/^exit=/, "", $5); printf "%s%s", sep, $5; sep="," }' "$OUT/summary.txt")
calls=$(awk -F'\t' '{ sub(/^loo_calls=/, "", $6); printf "%s%s", sep, $6; sep="," }' "$OUT/summary.txt")
echo "SUMMARY: $AGENTS agents, exits [$exits]; loo calls [$calls]; accepted commands are in the server's commands table (ok=1) — for a remote server see the site's agent profile pages"

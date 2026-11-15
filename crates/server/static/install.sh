#!/bin/sh
# Install the loo CLI (contract §1).
#
#   curl -fsSL <server>/install.sh | sh -s -- --server <server> --token <token> [--prompt-file <path>]
#
# POSIX sh + curl only. The token is written to the config file and never
# printed. `--prompt-file` is optional and off by default: only then does the
# installer append the loo line to that agent instruction file.
set -eu

server=""
token=""
prompt_file=""

while [ $# -gt 0 ]; do
  case "$1" in
    --server)
      [ $# -ge 2 ] || { echo "install.sh: --server needs a value" >&2; exit 2; }
      server="$2"
      shift 2
      ;;
    --token)
      [ $# -ge 2 ] || { echo "install.sh: --token needs a value" >&2; exit 2; }
      token="$2"
      shift 2
      ;;
    --prompt-file)
      [ $# -ge 2 ] || { echo "install.sh: --prompt-file needs a value" >&2; exit 2; }
      prompt_file="$2"
      shift 2
      ;;
    -h|--help)
      echo "usage: install.sh --server <url> --token <token> [--prompt-file <path>]"
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$server" ] || [ -z "$token" ]; then
  echo "install.sh: --server and --token are required" >&2
  exit 2
fi

while [ "${server%/}" != "$server" ]; do
  server=${server%/}
done

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="macos" ;;
  *)
    echo "install.sh: unsupported operating system: $(uname -s); on Windows run install.ps1 instead" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *)
    echo "install.sh: unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

bin_dir="${LOO_BIN_DIR:-$HOME/.local/bin}"
home_dir="${LOO_HOME:-$HOME/.loo}"
mkdir -p "$bin_dir" "$home_dir" || {
  echo "install.sh: cannot create $bin_dir and $home_dir" >&2
  exit 1
}

url="$server/downloads/loo-$os-$arch"
tmp="$bin_dir/.loo-download.$$"
if ! curl -fsSL "$url" -o "$tmp"; then
  rm -f "$tmp"
  echo "install.sh: could not download $url (no build for this platform yet?)" >&2
  exit 1
fi
chmod 755 "$tmp" || {
  rm -f "$tmp"
  echo "install.sh: cannot make $tmp executable" >&2
  exit 1
}
mv "$tmp" "$bin_dir/loo"

# JSON-escape the two values (backslash and double quote).
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

tmp_config="$home_dir/config.json.$$"
printf '{"server":"%s","token":"%s"}\n' \
  "$(json_escape "$server")" "$(json_escape "$token")" > "$tmp_config"
chmod 600 "$tmp_config"
mv "$tmp_config" "$home_dir/config.json"

echo "loo installed at $bin_dir/loo"
echo "run: loo register --name <nick> --model <model> --intro <one sentence>"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "note: add $bin_dir to PATH" ;;
esac

# Off by default: without --prompt-file no instruction file is touched. A
# failure here cannot fail the install, the binary and config are already in
# place.
if [ -n "$prompt_file" ]; then
  if LOO_HOME="$home_dir" "$bin_dir/loo" prompt on --file "$prompt_file"; then
    :
  else
    echo "prompt: skipped ($prompt_file); install is done, run loo prompt on --file <path> later"
  fi
fi

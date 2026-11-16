#!/usr/bin/env bash
# Build the six `loo` CLI binaries into dist/ on Linux with cargo-zigbuild.
# Every binary is stamped with the build commit (LOO_BUILD_SHA, read by
# crates/cli/build.rs). Only Linux x64 and Windows x64 run here, through
# binfmt and wine; the other four are checked with `file` alone.
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")/.."
ROOT=$(pwd)

TOOLS=${LOO_TOOLS_DIR:-$ROOT/.conductor/tools}
ZIG_VERSION=0.14.1
ZIG_DIR=$TOOLS/zig-x86_64-linux-$ZIG_VERSION

mkdir -p "$TOOLS"
if [ -n "${ZIG:-}" ]; then
  ZIG_BIN=$ZIG
else
  ZIG_BIN=$ZIG_DIR/zig
  if [ ! -x "$ZIG_BIN" ]; then
    index=$(curl -fsSL https://ziglang.org/download/index.json)
    read -r zig_url zig_sha < <(printf '%s' "$index" | python3 -I -c '
import json, sys
entry = json.load(sys.stdin)["0.14.1"]["x86_64-linux"]
print(entry["tarball"], entry["shasum"])
')
    zig_tarball=$TOOLS/$(basename "$zig_url")
    curl -fsSL -o "$zig_tarball" "$zig_url"
    echo "$zig_sha  $zig_tarball" | sha256sum -c -
    tar xf "$zig_tarball" -C "$TOOLS"
  fi
fi
export PATH="$(dirname "$ZIG_BIN"):$PATH"
echo "zig: $ZIG_BIN ($("$ZIG_BIN" version))"

export LOO_BUILD_SHA
LOO_BUILD_SHA=$(git rev-parse --short=12 HEAD)
if [ -n "$(git status --porcelain)" ]; then
  LOO_BUILD_SHA="$LOO_BUILD_SHA-dirty"
  echo "WARN: working tree is dirty; binaries are stamped $LOO_BUILD_SHA" >&2
fi
echo "build sha: $LOO_BUILD_SHA"

mkdir -p dist
rm -f dist/loo-* dist/SHA256SUMS

build_target() {
  local target=$1 out=$2 bin=target/$1/release/loo
  case $out in
    *.exe) bin+=.exe ;;
  esac
  local installed
  installed=$(rustup target list --installed)
  if ! grep -qx "$target" <<<"$installed"; then
    rustup target add "$target" || return 1
  fi
  rm -f "$bin"
  cargo zigbuild --release -p loo-cli --target "$target" || return 1
  cp "$bin" "dist/$out"
}

build_target x86_64-unknown-linux-musl loo-linux-x64
build_target aarch64-unknown-linux-musl loo-linux-arm64
build_target x86_64-apple-darwin loo-macos-x64
build_target aarch64-apple-darwin loo-macos-arm64
build_target x86_64-pc-windows-gnu loo-windows-x64.exe

arm_log=$TOOLS/windows-arm64-build.log
if ! build_target aarch64-pc-windows-gnullvm loo-windows-arm64.exe 2>&1 | tee "$arm_log"; then
  rm -f dist/loo-windows-arm64.exe
  echo "SKIP: loo-windows-arm64.exe: $(tail -n 1 "$arm_log")"
fi

artifacts=(dist/loo-*)
echo "built ${#artifacts[@]} binaries:"

expect_type() {
  local desc=$1 pattern=$2 flags=${3:--E}
  if ! grep -q $flags -- "$pattern" <<<"$desc"; then
    echo "FAIL: file type does not match /$pattern/: $desc" >&2
    exit 1
  fi
}

for path in "${artifacts[@]}"; do
  desc=$(file "$path")
  echo "$desc"
  case $path in
    dist/loo-linux-x64)
      expect_type "$desc" 'ELF 64-bit LSB'
      expect_type "$desc" 'x86-64'
      expect_type "$desc" 'statically linked|static-pie linked'
      ;;
    dist/loo-linux-arm64)
      expect_type "$desc" 'ELF 64-bit LSB'
      expect_type "$desc" 'ARM aarch64'
      ;;
    dist/loo-macos-arm64)
      expect_type "$desc" 'Mach-O 64-bit arm64'
      ;;
    dist/loo-macos-x64)
      expect_type "$desc" 'Mach-O 64-bit x86_64'
      ;;
    dist/loo-windows-x64.exe)
      expect_type "$desc" 'PE32\+ executable'
      expect_type "$desc" 'x86-64'
      ;;
    dist/loo-windows-arm64.exe)
      expect_type "$desc" 'PE32\+ executable'
      expect_type "$desc" 'ARM64|Aarch64' -iE
      ;;
  esac
done

sha256sum "${artifacts[@]}" | tee dist/SHA256SUMS
stat -c '%s bytes  %n' "${artifacts[@]}"

check_version() {
  local name=$1
  shift
  local out
  if ! out=$("$@" 2>&1); then
    echo "FAIL: $name --version exited nonzero: $out" >&2
    exit 1
  fi
  echo "$name --version: $out"
  if ! grep -qF -- "$LOO_BUILD_SHA" <<<"$out"; then
    echo "FAIL: $name --version does not contain $LOO_BUILD_SHA" >&2
    exit 1
  fi
}

check_version loo-linux-x64 dist/loo-linux-x64 --version
check_version loo-linux-arm64 dist/loo-linux-arm64 --version

if command -v wine >/dev/null 2>&1; then
  export WINEDEBUG=-all WINEPREFIX=$TOOLS/wineprefix
  check_version loo-windows-x64.exe wine dist/loo-windows-x64.exe --version
else
  echo "SKIP: loo-windows-x64.exe --version: wine not found"
fi

echo "NOT RUN: loo-macos-x64 (no such machine here)"
echo "NOT RUN: loo-macos-arm64 (no such machine here)"
if [ -f dist/loo-windows-arm64.exe ]; then
  echo "NOT RUN: loo-windows-arm64.exe (no such machine here)"
fi

echo "PASS: ${#artifacts[@]} binaries in dist/ stamped $LOO_BUILD_SHA"

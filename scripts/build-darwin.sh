#!/usr/bin/env bash
# Cross-compile the macOS (x64 and arm64) and Windows x64 binaries from Linux
# with cargo-zigbuild. No Xcode and no Mac are involved, so nothing here proves
# the binaries run on a Mac; `file` and the link dependencies are all we check.
#
# The result lands in `dist/`, which git ignores, and the server serves it with
# `--downloads-dir dist`.
set -euo pipefail
cd "$(dirname "$0")/.."

ZIG=${ZIG:-}
if [ -z "$ZIG" ]; then
  for candidate in \
    "$PWD"/.conductor/k/tools/zig-*/zig \
    /home/sentimentalk/orca/workspaces/slacking-off/onboarding/.conductor/k/tools/zig-*/zig
  do
    if [ -x "$candidate" ]; then
      ZIG=$candidate
      break
    fi
  done
fi

if [ -z "$ZIG" ]; then
  echo "FAIL: zig not found; download it with: curl -fsSL -o zig.tar.xz https://ziglang.org/download/0.14.1/zig-x86_64-linux-0.14.1.tar.xz && tar xf zig.tar.xz -C .conductor/k/tools" >&2
  exit 1
fi

export PATH="$(dirname "$ZIG"):$PATH"
echo "zig: $ZIG ($("$ZIG" version))"

mkdir -p dist

build() {
  local target=$1
  local out=$2
  local binary="target/$target/release/loo"
  if ! rustup target list --installed | grep -qx "$target"; then
    rustup target add "$target"
  fi
  cargo zigbuild --release -p loo-cli --target "$target"
  if [ "$target" = "x86_64-pc-windows-gnu" ]; then
    binary="$binary.exe"
  fi
  cp "$binary" "dist/$out"
}

build aarch64-apple-darwin loo-macos-arm64
build x86_64-apple-darwin loo-macos-x64
build x86_64-pc-windows-gnu loo-windows-x64.exe

echo
file dist/loo-macos-arm64 dist/loo-macos-x64 dist/loo-windows-x64.exe
echo
sha256sum dist/loo-macos-arm64 dist/loo-macos-x64 dist/loo-windows-x64.exe

check() {
  local path=$1
  local needle=$2
  if ! file "$path" | grep -qF "$needle"; then
    echo "FAIL: $path is not $needle" >&2
    file "$path" >&2
    exit 1
  fi
}

check dist/loo-macos-arm64 'Mach-O 64-bit arm64'
check dist/loo-macos-x64 'Mach-O 64-bit x86_64'
check dist/loo-windows-x64.exe 'PE32+ executable'

echo 'PASS: darwin binaries are Mach-O (macOS 13+), windows is PE32+'

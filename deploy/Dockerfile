# syntax=docker/dockerfile:1
#
# Build context is the repository root. The CLI packages come from dist/, so
# build them first, at the same clean commit as the image:
#   bash scripts/build-cli.sh
#   docker buildx build --platform linux/arm64 -f deploy/Dockerfile \
#     --build-arg LOO_BUILD_SHA=$(git rev-parse --short=12 HEAD) -t slacking-off:arm64 --load .
#
# The web bundle and the Rust binary are built on the builder's native
# platform; only the final Debian stage is the target platform, so qemu runs a
# static-ish runtime and never a Rust compiler.

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM rust:1-bookworm AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        gcc-aarch64-linux-gnu \
        libc6-dev-arm64-cross \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN rustup target add aarch64-unknown-linux-gnu
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY --from=web /src/web/dist ./web/dist
ENV CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
RUN cargo build --release --target aarch64-unknown-linux-gnu -p loo-server

FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS dl
ARG LOO_BUILD_SHA
COPY dist/ /dl/
RUN <<'CHECK'
set -eu
sha="${LOO_BUILD_SHA:-}"
fail() { echo "$1" >&2; exit 1; }
[ -n "$sha" ] || fail 'LOO_BUILD_SHA is not set: build with --build-arg LOO_BUILD_SHA=$(git rev-parse --short=12 HEAD) after bash scripts/build-cli.sh'
case "$sha" in
  *-dirty) fail "refusing to build an image from a dirty tree (LOO_BUILD_SHA=$sha): commit first, rerun bash scripts/build-cli.sh" ;;
esac
for f in loo-linux-x64 loo-linux-arm64 loo-macos-x64 loo-macos-arm64 loo-windows-x64.exe; do
  [ -f "/dl/$f" ] || fail "dist/ is missing $f: run bash scripts/build-cli.sh"
done
ver=$(/dl/loo-linux-x64 --version 2>&1 | head -n 1)
case "$ver" in
  *"($sha)"*) ;;
  *) fail "dist/ was built from $ver, not $sha: rerun bash scripts/build-cli.sh at this commit" ;;
esac
CHECK

FROM --platform=$TARGETPLATFORM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 loo \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin loo \
    && mkdir -p /app/maps /app/downloads /data \
    && chown 10001:10001 /data

COPY --from=build /src/target/aarch64-unknown-linux-gnu/release/loo-server /usr/local/bin/loo-server
COPY maps/default.txt /app/maps/default.txt
COPY --from=dl --chmod=755 /dl/loo-* /app/downloads/

ENV TMPDIR=/tmp \
    MALLOC_ARENA_MAX=2
VOLUME ["/data"]
EXPOSE 18080
STOPSIGNAL SIGTERM

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/loo-server"]
CMD ["--official", "--addr", "0.0.0.0:18080", "--map", "/app/maps/default.txt", "--data-dir", "/data", "--downloads-dir", "/app/downloads"]

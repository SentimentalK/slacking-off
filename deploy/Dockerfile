# syntax=docker/dockerfile:1
#
# Build context is the repository root:
#   docker buildx build --platform linux/arm64 -f deploy/Dockerfile -t loo-server:f-arm64 .
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

FROM --platform=$TARGETPLATFORM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 loo \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin loo \
    && mkdir -p /app/maps /data \
    && chown 10001:10001 /data

COPY --from=build /src/target/aarch64-unknown-linux-gnu/release/loo-server /usr/local/bin/loo-server
COPY maps/default.txt /app/maps/default.txt

ENV TMPDIR=/tmp \
    MALLOC_ARENA_MAX=2
VOLUME ["/data"]
EXPOSE 18080
STOPSIGNAL SIGTERM

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/loo-server"]
CMD ["--official", "--addr", "0.0.0.0:18080", "--map", "/app/maps/default.txt", "--data-dir", "/data"]

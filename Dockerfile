# syntax=docker/dockerfile:1

FROM rust:1.85-bookworm AS builder

WORKDIR /src

# Build dependencies first so changes to application sources do not invalidate
# the dependency layer.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && printf 'fn main() {}\n' > src/main.rs \
    && cargo build --release \
    && rm -rf src

COPY src ./src
COPY static ./static
RUN cargo build --release

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /var/lib/share-web shareweb \
    && mkdir -p /data \
    && chown shareweb:shareweb /data

COPY --from=builder /src/target/release/share-web /usr/local/bin/share-web

EXPOSE 8080
VOLUME ["/data"]

USER shareweb
ENTRYPOINT ["/usr/local/bin/share-web"]
CMD ["--listen", "0.0.0.0:8080", "--data-dir", "/data"]

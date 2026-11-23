FROM rust:bookworm AS rust-build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY services/ services/
COPY migrations/ migrations/
RUN cargo build --release --locked -p stock-api --jobs 4

FROM debian:bookworm-slim AS api
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rust-build /src/target/release/stock-api /usr/local/bin/stock-api
USER 65532:65532
ENTRYPOINT ["stock-api"]

FROM node:24-bookworm-slim AS web-build
WORKDIR /src
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM nginx:alpine AS web
COPY infra/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /src/dist /usr/share/nginx/html

# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS frontend

WORKDIR /src

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
ARG HIRAYA_SEEDED_DIR
RUN HIRAYA_SEEDED_DIR="${HIRAYA_SEEDED_DIR}" bun run build


FROM golang:1.25-alpine AS backend

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/hiraya-server ./cmd/hiraya-server


FROM alpine:3.22 AS runtime

RUN addgroup -S hiraya \
    && adduser -S -G hiraya hiraya \
    && mkdir -p /app/dist /data \
    && chown hiraya:hiraya /data

WORKDIR /app

COPY --from=backend /out/hiraya-server ./hiraya-server
COPY --from=frontend /src/dist ./dist

ENV HIRAYA_ADDR=0.0.0.0:8080 \
    HIRAYA_DATA_DIR=/data \
    HIRAYA_STATIC_DIR=/app/dist \
    HIRAYA_TLS_CERT_FILE="" \
    HIRAYA_TLS_KEY_FILE=""

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD if [ -n "$HIRAYA_TLS_CERT_FILE" ]; then \
        wget --no-check-certificate -q -O /dev/null https://127.0.0.1:8080/api/health; \
      else \
        wget -q -O /dev/null http://127.0.0.1:8080/api/health; \
      fi || exit 1

USER hiraya

ENTRYPOINT ["/app/hiraya-server"]

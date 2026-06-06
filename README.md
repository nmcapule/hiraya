# Hiraya

Mobile-focused web code editor with a host terminal.

## Build

```sh
cd web
TMPDIR=/tmp bun install
TMPDIR=/tmp bun run build
cd ..
GOCACHE=/tmp/go-build go test ./...
GOCACHE=/tmp/go-build go build -buildvcs=false -o hiraya ./cmd/hiraya
```

## Run

```sh
./hiraya --root /path/to/workspace --addr :8080
```

The app serves the React UI, file API, and terminal WebSocket from the same port.
It has no built-in authentication and should be run behind the private exe.dev
HTTPS proxy unless another access boundary is added.

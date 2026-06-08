APP := hiraya
ROOT ?= $(CURDIR)
ADDR ?= :8080
TERMINAL_MODE ?= shell
TMPDIR ?= /tmp
GOCACHE ?= /tmp/go-build

.PHONY: help prod build-prod build-dev dev web-deps web-build test clean

help:
	@printf '%s\n' \
		'Targets:' \
		'  make prod        Build production frontend assets and Go binary' \
		'  make build-dev   Install frontend deps and build the Go binary' \
		'  make dev         Run Go backend and Vite dev server' \
		'' \
		'Variables:' \
		'  ROOT=/path       Workspace root served by the app (default: repo root)' \
		'  ADDR=:8080       Backend listen address (default: :8080)' \
		'  TERMINAL_MODE=shell|byobu Terminal startup mode (default: shell)'

prod: build-prod

build-prod: web-build test
	GOCACHE=$(GOCACHE) go build -buildvcs=false -o $(APP) ./cmd/hiraya

build-dev: web-deps
	GOCACHE=$(GOCACHE) go build -buildvcs=false -o $(APP) ./cmd/hiraya

dev: web-deps
	GOCACHE=$(GOCACHE) go run ./cmd/hiraya --root "$(ROOT)" --addr "$(ADDR)" --terminal-mode "$(TERMINAL_MODE)" & \
	server_pid=$$!; \
	trap 'kill $$server_pid' INT TERM EXIT; \
	cd web && TMPDIR=$(TMPDIR) bun run dev

web-deps:
	cd web && TMPDIR=$(TMPDIR) bun install

web-build: web-deps
	cd web && TMPDIR=$(TMPDIR) bun run build

test:
	GOCACHE=$(GOCACHE) go test ./...

clean:
	rm -f $(APP)
	rm -rf internal/server/static/dist

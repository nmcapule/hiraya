# Hiraya

Hiraya is an installable desktop built with React, TypeScript, Vite, OPFS, and SQLite. It runs browser-local or synchronizes a catalog of named desktops with a same-origin Hiraya server.

## Development

```sh
bun install
bun run dev
```

The synchronized build uses root-relative `/api` routes and Vite proxies them to `http://127.0.0.1:8080`. Run without a server with:

```sh
HIRAYA_FRONTEND_ONLY=true bun run dev
```

## Checks

```sh
bun test
bun run lint
bun run build
```

## Server Contract

The frontend accepts only remote schema version 1. `GET /api/catalog` returns `schemaVersion`, `catalogId`, `catalogRevision`, and `desktops`. Desktop state is read and mutated only through `/api/desktops/{desktopId}` and its canonical scoped resources. Events use the `catalog` SSE event; health polling remains a fallback.

A fresh synchronized browser discovers the server-created first empty desktop through the catalog and projects that desktop into its local cache. If the first catalog request is unavailable, it atomically creates a usable offline desktop and an unbound `create-desktop` record; the first successful catalog fetch binds and replays that record. The active desktop ID is tab-local `sessionStorage` state.

## Offline Storage

The browser uses the fresh-only `hiraya-catalog-v1.sqlite3` database in OPFS. Its normalized schema keys entries, layout, editor settings, appearance, themes, windows, and sync state by desktop. There is no singleton desktop projection, JSON desktop column, schema upgrade path, pre-SQLite import, or old content-cache conversion.

Offline mutations update desktop rows and append a strict schema version 1 outbox record atomically. Every record has a `desktopId`; `catalogId` is nullable only before the first successful catalog fetch. Before every replay, the browser globally binds unbound records and blocks all records belonging to another catalog. File bytes are staged before metadata is exposed; downloaded bytes are accepted only for the matching catalog, desktop, entry revision, and size. The browser cache and outbox are not a backup.

## Routes And Areas

The canonical hash is `#/desktops/{desktopId}/areas/{column}/{row}` with optional explorer, file, properties, or settings suffixes. Root coordinates form one continuous canvas; visible areas are derived segments and are not persisted.

## Portable Data

Seeded packages, clipboard archives, window sessions, and browser history use strict schema version 1 envelopes. Entries require `createdAt`. Earlier versions and aliases are intentionally rejected.

Set `HIRAYA_SEEDED_DIR` to a package directory containing `manifest.json` and referenced content:

```sh
HIRAYA_SEEDED_DIR=examples/seeded bun run build
```

Seeded content is used only for a fresh frontend-only origin. Synchronized installs converge from the server catalog.

## GitHub Pages

```sh
HIRAYA_FRONTEND_ONLY=true \
HIRAYA_SEEDED_DIR=examples/seeded \
HIRAYA_BASE_PATH=/hiraya/ \
bun run build
```

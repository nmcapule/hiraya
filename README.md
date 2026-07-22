# Hiraya

Hiraya is an installable mock desktop built with React, TypeScript, Vite, and the Origin Private File System (OPFS). It runs as a standalone browser-local desktop or as the frontend for a synchronized Hiraya server.

[Open Hiraya on GitHub Pages](https://nmcapule.github.io/hiraya/)

<p align="center">
  <img src="docs/screenshots/hiraya-desktop.png" alt="Hiraya desktop showing the Welcome folder" width="72%" />
  <img src="docs/screenshots/hiraya-mobile.png" alt="Hiraya desktop on a mobile viewport" width="24%" />
</p>

## Development

Install dependencies and start Vite:

```sh
bun install
bun run dev
```

The default synchronized build expects the Hiraya API at `/api`. During development, Vite proxies that path to `http://127.0.0.1:8080`.

To work without a server, start a frontend-only desktop:

```sh
HIRAYA_FRONTEND_ONLY=true bun run dev
```

In frontend-only mode, each browser's OPFS desktop is authoritative and no API requests are made. OPFS is origin-scoped: changing the hostname or port creates a separate local desktop, and clearing site data removes it.

## Checks

```sh
bun test
bun run lint
bun run build
```

## Server integration

The synchronized frontend uses root-relative `/api` routes so the application and server can be deployed on one origin. The private server repository pins this repository as its `frontend` submodule, builds `dist`, and serves it alongside the API.

The HTTP workspace schema is version 5. Its TypeScript response validation lives in `src/lib/contracts.ts`, route construction lives in `src/lib/api-routes.ts`, and synchronization lives in `src/lib/sync.ts`. API changes must remain compatible with service-worker-controlled clients and durable offline operations created by older frontend versions.

## Offline behavior

The browser cache uses a WAL-enabled SQLite database in OPFS. A SharedWorker coordinates tabs through one dedicated SQLite connection. It stores entries, coordinates, layout, editor settings, synchronization revisions, local preferences, and a durable mutation outbox.

The production service worker caches the application shell, SQLite worker, and WASM runtime. Offline changes update the projected local desktop and replay in order after the server reconnects. Structural conflicts remain visible as blocked operations instead of being silently discarded. The browser cache and outbox are not a backup.

## Seeded desktops

Set `HIRAYA_SEEDED_DIR` to a directory inside this repository containing a seeded `manifest.json` and its referenced content:

```sh
HIRAYA_SEEDED_DIR=examples/seeded bun run dev
HIRAYA_SEEDED_DIR=examples/seeded bun run build
```

`examples/seeded` demonstrates the current version 7 format. Versions 1 through 6 remain accepted and are normalized. The build rejects malformed manifests, missing or size-mismatched content, paths outside the configured directory, and symbolic links.

Seeded content initializes only browser origins without a Hiraya SQLite database or legacy manifest. It never replaces an existing desktop. Open **Settings** and use **Export desktop** to create a compatible seeded package from saved content.

## GitHub Pages

Pushes to `main` deploy a frontend-only build seeded from `examples/seeded`. The equivalent local build is:

```sh
HIRAYA_FRONTEND_ONLY=true \
HIRAYA_SEEDED_DIR=examples/seeded \
HIRAYA_BASE_PATH=/hiraya/ \
bun run build
```

## Themes

Hiraya includes Dusk, Warm Paper, Midnight Glass, and High Contrast themes. Custom themes, the selected theme, wallpaper, layout, and editor preferences are persisted with the desktop and included in seeded exports.

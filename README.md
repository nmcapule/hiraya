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

The frontend accepts only remote schema version 1. In synchronized mode it first fetches `GET /api/auth/session`, which returns a stable opaque `storageId`, `user` display metadata, and the required `capabilities.blobTransfer: "direct-b2-v1"`. A 401 redirects to the server-owned `/login` page with a root-relative return path. `GET /api/catalog` returns owned and shared desktops with roles and explicit capabilities. Desktop state is read and mutated through `/api/desktops/{desktopId}` and its canonical scoped resources. Anonymous read-only publications use `/shared/{token}` and `/api/public/desktops/{token}` without entering authenticated storage. Events use the `catalog` SSE event; authenticated `/api/sync/health` polling remains a fallback, while `/api/health` remains the public build-health route.

A fresh synchronized browser discovers the server-created first empty desktop through the catalog and projects that desktop into its local cache. If the first catalog request is unavailable, it atomically creates a usable offline desktop and an unbound `create-desktop` record; the first successful catalog fetch binds and replays that record. The active desktop ID is tab-local `sessionStorage` state.

## Offline Storage

The browser hashes the session `storageId` into a safe account namespace before loading the desktop or starting workers. The OPFS directory tree, SQLite pool and database, file and pending directories, content markers, workers, locks, preferences, and active desktop session key are all scoped by that namespace. OPFS schema version 4 migrates older versions in place, persists desktop roles so cached shared desktops remain read-only after an offline restart, stores device preferences, and reserves normalized offline pins for later use. Frontend-only mode makes no auth request and preserves its existing unscoped local storage contract. Logout preserves every account namespace. Synchronized builds remove the old unscoped server-cache layout once rather than migrating it.

Offline mutations update desktop rows and append a strict schema version 1 outbox record atomically. Every record has a `desktopId`; `catalogId` is nullable only before the first successful catalog fetch. Replay selects records belonging to the active desktop authority without blocking pending work for other authorities. Shared writes require an online connection. File bytes are staged before metadata is exposed; downloaded bytes are accepted only for the matching catalog, desktop, entry revision, and size. The browser cache and outbox are not a backup.

Synchronized file creates and content saves calculate SHA-256 and MD5 from staged OPFS bytes, reserve an atomic blob mutation with the same durable outbox identity, PUT files directly to the server-authorized object-store targets, and finalize metadata only after server verification. Reads obtain a short-lived content-access target, download directly, verify SHA-256, and then populate the OPFS cache. Presigned targets and object-store credentials are never persisted.

## Routes And Areas

The canonical hash is `#/desktops/{desktopId}/areas/{column}/{row}` with optional explorer, file, properties, or settings suffixes. Root coordinates form one continuous canvas; visible areas are derived segments and are not persisted.

## Portable Data

Seeded packages, clipboard archives, window sessions, and browser history use strict schema version 1 envelopes. Entries require `createdAt`. Earlier versions and aliases are intentionally rejected.

Set `HIRAYA_SEEDED_DIR` to a package directory containing `manifest.json` and referenced content:

```sh
HIRAYA_SEEDED_DIR=examples/seeded bun run build
```

Seeded content is used only for a fresh frontend-only origin. Synchronized installs converge from the server catalog.

The production build also packages the Calculator, ZIP Browser, and Pixel Editor examples into `dist/experimental-apps`. A Hiraya server uses these archives when it provisions the deployment's read-only `Experimental Apps` desktop. Users copy packages from that desktop to an owned desktop before approving them for access to personal files.

## GitHub Pages

```sh
HIRAYA_FRONTEND_ONLY=true \
HIRAYA_SEEDED_DIR=examples/seeded \
HIRAYA_BASE_PATH=/hiraya/ \
bun run build
```

# Hiraya Frontend Agent Guide

## Project Overview

This repository is the public Hiraya frontend. It is a React, TypeScript, and Vite progressive web app that can run browser-local or synchronize with the private Hiraya server through same-origin `/api` routes. The server repository pins this repository as its `frontend` submodule.

Use Bun for package and script operations:

```sh
bun install
bun test
bun run lint
bun run build
bun run dev
```

## Architecture

- `src/App.tsx`: application state and orchestration for files, dialogs, uploads, errors, and windows.
- `src/lib/sync.ts`: API mutations, durable outbox replay, SSE, health checks, and remote reconciliation.
- `src/lib/opfs.ts`: browser persistence boundary. Keep storage access behind this module.
- `src/lib/contracts.ts`: runtime validation for the server's version 5 workspace schema.
- `src/lib/api-routes.ts`: same-origin API route construction.
- `src/lib/seeded-manifest.ts`: seeded manifest validation shared by the build loader and exporter.
- `src/lib/seeded.ts`: seeded ZIP export.
- `build/seeded.ts`: Vite plugin that validates and bundles optional seeded content.
- `vite.config.ts`: seeded content, PWA generation, and the development `/api` proxy.
- `src/components/`: desktop windows, icons, dialogs, menus, and previews.
- `src/ui/`: desktop geometry, window management, and UI-domain helpers.
- `src/styles.css`: visual system, wallpaper, responsive behavior, and motion fallbacks.

Prefer small changes in existing modules. Do not introduce global state or a component framework without a concrete need.

## Storage And Sync Invariants

- OPFS is authoritative only in frontend-only mode. In synchronized mode it is a cache and projected offline workspace.
- All browser storage operations go through `src/lib/opfs.ts`.
- Physical browser files use stable UUIDs; user-facing names and folders are metadata.
- The OPFS SQLite schema and legacy manifest migration are separate from the HTTP workspace schema.
- `.hiraya-manifest.json` versions 1 through 13 are legacy import sources only.
- Offline mutations update the projected SQLite desktop and append an outbox operation atomically.
- Replay uses stable idempotency headers and preserves blocked operations for user resolution.
- During reconciliation, download and validate changed blobs before publishing metadata. Remove obsolete blobs afterward.
- Write file contents before adding metadata that references them.
- Renaming and reparenting update metadata only.
- Validate complete multi-file operations before writing any file.
- Preserve unsaved editor text when remote content changes.
- Keep API responses and SSE outside service-worker precaching.
- OPFS is origin-scoped and is removed when browser site data is cleared.

## API Compatibility

- The current HTTP workspace schema is version 5 and is validated by `src/lib/contracts.ts`.
- Keep TypeScript IDs, names, hierarchy, MIME, coordinates, themes, layout, and settings validation equivalent to the server contract.
- API paths, multipart field names, content types, and `X-Hiraya-Client-ID` / `X-Hiraya-Operation-ID` headers are durable replay contracts.
- SSE carries workspace revision notifications; health polling remains a fallback for dead streams.
- Root-relative `/api` routes preserve same-origin deployment. Do not add cross-origin behavior implicitly.
- Old service-worker-controlled clients and persisted outbox operations constrain API rollout order.

## Seeded Desktops

- `HIRAYA_SEEDED_DIR` must point inside this repository and is never exposed to browser code.
- Seeded manifest version 7 accepts versions 1 through 6 for normalization.
- Fetch and validate every seeded asset before publishing complete metadata.
- Never seed, merge into, or replace an existing desktop, including an intentionally empty one.
- Export preserves stable IDs, signed finite coordinates, empty folders, layout, appearance, and editor settings.
- `examples/seeded` is the canonical package example.

## Interaction And UI

- Dragging applies direct transforms during pointer movement and commits state only on release.
- Use Pointer Events and keep icons reachable on desktop and mobile.
- Root coordinates occupy one continuous logical surface; workspace tiles are derived and never persisted.
- External file input and drag-and-drop must use the same import path.
- Revoke every object URL created for media or document previews.
- Preserve keyboard access, `Escape` dismissal, and `Ctrl+S` / `Cmd+S` saving.
- Preserve the dusk-green wallpaper, amber accent, translucent menu bar, restrained chrome, and Phosphor icon family.
- Honor WCAG AA contrast and `prefers-reduced-motion`.
- Do not add runtime font imports.

## Verification

Always run:

```sh
bun test
bun run lint
bun run build
```

For storage or interaction changes, also create, edit, save, rename, upload, drag, reload, and verify persistence. Check the console and test desktop plus an approximately 390px-wide viewport.

For server integration changes, test against the server repository's pinned submodule workflow in two isolated browser sessions. Verify offline mutation, reconnection, SSE propagation, restart persistence, and schema compatibility.

For seeded changes, build with `HIRAYA_SEEDED_DIR` unset and with `examples/seeded`, verify fresh versus existing origins, export a ZIP, and build from the extracted package.

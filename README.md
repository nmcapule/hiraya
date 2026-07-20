# Hiraya

Hiraya is a synchronized mock desktop. A Go server stores the authoritative shared workspace, while each browser keeps a local cache in the Origin Private File System (OPFS).

## Development

Install dependencies, then run the backend and Vite in separate terminals:

```sh
bun install
bun run server
bun run dev
```

Vite proxies `/api` to `http://127.0.0.1:8080`. The server stores its data in `.hiraya-data` by default. Browser mutations require a server connection; cached files remain available to view while disconnected.

The backend accepts these optional environment variables:

- `HIRAYA_ADDR`: listen address, default `127.0.0.1:8080`.
- `HIRAYA_DATA_DIR`: durable metadata and file directory, default `.hiraya-data`.
- `HIRAYA_STATIC_DIR`: production frontend directory, default `dist`.
- `HIRAYA_MAX_UPLOAD_BYTES`: maximum bytes in one upload or bootstrap, default 100 MiB.

Build and run the same-origin production server with:

```sh
bun run build
go build -o hiraya-server ./cmd/hiraya-server
./hiraya-server
```

This initial server exposes one shared workspace without authentication. Keep it bound to a trusted interface; anyone who can reach it can read or change the workspace.

## Synchronization

The server orders accepted writes with a monotonic revision. The last accepted write to an entry wins, while writes to different entries are retained independently. Layout and editor settings have their own revisions. Server-Sent Events notify connected browsers of changes; browsers then fetch current metadata and only download file bodies whose content revision changed.

If the server has never been initialized, the first browser uploads its complete saved OPFS desktop. If the server is already initialized, its workspace replaces a first-time browser's local desktop. Metadata is committed only after referenced file contents are durable.

## Install and offline use

Hiraya is an installable progressive web app. In a supported browser, use the browser's **Install app** action to add it to the desktop or home screen. The installed app launches in a standalone window; use **Fullscreen** in Hiraya's menu bar to enter or leave native fullscreen mode where the Fullscreen API is available.

The production service worker caches Hiraya's app shell, so the installed app can reopen offline after it has loaded successfully once. Saved files and desktop metadata remain available to view from the OPFS cache, but changes are disabled until the sync server reconnects. The cache is tied to the exact browser origin and is not a backup: clearing site data removes it, and using a different hostname or port creates a separate local cache.

Installation and offline caching require HTTPS in production. Browsers treat `localhost` as secure for development.

## Predefined desktop

Set `HIRAYA_PREDEFINED_DIR` at development or build time to bundle a predefined desktop:

```sh
HIRAYA_PREDEFINED_DIR=examples/predefined bun run dev
HIRAYA_PREDEFINED_DIR=examples/predefined bun run build
```

The value must be a directory inside the repository. It must contain a `manifest.json`; each file entry's `contentUrl` is resolved relative to that directory. See `examples/predefined` for the version 2 format. Version 1 packages remain supported and default to snap-to-grid being disabled.

The predefined desktop is copied into OPFS only when the browser origin has no Hiraya manifest. Existing desktops, including intentionally empty desktops, are never merged with or replaced. After seeding, predefined files and folders behave like ordinary editable entries. If the shared server is also uninitialized, this seeded desktop becomes its initial workspace; an initialized server remains authoritative. Clearing the origin's site data removes the local cache and allows predefined content to seed it again before synchronization.

The build rejects malformed manifests, missing or size-mismatched content, paths outside the configured directory, and symbolic links.

### Frontend-only deployment

Set `HIRAYA_FRONTEND_ONLY=true` to run without the Go sync server. In this mode, each browser's OPFS desktop is authoritative, editing remains enabled, and no `/api` requests are made. Changes are private to that browser and persist across reloads. Set `HIRAYA_BASE_PATH` when hosting Hiraya below an origin root:

```sh
HIRAYA_FRONTEND_ONLY=true \
HIRAYA_PREDEFINED_DIR=examples/predefined \
HIRAYA_BASE_PATH=/hiraya/ \
bun run build
```

Pushes to `main` deploy this frontend-only build to GitHub Pages using `examples/predefined`. Returning browsers retain their locally edited desktop when a new version deploys; updated predefined content seeds only browsers without an existing Hiraya manifest.

## Export

Use **Export** in the menu bar to download `hiraya-predefined.zip`. The archive contains `hiraya-predefined/manifest.json` and its `content` tree. Extract that directory into the repository and pass it to `HIRAYA_PREDEFINED_DIR` to seed the exported desktop in a fresh browser origin.

Export includes all saved files, folders, views, icon positions, layout, snap-to-grid preference, and editor settings from the synchronized OPFS cache. Unsaved editor changes are not included.

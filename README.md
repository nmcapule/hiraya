# Hiraya

Hiraya is a synchronized mock desktop. A Go server stores the authoritative shared workspace, while each browser keeps a local cache in the Origin Private File System (OPFS).

[Open Hiraya on GitHub Pages](https://nmcapule.github.io/hiraya/)

<p align="center">
  <img src="docs/screenshots/hiraya-desktop.png" alt="Hiraya desktop showing the Welcome folder" width="72%" />
  <img src="docs/screenshots/hiraya-mobile.png" alt="Hiraya desktop on a mobile viewport" width="24%" />
</p>

## Development

Install dependencies, then run the backend and Vite in separate terminals:

```sh
bun install
bun run server
bun run dev
```

Vite proxies `/api` to `http://127.0.0.1:8080`. The server stores its data in `.hiraya-data` by default. Browser mutations require a server connection; cached files remain available to view while disconnected.

The authoritative file tree is stored under `.hiraya-data/files` using the same names and folder hierarchy shown in Hiraya. Empty Hiraya folders are real directories. Stable internal IDs remain in `.hiraya-data/workspace.json`, whose current server schema version is 4, so renames and moves do not change browser identity. On first startup after upgrading, legacy ID-named blobs are verified and migrated automatically to this logical tree.

Files and folders may also be changed directly in the server's `files` directory. Hiraya watches the tree and performs a fallback scan every second; it also scans at startup for changes made while the server was stopped. Same-path file edits preserve their ID, while external renames and moves are represented as a deletion and a newly created entry. Symbolic links, non-regular files, invalid names, and case-insensitive sibling conflicts are ignored and logged. Avoid placing unrelated files in this directory.

Desktop workspace tiles are derived views, not persisted containers. Each root entry stores signed, finite `x` and `y` coordinates on one continuous logical surface. A browser divides that surface into tiles using only its current viewport and those coordinates, so resizing can change the visible tile arrangement without rewriting saved positions. Dragging an icon through an outer edge previews a transient destination tile; only a successful drop persists the icon's resulting coordinates. Rearranging tiles in the minimap translates the coordinates of the affected root entries as one atomic batch, preserving their local positions within each tile.

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

The browser cache uses `.hiraya-manifest.json` version 12. It persists entries and their coordinates, layout and editor settings, and synchronization revisions; workspace tiles themselves are not stored.

If the server has never been initialized, the first browser uploads its complete saved OPFS desktop. If the server is already initialized, its workspace replaces a first-time browser's local desktop. Metadata is committed only after referenced file contents are durable. Direct filesystem changes join the same monotonic revision stream and propagate to connected browsers through SSE.

## Install and offline use

Hiraya is an installable progressive web app. In a supported browser, use the browser's **Install app** action to add it to the desktop or home screen. The installed app launches in a standalone window; open **Settings** and use **Fullscreen** to enter or leave native fullscreen mode where the Fullscreen API is available.

The production service worker caches Hiraya's app shell, so the installed app can reopen quickly or offline after it has loaded successfully once. Hashed frontend resources use long-lived browser caching when served by the Go process. Open **Settings** to check for a new frontend version or change automatic update checks; a detected update waits for confirmation before reloading. Saved files and desktop metadata remain available to view from the OPFS cache, but changes are disabled until the sync server reconnects. The cache is tied to the exact browser origin and is not a backup: clearing site data removes it, and using a different hostname or port creates a separate local cache.

Installation and offline caching require HTTPS in production. Browsers treat `localhost` as secure for development.

## Seeded desktop

Set `HIRAYA_SEEDED_DIR` at development or build time to bundle a seeded desktop:

```sh
HIRAYA_SEEDED_DIR=examples/seeded bun run dev
HIRAYA_SEEDED_DIR=examples/seeded bun run build
```

The value must be a directory inside the repository. It must contain a `manifest.json`; each file entry's `contentUrl` is resolved relative to that directory. See `examples/seeded` for the version 6 format. Version 1 through 5 packages remain accepted and are normalized to the current coordinate-only format. Older packages default to the Dusk wallpaper, and version 1 also defaults to snap-to-grid being disabled.

The seeded desktop is copied into OPFS only when the browser origin has no Hiraya manifest. Existing desktops, including intentionally empty desktops, are never merged with or replaced. After seeding, seeded files and folders behave like ordinary editable entries. If the shared server is also uninitialized, this seeded desktop becomes its initial workspace; an initialized server remains authoritative. Clearing the origin's site data removes the local cache and allows seeded content to seed it again before synchronization.

The build rejects malformed manifests, missing or size-mismatched content, paths outside the configured directory, and symbolic links.

### Frontend-only deployment

Set `HIRAYA_FRONTEND_ONLY=true` to run without the Go sync server. In this mode, each browser's OPFS desktop is authoritative, editing remains enabled, and no `/api` requests are made. Changes are private to that browser and persist across reloads. Set `HIRAYA_BASE_PATH` when hosting Hiraya below an origin root:

```sh
HIRAYA_FRONTEND_ONLY=true \
HIRAYA_SEEDED_DIR=examples/seeded \
HIRAYA_BASE_PATH=/hiraya/ \
bun run build
```

Pushes to `main` deploy this frontend-only build to GitHub Pages using `examples/seeded`. Returning browsers retain their locally edited desktop when a new version deploys; updated seeded content seeds only browsers without an existing Hiraya manifest.

## Export

Open **Settings** and use **Export desktop** to download `hiraya-seeded.zip`. The archive contains `hiraya-seeded/manifest.json` and its `content` tree. Extract that directory into the repository and pass it to `HIRAYA_SEEDED_DIR` to seed the exported desktop in a fresh browser origin.

Export includes all saved files, folders, signed finite icon coordinates, layout, shared wallpaper, snap-to-grid preference, and editor settings from the synchronized OPFS cache. Unsaved editor changes are not included.

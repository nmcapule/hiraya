# Hiraya Agent Guide

## Project Overview

Hiraya is a synchronized mock desktop built with React, TypeScript, Vite, and Go. A single Go process owns the authoritative shared workspace; browsers keep a revisioned local cache in the Origin Private File System (OPFS). The initial server has one shared workspace and no authentication.

Use Bun for all package and script operations.

```sh
bun install
bun run server
bun run dev
bun run lint
bun run build
go test ./...
```

## Architecture

- `src/App.tsx`: application state and orchestration for files, dialogs, uploads, errors, and open-file windows.
- `src/lib/sync.ts`: browser sync orchestration, server-required mutations, SSE handling, health checks, and remote reconciliation.
- `src/lib/opfs.ts`: the browser cache persistence boundary. Keep OPFS access out of components and other storage access behind this module.
- `src/lib/predefined-manifest.ts`: shared predefined manifest types and validation used by build-time loading and browser export.
- `src/lib/predefined.ts`: browser-side ZIP export for saved desktops.
- `build/predefined.ts`: Vite virtual-module plugin that validates and bundles an optional predefined desktop.
- `vite.config.ts`: predefined bundling, PWA generation, and the development `/api` proxy.
- `cmd/hiraya-server/main.go`: Go server entry point, environment configuration, and same-origin static serving.
- `internal/syncapi/model.go`: server workspace schema and structural validation.
- `internal/syncapi/store.go`: serialized state, durable atomic metadata writes, logical file-tree lifecycle, and SSE subscribers.
- `internal/syncapi/filesystem.go`: logical path mapping, legacy migration, filesystem scanning, live watching, and external-change reconciliation.
- `internal/syncapi/server.go`: HTTP API, atomic uploads, last-write-wins mutations, SSE, and SPA fallback.
- `internal/syncapi/server_test.go`: backend persistence, validation, revision, upload, SSE, and static-serving tests.
- `src/components/FileIcon.tsx`: file type icons and pointer-based desktop dragging.
- `src/components/FileDialog.tsx`: create and rename forms.
- `src/components/FileWindow.tsx`: text editor and media/document previews.
- `src/components/ContextMenu.tsx`: right-click actions.
- `src/types.ts`: shared metadata and UI-state types.
- `src/styles.css`: the full visual system, wallpaper, responsive behavior, and motion fallbacks.

Prefer small changes within these existing modules. Do not introduce global state or a component framework unless the feature genuinely requires it.

## OPFS Invariants

- All browser storage operations go through `src/lib/opfs.ts`.
- OPFS is a cache, not the shared authority. Normal mutations go through `src/lib/sync.ts` and must be accepted by the server before their authoritative result is applied locally.
- User-facing names are metadata only. Physical files use stable UUIDs under the OPFS `files` directory.
- `.hiraya-manifest.json` stores manifest version, names, MIME types, sizes, timestamps, icon positions, the last server revision, and per-entry/content revisions.
- Renaming must update metadata only; never copy or rewrite file contents just to rename a file.
- Write file contents before adding their metadata to the manifest.
- During remote reconciliation, download and validate all changed blobs before publishing the new local manifest. Remove obsolete blobs only after metadata is updated.
- Validate an entire multi-file upload, including duplicates within the batch, before writing any file.
- File names reject empty values, `.`, `..`, slashes, control characters, names over 180 characters, and case-insensitive duplicates.
- OPFS is origin-scoped. Changing the dev hostname or port can appear to lose data because it creates a different origin.
- OPFS requires a modern browser and a secure context, with `localhost` accepted for development.
- Browser site-data clearing removes the local cache, but the initialized server remains authoritative and repopulates it. Do not imply that OPFS is a backup service.

If adding destructive operations, update file content and the manifest carefully so failed operations do not leave visible entries pointing to missing data.

## Sync And Server Invariants

- The server assigns monotonic revisions under one serialized mutation lock. Do not use browser clocks to order conflicting writes.
- Last accepted write wins for the same entry. Independent entry writes are retained. Layout and editor settings are separately revisioned resources.
- File content has its own revision so metadata-only changes do not trigger blob downloads.
- Server file bytes live under `HIRAYA_DATA_DIR/files` using the user-visible name and folder hierarchy. Stable entry IDs remain authoritative metadata and API identifiers.
- Direct regular-file and directory changes under the server tree are reconciled at startup, through filesystem events, and by fallback scans. Same-path content edits retain IDs; external moves and renames are delete/create operations.
- Never follow or import symbolic links from the server file tree. Ignore and log invalid names, non-regular files, and sibling collisions.
- Multi-file imports are one server transaction: validate the full resulting workspace and all byte sizes before making any entry visible.
- Persist file bytes before metadata that references them. Publish SSE only after the metadata commit is durable.
- Recursive folder deletion commits metadata before best-effort blob cleanup so visible entries never point to deleted content.
- Keep server validation equivalent to browser validation for IDs, names, sibling uniqueness, hierarchy, cycles, views, MIME data, sizes, layout, and editor settings.
- SSE events carry only the current workspace revision. Clients pull authoritative metadata and selectively fetch changed content.
- Keep the health revision fallback in addition to SSE; proxies can leave a dead event stream appearing open.
- Mutations are disabled when the server is unavailable. Cached files remain viewable, and unsaved editor text must not be silently discarded.
- Default server paths and limits come from `HIRAYA_ADDR`, `HIRAYA_DATA_DIR`, `HIRAYA_STATIC_DIR`, and `HIRAYA_MAX_UPLOAD_BYTES`.
- The server is unauthenticated. Bind it to a trusted interface unless authentication is explicitly added.

## Predefined Desktops

- `HIRAYA_PREDEFINED_DIR` is an optional compile-time environment variable. It must point to a directory inside the repository containing `manifest.json` and its referenced content.
- An unset or empty `HIRAYA_PREDEFINED_DIR` disables predefined content. Do not expose the source path to browser code or rename it with a `VITE_` prefix.
- The predefined manifest has its own version in `src/lib/predefined-manifest.ts`; it is distinct from the persisted OPFS manifest version.
- Keep the build loader and browser exporter on the same manifest schema and validation path. An exported package must be accepted directly by the build loader after extraction.
- File `contentUrl` values are relative to the configured directory. Reject absolute paths, traversal outside the directory, queries, fragments, missing files, size mismatches, and symbolic links.
- Predefined content seeds OPFS only when `.hiraya-manifest.json` does not exist. Never merge it into, replace, or restore entries in an existing manifest, including an intentionally empty manifest.
- Fetch and validate all predefined assets, then write file contents before publishing the complete OPFS manifest. Failed seeding must not expose metadata that points to missing content.
- If the server is uninitialized, the first browser bootstraps it from the resulting OPFS desktop, including predefined content when it seeded that browser. If the server is initialized, its workspace replaces the local cache.
- Seeded entries become ordinary synchronized entries. User edits, moves, renames, and deletions must persist without being reset from the bundled package.
- The menu-bar Export action packages the entire saved desktop as `hiraya-predefined.zip`, with `hiraya-predefined/manifest.json` and a logical `content` tree.
- Export includes persisted files, folders, empty folders, views, positions, layout, metadata, and editor settings. It intentionally excludes unsaved editor changes.
- Preserve stable entry and view IDs during export. Keep file reads for export inside the OPFS persistence boundary.
- `examples/predefined` is the canonical checked-in package example. Update it and `README.md` when the predefined format or setup changes.

## Interaction Rules

- Dragging deliberately avoids React state updates during pointer movement. `FileIcon` applies a direct `translate3d` transform and commits the position through the sync boundary only on pointer release.
- Use Pointer Events so dragging works with both mouse and touch.
- Keep dragged icons clamped inside the desktop.
- Render positions with CSS `min()` so desktop coordinates remain reachable on narrow viewports without destroying the saved desktop layout.
- Do not replace the drag implementation with continuous `setState` calls.
- External files can arrive through the hidden file input or desktop drag-and-drop. Both paths must call the same import function.
- Text-like MIME types and known text extensions open in the editor. Images, PDFs, video, and audio use object-URL previews. Revoke every object URL after use.
- Right-click opens the custom context menu. Keep it within viewport bounds and preserve keyboard access.
- `Escape` closes transient menus, dialogs, and file windows. `Ctrl+S` or `Cmd+S` saves editable files.

## UI Direction

The interface is a focused desktop, not a dashboard. Preserve the established visual language:

- Dusk-green abstract wallpaper with one amber accent.
- Compact translucent menu bar and restrained window chrome.
- Phosphor icons only; do not mix icon families or hand-draw SVG icons.
- Soft 9-18px radii according to component scale.
- No generic card grids, purple gradients, neon glows, or oversized typography.
- Keep file labels legible over the wallpaper and controls at WCAG AA contrast.
- Keep mobile controls compact and ensure previously dragged icons remain reachable.
- Honor `prefers-reduced-motion` for all animation.
- Fonts use local system stacks. Do not add runtime Google Fonts imports.

## PWA And Offline Behavior

- The service worker caches the application shell, not an independent source of workspace truth.
- Offline startup may show the OPFS cache, but all mutation controls must remain disabled until the Go server reconnects.
- Keep API responses and SSE outside precached assets; synchronization must always use the live server.
- Preserve installability, manifest icons, standalone display mode, and the Fullscreen API control when changing Vite or application-shell behavior.

## State And Error Handling

- Treat network, server, and OPFS calls as fallible and surface concise user-facing errors.
- Update React state only after successful create, import, and rename operations.
- Position updates are optimistic because dragging should feel immediate; reconcile to server state and show an error if persistence fails.
- Serialize client mutations and remote reconciliation so stale SSE pulls cannot overwrite a completed local response.
- Preserve unsaved editor text when remote content changes. Warn that saving it will become the newest server write.
- Preserve the loading, empty, error, and success-notice states when adding features.
- Avoid compatibility layers or storage migrations unless persisted production data creates a concrete need. If the manifest format changes, increment its version and implement an explicit migration.

## Verification

Always run frontend and backend checks after code changes:

```sh
bun run lint
bun run build
go test ./...
go vet ./...
```

For storage or interaction changes, browser-test this sequence:

1. Create and open a text file.
2. Edit and save it.
3. Rename it through the context menu.
4. Upload at least one file.
5. Drag an icon and reload the page.
6. Confirm names, contents, uploads, and positions persist.
7. Check the console for runtime errors.
8. Check desktop and approximately 390px-wide mobile layouts.

For synchronization or server changes, also verify:

1. Start `bun run server` and `bun run dev --host 127.0.0.1`.
2. Open two isolated browser sessions and confirm create, edit, rename, upload, move, and delete propagate through SSE.
3. Confirm concurrent writes to the same entry resolve in server receipt order while unrelated entry changes remain.
4. Stop the backend and confirm mutation controls disable while cached files remain viewable.
5. Restart the backend and confirm health polling reconnects and reconciles missed revisions.
6. Restart the Go process with the same data directory and confirm metadata, content, and revisions persist.
7. Check both clients' consoles for runtime errors.

For predefined desktop or export changes, also verify:

1. `bun run build` succeeds with `HIRAYA_PREDEFINED_DIR` unset.
2. `HIRAYA_PREDEFINED_DIR=examples/predefined bun run build` succeeds.
3. A fresh browser origin seeds the example, while an existing origin remains unchanged.
4. Seeded files can be edited and still contain the edit after reload.
5. Export produces a ZIP whose manifest and file bytes match the saved desktop.
6. Extracting the ZIP and building from its `hiraya-predefined` directory succeeds.
7. An uninitialized server is seeded from the browser's resulting desktop, while an initialized server overrides local predefined content.

Browser automation should use `agent-browser` with `--headed` when a display is available. In displayless environments, explicitly pass `--headed false`; the local agent-browser configuration may otherwise continue requesting a headed session.

## Common Shortcuts

- Use `bun run server` plus `bun run dev --host 127.0.0.1` for browser automation. Vite proxies `/api` to `127.0.0.1:8080`.
- Use a temporary `HIRAYA_DATA_DIR` for browser tests so development data is not modified.
- The hidden upload control remains accessible as a button named `Choose Files` in accessibility snapshots.
- Dispatch a bubbling `contextmenu` event during automation when the runner lacks a right-click command.
- Verify drag persistence by recording an icon's bounding box, dragging with pointer/mouse commands, reloading, and comparing the new box.
- Write all browser screenshots to the project folder's `.agent-screenshots/` directory; it is already ignored by source control.
- Keep temporary browser fixtures outside the project or in an ignored location.

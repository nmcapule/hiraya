# Hiraya Agent Guide

## Project Overview

Hiraya is a local-first mock desktop built with React, TypeScript, and Vite. Files and desktop metadata persist entirely in the browser through the Origin Private File System (OPFS). There is no backend, database, authentication, or cloud synchronization.

Use Bun for all package and script operations.

```sh
bun install
bun run dev
bun run lint
bun run build
```

## Architecture

- `src/App.tsx`: application state and orchestration for files, dialogs, uploads, errors, and open-file windows.
- `src/lib/opfs.ts`: the complete persistence boundary. Keep OPFS access out of components.
- `src/lib/predefined-manifest.ts`: shared predefined manifest types and validation used by build-time loading and browser export.
- `src/lib/predefined.ts`: browser-side ZIP export for saved desktops.
- `build/predefined.ts`: Vite virtual-module plugin that validates and bundles an optional predefined desktop.
- `src/components/FileIcon.tsx`: file type icons and pointer-based desktop dragging.
- `src/components/FileDialog.tsx`: create and rename forms.
- `src/components/FileWindow.tsx`: text editor and media/document previews.
- `src/components/ContextMenu.tsx`: right-click actions.
- `src/types.ts`: shared metadata and UI-state types.
- `src/styles.css`: the full visual system, wallpaper, responsive behavior, and motion fallbacks.

Prefer small changes within these existing modules. Do not introduce global state or a component framework unless the feature genuinely requires it.

## OPFS Invariants

- All browser storage operations go through `src/lib/opfs.ts`.
- User-facing names are metadata only. Physical files use stable UUIDs under the OPFS `files` directory.
- `.hiraya-manifest.json` stores manifest version, names, MIME types, sizes, timestamps, and icon positions.
- Renaming must update metadata only; never copy or rewrite file contents just to rename a file.
- Write file contents before adding their metadata to the manifest.
- Validate an entire multi-file upload, including duplicates within the batch, before writing any file.
- File names reject empty values, `.`, `..`, slashes, control characters, names over 180 characters, and case-insensitive duplicates.
- OPFS is origin-scoped. Changing the dev hostname or port can appear to lose data because it creates a different origin.
- OPFS requires a modern browser and a secure context, with `localhost` accepted for development.
- Browser site-data clearing removes all Hiraya files. Do not imply that OPFS is a backup service.

If adding destructive operations, update file content and the manifest carefully so failed operations do not leave visible entries pointing to missing data.

## Predefined Desktops

- `HIRAYA_PREDEFINED_DIR` is an optional compile-time environment variable. It must point to a directory inside the repository containing `manifest.json` and its referenced content.
- An unset or empty `HIRAYA_PREDEFINED_DIR` disables predefined content. Do not expose the source path to browser code or rename it with a `VITE_` prefix.
- The predefined manifest has its own version in `src/lib/predefined-manifest.ts`; it is distinct from the persisted OPFS manifest version.
- Keep the build loader and browser exporter on the same manifest schema and validation path. An exported package must be accepted directly by the build loader after extraction.
- File `contentUrl` values are relative to the configured directory. Reject absolute paths, traversal outside the directory, queries, fragments, missing files, size mismatches, and symbolic links.
- Predefined content seeds OPFS only when `.hiraya-manifest.json` does not exist. Never merge it into, replace, or restore entries in an existing manifest, including an intentionally empty manifest.
- Fetch and validate all predefined assets, then write file contents before publishing the complete OPFS manifest. Failed seeding must not expose metadata that points to missing content.
- Seeded entries are ordinary editable local entries. User edits, moves, renames, and deletions must persist without being reset from the bundled package.
- The menu-bar Export action packages the entire saved desktop as `hiraya-predefined.zip`, with `hiraya-predefined/manifest.json` and a logical `content` tree.
- Export includes persisted files, folders, empty folders, views, positions, layout, metadata, and editor settings. It intentionally excludes unsaved editor changes.
- Preserve stable entry and view IDs during export. Keep file reads for export inside the OPFS persistence boundary.
- `examples/predefined` is the canonical checked-in package example. Update it and `README.md` when the predefined format or setup changes.

## Interaction Rules

- Dragging deliberately avoids React state updates during pointer movement. `FileIcon` applies a direct `translate3d` transform and commits state plus OPFS metadata only on pointer release.
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

## State And Error Handling

- Treat OPFS calls as fallible and surface concise user-facing errors.
- Update React state only after successful create, import, and rename operations.
- Position updates are optimistic because dragging should feel immediate; show an error if persistence fails.
- Preserve the loading, empty, error, and success-notice states when adding features.
- Avoid compatibility layers or storage migrations unless persisted production data creates a concrete need. If the manifest format changes, increment its version and implement an explicit migration.

## Verification

Always run both checks after code changes:

```sh
bun run lint
bun run build
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

For predefined desktop or export changes, also verify:

1. `bun run build` succeeds with `HIRAYA_PREDEFINED_DIR` unset.
2. `HIRAYA_PREDEFINED_DIR=examples/predefined bun run build` succeeds.
3. A fresh browser origin seeds the example, while an existing origin remains unchanged.
4. Seeded files can be edited and still contain the edit after reload.
5. Export produces a ZIP whose manifest and file bytes match the saved desktop.
6. Extracting the ZIP and building from its `hiraya-predefined` directory succeeds.

Browser automation should use `agent-browser` with `--headed` when a display is available. In displayless environments, explicitly pass `--headed false`; the local agent-browser configuration may otherwise continue requesting a headed session.

## Common Shortcuts

- Use `bun run dev --host 127.0.0.1` for browser automation.
- The hidden upload control remains accessible as a button named `Choose Files` in accessibility snapshots.
- Dispatch a bubbling `contextmenu` event during automation when the runner lacks a right-click command.
- Verify drag persistence by recording an icon's bounding box, dragging with pointer/mouse commands, reloading, and comparing the new box.
- Write all browser screenshots to the project folder's `.agent-screenshots/` directory; it is already ignored by source control.
- Keep temporary browser fixtures outside the project or in an ignored location.

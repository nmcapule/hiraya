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

Browser automation should use `agent-browser` with `--headed` when a display is available. In displayless environments, explicitly pass `--headed false`; the local agent-browser configuration may otherwise continue requesting a headed session.

## Common Shortcuts

- Use `bun run dev --host 127.0.0.1` for browser automation.
- The hidden upload control remains accessible as a button named `Choose Files` in accessibility snapshots.
- Dispatch a bubbling `contextmenu` event during automation when the runner lacks a right-click command.
- Verify drag persistence by recording an icon's bounding box, dragging with pointer/mouse commands, reloading, and comparing the new box.
- Write all browser screenshots to the project folder's `.agent-screenshots/` directory; it is already ignored by source control.
- Keep temporary browser fixtures outside the project or in an ignored location.

# Hiraya

Hiraya is a local-first mock desktop. Its files and desktop metadata are stored in the browser's Origin Private File System (OPFS).

## Predefined desktop

Set `HIRAYA_PREDEFINED_DIR` at development or build time to bundle a predefined desktop:

```sh
HIRAYA_PREDEFINED_DIR=examples/predefined bun run dev
HIRAYA_PREDEFINED_DIR=examples/predefined bun run build
```

The value must be a directory inside the repository. It must contain a `manifest.json`; each file entry's `contentUrl` is resolved relative to that directory. See `examples/predefined` for the version 1 format.

The predefined desktop is copied into OPFS only when the browser origin has no Hiraya manifest. Existing desktops, including intentionally empty desktops, are never merged with or replaced. After seeding, predefined files and folders behave like ordinary editable local entries. Clearing the origin's site data removes the local desktop and allows it to be seeded again on the next load.

The build rejects malformed manifests, missing or size-mismatched content, paths outside the configured directory, and symbolic links.

## Export

Use **Export** in the menu bar to download `hiraya-predefined.zip`. The archive contains `hiraya-predefined/manifest.json` and its `content` tree. Extract that directory into the repository and pass it to `HIRAYA_PREDEFINED_DIR` to seed the exported desktop in a fresh browser origin.

Export includes all saved files, folders, views, icon positions, layout, and editor settings. Unsaved editor changes are not included.

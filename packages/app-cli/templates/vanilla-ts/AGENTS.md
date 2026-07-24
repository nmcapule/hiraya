# Hiraya App Author Guide

## Commands

Use Bun for all package operations. From this app directory:

```sh
bun install
bun run dev
bun test
bun run build
bun run package
```

`bun run dev` starts Vite for ordinary browser UI work, but host APIs are unavailable outside Hiraya. `bun run build` type-checks and creates `dist/`. `bun run package` builds, validates, and writes a deterministic `.hiraya.app` archive. Run the app through Hiraya to test the real sandbox and permissions.

This starter uses `workspace:*` for `@hiraya/apps-sdk` and `@hiraya/app-cli`, so it can be generated inside the Hiraya repository without publishing or changing the root lockfile. Keep those ranges while developing in this workspace.

## Sandbox Model

Hiraya loads the packaged app in a sandboxed iframe from package-owned blob URLs. The content security policy blocks network connections, remote scripts and styles, forms, plugins, and top-level navigation. Package every script, stylesheet, font, image, and media asset needed by the app. Do not rely on an origin, cookies, browser storage, OPFS, service workers, same-origin desktop internals, or direct access to `window.parent`.

The only supported host boundary is the typed `MessagePort` owned by `@hiraya/apps-sdk`. Treat the host and every event payload as asynchronous. Do not build a parallel `postMessage` protocol.

## Connection And Lifecycle

The app ID passed to `connectHiraya({ appId })` must exactly match `public/hiraya.app.json`. Keep it as a source constant so package identity changes are explicit.

```ts
const hiraya = await connectHiraya({ appId: "com.example.my-app" });
const launch = await hiraya.app.getLaunchContext();
```

Connect once during startup. Render a useful error if the handshake fails. Register event listeners after connecting, keep each unsubscribe function, and call the unsubscribers plus `hiraya.close()` on `pagehide`. Requests accept `AbortSignal` and timeout options; cancel work that no longer belongs to the current UI. A closed client rejects new requests with `UNAVAILABLE`.

Launch context contains the launch ID, source (`launcher`, `file`, `command`, or `restore`), arguments, initial theme, and file/folder handles. It is a snapshot for this launch, not global mutable state.

## Opaque Handles

`FileHandle` and `FolderHandle` are opaque capabilities, not paths. Never parse them, synthesize them, infer hierarchy from them, or persist assumptions about their string format. Obtain handles from launch context, dialogs, listing, or create operations. Use `files.stat` and `files.list` for current metadata. Names, parents, and coordinates can change without changing file identity.

Handles grant identity, while manifest permissions authorize operations. A handle can become stale or unavailable; handle `NOT_FOUND` and `PERMISSION_DENIED` normally.

## Revision-Safe Writes

Read or stat a file before editing and retain its `contentRevision`. Send that revision as `expectedRevision` when writing:

```ts
const entry = await hiraya.files.stat(handle);
if (entry.kind !== "file") throw new Error("Expected a file");
const result = await hiraya.files.read(handle);
const saved = await hiraya.files.write(handle, updatedBytes, {
  mimeType: result.mimeType,
  expectedRevision: entry.metadata.contentRevision,
});
```

Update the retained revision from the returned metadata after every successful write. A `CONFLICT` means another writer changed the content; do not blindly retry or overwrite. Reload and merge, save a copy, or ask the user. Set window dirty state while local edits are unsaved and clear it only after a confirmed write.

## Permissions

Declare only capabilities the app uses in `public/hiraya.app.json`. Undeclared methods fail with `PERMISSION_DENIED`.

| Permission | Host capabilities |
| --- | --- |
| `files:read` | Stat, read, and list granted files/folders |
| `files:write` | Write, create, rename, move, and delete entries |
| `dialogs` | Open/save pickers and confirmation dialogs |
| `window` | Window state, title, dirty state, size, fullscreen, and close |
| `commands` | Publish app commands and receive invocation events |
| `notifications` | Show/dismiss notifications and receive click events |
| `theme` | Read theme and follow theme changes |
| `storage` | App-local JSON storage |

Permissions are not a substitute for user intent. Prefer a dialog-acquired handle over broad traversal, confirm destructive actions, and avoid requesting write access for read-only apps.

## Commands

Publish the complete current command list with `hiraya.commands.set`. Command IDs are stable app-owned identifiers; titles are user-facing. Keep one `commands.invoked` subscription and dispatch by ID. Re-publish commands when enabled state or labels change, and call `commands.clear` when commands should no longer be offered.

Commands can be invoked while focus is elsewhere, so handlers must use current state and prevent overlapping destructive work. A shortcut is a hint to Hiraya, not a browser keydown replacement.

## Theme Variables

Use `launch.theme` immediately and subscribe to `theme.changed`. The starter maps host tokens to these app CSS variables:

```text
--hiraya-background
--hiraya-surface
--hiraya-surface-elevated
--hiraya-text
--hiraya-text-muted
--hiraya-border
--hiraya-accent
--hiraya-accent-text
--hiraya-danger
--hiraya-focus
```

It also sets `document.documentElement.dataset.theme` to `light` or `dark`. Use token variables rather than fixed colors where possible, preserve readable contrast, style `:focus-visible`, and honor `prefers-reduced-motion`. These variables are app conventions created by `applyTheme`; the sandbox does not inject them automatically.

## Local Data And Files

Use `hiraya.storage` for small app-private JSON preferences, drafts, counters, and UI state. Keys and values belong to this app and are not user-visible files. Storage may be cleared and can fail with `QUOTA_EXCEEDED`; it is not a database or a place for large binary content.

Use `hiraya.files` for user-owned documents that should appear in the desktop, be opened by other apps, or survive as portable content. Encode text explicitly with `TextEncoder`, decode it with `TextDecoder`, preserve MIME types, and use revision-safe writes. Do not put file handles or irreplaceable documents only in local storage.

## Errors

Catch `HirayaSdkError` at user-action boundaries and branch on `error.code`. Expected codes include `PERMISSION_DENIED`, `NOT_FOUND`, `ALREADY_EXISTS`, `CONFLICT`, `CANCELLED`, `OFFLINE`, `QUOTA_EXCEEDED`, `TIMEOUT`, and `UNAVAILABLE`. Show actionable messages for recoverable errors and preserve unsaved user input. Treat `INVALID_REQUEST` as an app bug. Log unexpected `INTERNAL` failures without exposing sensitive details.

Avoid empty catches and infinite automatic retries. Retry transient offline or unavailable work only with backoff and a cancellation path. User cancellation is not an error toast.

## Security

Treat launch arguments, filenames, file bytes, storage values, and notification/command events as untrusted input. Use `textContent`, not `innerHTML`, for untrusted strings. Validate decoded data before use. Never place secrets in the package, logs, URLs, command IDs, or local storage. The built app is inspectable by its user.

Do not add remote dependencies at runtime, weaken the sandbox, communicate directly with parent frames, or probe desktop internals. Keep package references relative and local. Avoid dynamic code execution such as `eval` and `new Function`. Revoke app-created object URLs when no longer needed and bound memory use when reading files.

## Tests

Keep unit tests next to source as `*.test.ts` and run them with `bun test`. Test pure state and encoding logic without a host. For SDK behavior, inject a `MessagePort` into `connectHiraya({ port })` and have the paired port return protocol responses; always close both ports.

Before packaging, run `bun test`, `bun run build`, and `bun run package`. Validate the archive with `hiraya-app validate <archive>`. In Hiraya, test startup, denied permissions, each launch source used by the app, command invocation, theme changes, dirty/save behavior, revision conflicts, offline/unavailable errors, reload persistence, window close cleanup, and both narrow and desktop-sized windows. Check the browser console for uncaught errors.

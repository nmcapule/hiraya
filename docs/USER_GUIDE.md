# Hiraya User Guide

This guide is included with Hiraya and remains available when the app shell is offline. Features can vary by browser, server configuration, and your role.

## Start here {#start-here}

Hiraya is a self-hosted, local-first workspace that presents files on a spatial desktop.

In a synchronized installation, the server is the authoritative home of desktops and files. The browser keeps a projected desktop, downloaded file copies, and queued changes so supported work can continue through a short outage. In browser-local mode, this browser is authoritative and clearing its site data removes your Hiraya content.

Use the desktop switcher for **named desktops**. Use [Areas](#desktops-and-areas) to move around within one desktop. Open Search to find files, folders, windows, commands, or the command that opens this guide.

## Files, folders, and hierarchy import {#files-and-folders}

Files and folders behave as a hierarchy even though root items can be placed anywhere on the desktop. Opening a folder shows its children and breadcrumb. Renaming, moving, or reorganizing an item does not rewrite its file content.

Use **Upload files** for individual files. Use **Import folder** to preserve a selected directory tree, including supported empty folders. Hiraya validates the complete import before making any part visible. Dragging a directory onto Hiraya also preserves its hierarchy in browsers that expose directory entries.

Some browsers do not provide directory picking or directory-drop details. When **Import folder** is unavailable, import files in supported batches and create the missing folders in Hiraya. A browser may expose files but omit empty directories; Hiraya reports this instead of pretending the tree was complete.

## Named desktops and derived areas {#desktops-and-areas}

A **desktop** is a named workspace with its own files, folders, appearance, sharing, and permissions. Use the desktop switcher to create, rename, switch, or delete desktops when your role allows it.

An **area** is a viewport-sized region derived from item and window coordinates on one continuous desktop. Areas are not named containers, folders, or separately saved records. Moving the last contents out of an area can make that derived area disappear.

Open **Areas** from the toolbar, navigation and tools menu, or command palette. There you can create an adjacent area, go to an area, move selected root items or the focused window, move an area's contents back to the current area, and arrange occupied areas. These explicit controls avoid relying on edge dragging, swiping, or long presses.

## Sharing, roles, and public links {#sharing}

Desktop owners and managers can open **Share desktop** when sharing is available.

- **Owner** controls the desktop.
- **Manager** can organize, edit, customize, and manage sharing.
- **Writer** can organize and edit files.
- **Reader** can browse and download without changing the desktop.

Invitations grant access to a specific person and can expire. A deployment may also grant a default role to all signed-in users.

A public link is different from membership: anyone who has its opaque URL can browse and download a read-only publication without signing in. Treat it as a secret. Rotate it to invalidate the previous URL, or unpublish to turn public access off. Public browsing does not expose private Settings, activity, or edit controls.

## Offline cache and pins {#offline}

In synchronized mode, the server remains authoritative. Opening a file may download a validated browser copy. Pin a file, folder, or selection with **Make available offline**; folder pins include current and new descendants. Open **Offline Storage** to inspect downloaded bytes, retry downloads, unpin roots, and release unpinned copies without deleting server files.

Offline availability is not a backup. Browser storage is origin-scoped: clearing site data, resetting the browser profile, uninstalling with data removal, private-browsing cleanup, or browser eviction can remove cached copies and queued changes. The origin-wide storage estimate may include Hiraya databases, app data, and other data for this origin, not only downloaded files.

Shared desktops have stricter offline rules. Cached shared content remains read-only, and shared writes require a connection so current permissions can be checked. A file that was not downloaded or pinned before going offline is unavailable until the connection returns.

## Installation and updates {#installation-and-updates}

Install Hiraya from **Settings > Install Hiraya** when an Install button is offered. Otherwise use the browser's **Install app** or **Add to Home Screen** command. Installation adds app-like launch and window behavior; it does not move authoritative data out of the server or protect browser-local data from site-data removal.

Production installations can check for updates in Settings. Automatic updates check in the background and ask before reloading. Save editor and app work before applying an update. If installation is unsupported, keep using Hiraya in a normal browser tab; all core workspace data remains in the same browser origin.

## `.hiraya.app` apps and permissions {#apps-and-permissions}

A file ending in `.hiraya.app` is an installable Hiraya app package. Open the package to review its name, version, and requested permissions before approving it. Unsupported or malformed packages are rejected rather than run.

Apps run isolated from Hiraya and the network except through approved host services. Permissions can include reading or writing only files and folders you grant, opening pickers, managing the app window, adding command-palette commands, showing notifications, reading the current theme, and using app-specific device-local storage. Permission approval is tied to the exact package version and digest; an update must be approved again.

Review installed apps and their permission names in **Settings > Apps**. Uninstalling removes approval and device-local app data, but does not delete the `.hiraya.app` package or files the app previously saved. Only install packages you trust.

## Export, operator backup, and recovery {#export-backup-and-recovery}

**Export deployment seed** creates a seeded ZIP containing the current desktop's saved files, folders, layout, appearance, and settings. It is an artifact for an operator or developer to seed a fresh frontend-only deployment. Unsaved editor changes are excluded.

Hiraya does not provide an in-product import or restore path for this seeded ZIP. It is not a personal desktop-package backup and cannot recover a synchronized installation. It does not preserve the complete catalog, accounts, sessions, sharing state, invitations, publications, activity, Trash, or server operational state.

Full synchronized recovery requires a server operator to use Hiraya's supported offline backup, verification, isolated restore, and restore-verification workflow. The operator guide is `docs/BACKUP_AND_RECOVERY.md` in the Hiraya server distribution. Ask your operator about backup frequency and the last tested restore. Users should not attempt recovery by copying browser cache files or server database files while the server is running.

## Troubleshooting {#troubleshooting}

### Sync blocked {#sync-blocked}

Open **Sync status** from the status button. A blocked queued change needs a decision before replay can continue. Read the affected item names and error, then retry after fixing the cause or discard only if you accept restoring the server version. Do not clear site data to fix sync; that can erase the queued change.

### Offline file unavailable {#offline-unavailable}

The file was not downloaded, its revision changed, or your shared access cannot be verified. Reconnect and open it, or pin it before the next outage. Check **Offline Storage** for failed downloads.

### Browser storage full {#storage-full}

Open **Offline Storage** and release unpinned downloaded copies. Its origin-wide estimate includes all storage reported for this Hiraya origin, not all browser profiles or sites. Remove other origin data only if you understand what it belongs to. Pending uploads, pinned copies, and authoritative browser-local files are protected by Hiraya; download important files individually before making broad storage changes.

### Permission denied or controls unavailable {#permissions}

Your reader, writer, manager, or owner role determines the controls shown. Shared writes require an online permission check. Reconnect, confirm you opened the intended desktop, and ask its owner or manager if your role is incorrect. A permission message is not a connection failure.

### Folder import unsupported {#folder-import-unsupported}

Try dragging the folder onto Hiraya. If the browser still cannot expose a hierarchy, upload supported file batches and recreate folders manually, or use a browser with directory-picker support. Empty directories cannot be inferred from a flat file list.

### Installation unavailable {#installation-unavailable}

Use Hiraya in a regular tab. Browser installation can require a secure deployment, a supported browser, and an installable production build. If no install command appears, use the browser's site menu or ask the operator whether installation is enabled.

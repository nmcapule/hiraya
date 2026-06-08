# Hiraya UX Audit Report

Date: 2026-06-08

## Scope

This audit reviewed the current Hiraya web app as a mobile-first code editor with file management, CodeMirror editing, previews, find/replace, and a host terminal. Evidence came from source review and rendered checks at 390x844 mobile and 1366x768 desktop using the running Go server.

## Evidence Captured

- Mobile drawer screenshot: `/tmp/hiraya-mobile-drawer.png`
- Mobile editor screenshot: `/tmp/hiraya-mobile-editor.png`
- Mobile terminal screenshot: `/tmp/hiraya-mobile-terminal.png`
- Desktop editor screenshot: `/tmp/hiraya-desktop-editor.png`
- Desktop terminal screenshot: `/tmp/hiraya-desktop-terminal.png`
- Accessibility snapshots from `agent-browser snapshot -i`

## Summary

Hiraya is already coherent as a compact remote coding tool. The main flows are present, the editor uses an appropriate proven engine, mobile touch targets are generally adequate, and terminal controls are unusually practical for phone usage.

The largest UX weaknesses are not missing features; they are interaction quality issues around discoverability, safety, accessibility, and responsive hierarchy. The app relies heavily on browser prompts, icon-only buttons, always-visible row actions, and dense topbar controls. These choices keep the implementation small, but they make the interface harder to learn, harder to operate safely, and less robust on small screens.

## Findings

### 1. Icon-only controls depend on `title` instead of explicit accessible labels

Severity: High

Evidence: Accessibility snapshots expose many controls by title, but the page root is announced as a long generic concatenation of unrelated content. Several structural areas lack explicit landmark labels. Icon-only buttons are visually understandable to a sighted user after repeated use, but screen reader and voice-control users need stable `aria-label` values.

Impact:

- Screen reader navigation is noisy and less predictable.
- Voice-control users cannot reliably target repeated row actions such as Rename and Delete.
- Tooltips are not available on touch devices, so `title` is weak as the only label source.

Recommended fix:

- Add `aria-label` to every icon-only button.
- Give repeated file row actions labels that include the filename, such as `Rename README.md`.
- Add `aria-label` or `aria-labelledby` to major regions: topbar, workspace, drawer, file list, accessory bar, terminal keybar.

### 2. The file drawer exposes destructive actions too prominently

Severity: High

Evidence: Every file and folder row permanently shows Rename and Delete buttons. On mobile this creates a dense grid where the red delete icon sits directly beside normal navigation targets.

Impact:

- Accidental destructive taps are more likely.
- The primary action, opening a file or folder, competes with secondary management actions.
- The drawer reads visually busy even for small project roots.

Recommended fix:

- Keep open/navigate as the dominant row action.
- Move Rename/Delete behind a row overflow menu or reveal them after selection.
- If that is too large for now, add stronger labels and spacing, and make Delete confirmation more explicit with the target type/name.

### 3. Browser prompts make file operations feel abrupt and hard to validate

Severity: Medium-high

Evidence: New file, new folder, rename, root change, delete confirmation, and folder replace use `window.prompt` or `window.confirm`.

Impact:

- Browser dialogs break the visual language of the app.
- Users cannot see helpful validation, path context, or consequences in the app UI.
- Mobile browser prompts vary by platform and can be awkward with small screens and virtual keyboards.

Recommended fix:

- Replace prompt/confirm usage with in-app dialogs for create, rename, delete, root change, and folder replace confirmation.
- Include clear titles, current path context, primary and cancel actions, and inline validation.

### 4. Mobile topbar is crowded and title hierarchy is fragile

Severity: Medium

Evidence: At 390x844 the topbar fits, but the active file title truncates to `READ...` while six controls remain visible. The mode toggle icon competes with the file title, and the title gets the smallest available space.

Impact:

- Users lose important context when editing similarly named files.
- Frequent actions are accessible, but the hierarchy favors controls over location/context.
- The interface becomes harder to scan on narrow devices.

Recommended fix:

- Keep Files, mode switch, Save, and Options visible.
- Move Undo/Redo/Search into Options or a secondary action strip on very narrow viewports.
- Add the full current path as a secondary line when space allows or in the options menu when it does not.

### 5. Desktop terminal keeps the mobile keybar visible

Severity: Medium

Evidence: At 1366x768 the terminal shows the mobile keybar at the bottom, consuming vertical space even though desktop users have a hardware keyboard.

Impact:

- Reduces terminal viewport height.
- Makes the desktop terminal look like a mobile adaptation rather than a polished desktop state.

Recommended fix:

- Hide the terminal keybar by default at desktop breakpoints.
- Offer an Options toggle to show it when desired.

### 6. Accessory bar creates horizontal page affordances that can be mistaken for content overflow

Severity: Medium

Evidence: At 390x844 the editor accessory bar scrolls horizontally and shows a visible horizontal scrollbar. This is understandable, but it competes with the editor's own horizontal behavior.

Impact:

- Users can confuse accessory scrolling with editor scrolling.
- The bar takes persistent vertical space even when the user may not need symbol insertion.

Recommended fix:

- Keep the accessory bar on mobile, but label it as an editor shortcuts region and tune overflow styling.
- Consider grouping symbols into a compact grid or allowing it to collapse.

### 7. Empty state is clear but not action-oriented enough

Severity: Low-medium

Evidence: The first screen says "Open a file from the drawer." The relevant drawer button is only an icon in the top-left.

Impact:

- New users must map text instruction to icon location.
- The first-use flow is slightly slower than necessary.

Recommended fix:

- Add an in-empty-state "Open files" button that opens the drawer.
- Keep the text short and avoid instructional clutter.

### 8. Error and status messaging lacks role semantics

Severity: Low-medium

Evidence: Error banner is visually clear but has no `role="alert"` or live region semantics. Save state changes are visual text only.

Impact:

- Assistive technology may not announce important failures or save state changes.
- Users relying on nonvisual feedback can miss the result of save or replace operations.

Recommended fix:

- Add `role="alert"` to error banners.
- Add `aria-live="polite"` to save/status text.

## Prioritized Improvement Plan

1. Accessibility hardening: explicit labels, landmarks, live regions, and repeated action names.
2. Mobile hierarchy pass: reduce visible topbar actions on small screens and improve file context.
3. File operation safety: replace browser dialogs with in-app dialogs, starting with delete and rename.
4. Desktop terminal polish: hide mobile terminal keybar by default at desktop breakpoints.
5. First-use and secondary control polish: action-oriented empty state and cleaner accessory overflow.

## Acceptance Criteria

- Icon-only controls have explicit accessible names without relying only on `title`.
- File row Rename/Delete controls include the target file or folder name in their accessible names.
- The error banner announces itself as an alert, and save state changes are live.
- At 390px width the title remains usable and the primary actions do not overflow.
- At desktop width the terminal has no unnecessary mobile keybar unless explicitly enabled or below the mobile breakpoint.
- The first empty editor state includes a direct way to open the file drawer.
- Build and automated tests pass.
- Browser screenshots verify mobile editor, mobile drawer, mobile terminal, desktop editor, and desktop terminal states after changes.

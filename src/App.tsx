import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CloudCheck, CloudSlash, FolderPlus, GearSix, HardDrive, Plus, SpinnerGap, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import seededDesktop from "virtual:hiraya-seeded";
import { ContextMenu } from "./components/ContextMenu";
import { FileDialog } from "./components/FileDialog";
import { FileIcon } from "./components/FileIcon";
import { FileWindow } from "./components/FileWindow";
import { FolderExplorer } from "./components/FolderExplorer";
import { MoveDialog } from "./components/MoveDialog";
import { SettingsWindow } from "./components/SettingsWindow";
import {
  createFolder,
  createTextFile,
  deleteEntry,
  importFiles,
  initializeDesktop,
  moveEntry,
  moveDesktopEntry,
  readFile,
  readFileByRelativePath,
  renameEntry,
  saveDesktopLayout,
  saveEditorSettings,
  saveTextFile,
  updateEntryPosition,
  subscribeToSync,
  stopDesktopSync,
  type SyncStatus,
} from "./lib/sync";
import { DEFAULT_EDITOR_SETTINGS } from "./lib/opfs";
import { exportSeededDesktop } from "./lib/seeded";
import { formatDesktopRoute, normalizeDesktopRoute, parseDesktopRoute, type DesktopRoute } from "./lib/routes";
import { DEFAULT_WALLPAPER, type ContextMenuState, type DesktopEntry, type DesktopLayout, type DialogState, type EditorSettings, type EntryPosition, type FileEntry } from "./types";
import { createEdgeWorkspaceLayout, desktopSlots, FILE_ICON_SIZE, GRID_ORIGIN, GRID_STEP, layoutForPageOrder, moveEntryToWorkspaceLayout, nextDesktopPosition, pagePositionTarget, responsiveDesktop, snapAxis } from "./ui/desktop-geometry";
import { fileCapabilities } from "./ui/file-capabilities";
import { topOverlay } from "./ui/overlay";
import { createWorkspaceIndex } from "./ui/workspace-index";

type OpenFile = { file: FileEntry; blob: File; editable: boolean; contentRevision: number; remoteChanged: boolean } | null;
type RouteHistoryState = { hiraya: true; parentHash?: string };
const MINIMAP_LONG_PRESS_MS = 500;

function formatClock(date: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function App() {
  const [entries, setEntries] = useState<DesktopEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [moveDialogEntryId, setMoveDialogEntryId] = useState<string | null>(null);
  const [moveDialogSubmitting, setMoveDialogSubmitting] = useState(false);
  const [openFile, setOpenFile] = useState<OpenFile>(null);
  const [route, setRoute] = useState<DesktopRoute | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [desktopSize, setDesktopSize] = useState(() => ({ width: window.innerWidth, height: Math.max(1, window.innerHeight - 44) }));
  const [layout, setLayout] = useState<DesktopLayout>(() => ({ rootOrder: [], workspaceBreaks: [], snapToGrid: false, wallpaper: DEFAULT_WALLPAPER }));
  const [editorSettings, setEditorSettings] = useState<EditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const [exporting, setExporting] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");
  const [editingViews, setEditingViews] = useState(false);
  const [draggedPageKey, setDraggedPageKey] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const desktopRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadParentRef = useRef<string | null>(null);
  const swipeRef = useRef<{ axis: "x" | "y" | null; pointerId: number; startIndex: number; startTime: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const minimapPointerRef = useRef<{
    activated: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    timer: number;
    pageKey: string;
    initialLayout: DesktopLayout;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const edgeDragRef = useRef({ direction: "", time: 0 });
  const edgeNavigationRef = useRef<{ route: DesktopRoute; historyState: unknown; originalLayout?: DesktopLayout; draftEntryId?: string } | null>(null);
  const layoutRef = useRef(layout);
  const entriesRef = useRef(entries);
  const routeRef = useRef<DesktopRoute | null>(null);
  const navigationReadyRef = useRef(false);
  const applyLocationRouteRef = useRef<(entriesValue?: DesktopEntry[], layoutValue?: DesktopLayout) => void>(() => undefined);
  const navigateRouteRef = useRef<(next: DesktopRoute, mode?: "push" | "replace") => void>(() => undefined);
  const closeToRouteRef = useRef<(next: DesktopRoute) => void>(() => undefined);
  const fileLoadGenerationRef = useRef(0);
  const openFileRef = useRef<OpenFile>(null);
  const layoutSaveRef = useRef<Promise<void>>(Promise.resolve());
  const editorSettingsSaveRef = useRef<Promise<void>>(Promise.resolve());
  const contentRevisionsRef = useRef<Record<string, number>>({});
  const openFileDirtyRef = useRef(false);
  const activePageIndex = route?.pageIndex ?? 0;
  const explorerFolderId = route?.explorerFolderId;
  const canMutate = syncStatus === "online" || syncStatus === "local";
  const workspace = useMemo(() => createWorkspaceIndex(entries), [entries]);
  const rootEntries = workspace.roots;
  const responsive = useMemo(() => responsiveDesktop(entries, layout.rootOrder, desktopSize, layout.workspaceBreaks), [desktopSize, entries, layout.rootOrder, layout.workspaceBreaks]);
  const pages = responsive.pages.length ? responsive.pages : [{ entries: [] }];
  const pageColumns = responsive.columns;
  const pageRows = responsive.rows;
  const page = { column: activePageIndex % pageColumns, row: Math.floor(activePageIndex / pageColumns) };
  const folders = workspace.folders;
  const explorerFolderEntry = explorerFolderId ? workspace.byId.get(explorerFolderId) : null;
  const explorerFolder = explorerFolderEntry?.kind === "folder" ? explorerFolderEntry : null;
  const explorerChildren = explorerFolderId === undefined ? [] : workspace.children.get(explorerFolder?.id ?? null) ?? [];
  const breadcrumbs = explorerFolder ? workspace.ancestors(explorerFolder.id) : [];
  const dialogEntry = dialog && (dialog.type === "rename" || dialog.type === "delete") ? workspace.byId.get(dialog.entryId) ?? null : null;
  const contextMenuEntry = contextMenu ? workspace.byId.get(contextMenu.entryId) ?? null : null;
  const moveDialogEntry = moveDialogEntryId ? workspace.byId.get(moveDialogEntryId) ?? null : null;
  function setCurrentRoute(next: DesktopRoute) {
    routeRef.current = next;
    setRoute(next);
  }

  function writeRoute(next: DesktopRoute, mode: "push" | "replace" = "push") {
    const hash = formatDesktopRoute(next);
    if (mode === "push" && hash !== window.location.hash) {
      const state: RouteHistoryState = { hiraya: true, parentHash: window.location.hash };
      window.history.pushState(state, "", hash);
    } else if (mode === "replace" || hash !== window.location.hash) {
      const current = window.history.state as Partial<RouteHistoryState> | null;
      const state: RouteHistoryState = { hiraya: true, parentHash: current?.hiraya ? current.parentHash : undefined };
      window.history.replaceState(state, "", hash);
    }
    setCurrentRoute(next);
  }

  function applyLocationRoute(entriesValue = entriesRef.current, layoutValue = layoutRef.current) {
    if (!navigationReadyRef.current) return;
    const pageCount = Math.max(1, responsiveDesktop(entriesValue, layoutValue.rootOrder, desktopSize, layoutValue.workspaceBreaks).pages.length);
    const normalized = normalizeDesktopRoute(parseDesktopRoute(window.location.hash), entriesValue, pageCount);
    if (!normalized) return;
    const canonicalHash = formatDesktopRoute(normalized);
    if (canonicalHash !== window.location.hash) writeRoute(normalized, "replace");
    else setCurrentRoute(normalized);
  }

  function navigateRoute(next: DesktopRoute, mode: "push" | "replace" = "push") {
    const pageCount = Math.max(1, responsiveDesktop(entriesRef.current, layoutRef.current.rootOrder, desktopSize, layoutRef.current.workspaceBreaks).pages.length);
    const normalized = normalizeDesktopRoute(next, entriesRef.current, pageCount);
    if (normalized) writeRoute(normalized, mode);
  }

  function closeToRoute(next: DesktopRoute) {
    const state = window.history.state as Partial<RouteHistoryState> | null;
    if (state?.hiraya && state.parentHash === formatDesktopRoute(next)) window.history.back();
    else navigateRoute(next, "replace");
  }

  function updateOpenFile(next: OpenFile) {
    openFileRef.current = next;
    setOpenFile(next);
  }

  applyLocationRouteRef.current = applyLocationRoute;
  navigateRouteRef.current = navigateRoute;
  closeToRouteRef.current = closeToRoute;

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeToSync((synced) => {
      if (!active) return;
      contentRevisionsRef.current = synced.sync.contentRevisions;
      layoutRef.current = synced.layout;
      entriesRef.current = synced.entries;
      setLayout(synced.layout);
      setEntries(synced.entries);
      setEditorSettings(synced.editorSettings);
      setLoading(false);
      setSelectedId((current) => current && !synced.entries.some((entry) => entry.id === current) ? null : current);
      const syncedIds = new Set(synced.entries.map((entry) => entry.id));
      setContextMenu((current) => current && !syncedIds.has(current.entryId) ? null : current);
      setMoveDialogEntryId((current) => current && !syncedIds.has(current) ? null : current);
      setDialog((current) => {
        if (!current) return null;
        if (current.type === "create-file" || current.type === "create-folder") {
          return current.parentId && !synced.entries.some((entry) => entry.id === current.parentId && entry.kind === "folder") ? null : current;
        }
        return syncedIds.has(current.entryId) ? current : null;
      });
      navigationReadyRef.current = true;
      applyLocationRouteRef.current(synced.entries, synced.layout);
    }, (nextStatus) => { if (active) setSyncStatus(nextStatus); });
    void initializeDesktop({ x: window.innerWidth, y: Math.max(1, window.innerHeight - 44) }, seededDesktop)
      .then(({ desktop: loadedDesktop, status: loadedStatus }) => {
        if (!active) return;
        const { entries: loadedEntries, layout: loadedLayout, editorSettings: loadedEditorSettings, sync } = loadedDesktop;
        contentRevisionsRef.current = sync.contentRevisions;
        layoutRef.current = loadedLayout;
        entriesRef.current = loadedEntries;
        setLayout(loadedLayout);
        setEntries(loadedEntries);
        setEditorSettings(loadedEditorSettings);
        setSyncStatus(loadedStatus);
        navigationReadyRef.current = true;
        applyLocationRouteRef.current(loadedEntries, loadedLayout);
      })
      .catch((loadError) => {
        if (active && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(loadError instanceof Error ? loadError.message : "Your files could not be loaded.");
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      unsubscribe();
      stopDesktopSync();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    function restoreRoute() {
      if (!navigationReadyRef.current) return;
      setDialog(null);
      setContextMenu(null);
      setMoveDialogEntryId(null);
      setEditingViews(false);
      setDraggedPageKey(null);
      setSettingsOpen(false);
      applyLocationRouteRef.current();
    }
    window.addEventListener("popstate", restoreRoute);
    window.addEventListener("hashchange", restoreRoute);
    return () => {
      window.removeEventListener("popstate", restoreRoute);
      window.removeEventListener("hashchange", restoreRoute);
    };
  }, []);

  useEffect(() => {
    const generation = ++fileLoadGenerationRef.current;
    const fileId = route?.fileId;
    if (!fileId || loading) {
      if (!fileId && openFileRef.current) updateOpenFile(null);
      return;
    }
    const entry = workspace.byId.get(fileId);
    const file = entry?.kind === "file" ? entry : null;
    if (!file) return;
    const expectedRevision = contentRevisionsRef.current[file.id] ?? 0;
    const current = openFileRef.current;
    if (current?.file.id === file.id && current.contentRevision === expectedRevision) {
      if (current.file !== file) updateOpenFile({ ...current, file });
      return;
    }
    if (current?.file.id === file.id && openFileDirtyRef.current) {
      updateOpenFile({ ...current, file, contentRevision: expectedRevision, remoteChanged: true });
      return;
    }
    void readFile(file.id).then((blob) => {
      if (generation !== fileLoadGenerationRef.current || routeRef.current?.fileId !== file.id || (contentRevisionsRef.current[file.id] ?? 0) !== expectedRevision) return;
      updateOpenFile({ file, blob, editable: fileCapabilities(file).editable, contentRevision: expectedRevision, remoteChanged: false });
    }).catch((openError) => {
      if (generation !== fileLoadGenerationRef.current || routeRef.current?.fileId !== file.id) return;
      if (openFileRef.current?.file.id === file.id) {
        setError("An open file changed on the server but could not be refreshed.");
        return;
      }
      setError(openError instanceof Error ? openError.message : "The file could not be opened.");
      const currentRoute = routeRef.current;
      if (currentRoute) navigateRouteRef.current({ ...currentRoute, fileId: undefined }, "replace");
    });
  }, [loading, route?.fileId, workspace]);

  useEffect(() => {
    function syncFullscreen() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  useEffect(() => {
    const desktop = desktopRef.current;
    if (!desktop) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(1, Math.round(entry.contentRect.width));
      const height = Math.max(1, Math.round(entry.contentRect.height));
      setDesktopSize((current) => current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(desktop);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    applyLocationRouteRef.current();
  }, [pages.length]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (editingViews && !(event.target as Element).closest?.(".desktop-minimap")) {
        setEditingViews(false);
        setDraggedPageKey(null);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [editingViews]);

  useEffect(() => {
    function closeMenu(event: MouseEvent) {
      if (!(event.target as Element).closest?.(".context-menu")) setContextMenu(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "r" && contextMenuEntry && canMutate) {
        setDialog({ type: "rename", entryId: contextMenuEntry.id });
        setContextMenu(null);
      }
    }
    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [canMutate, contextMenuEntry]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const owner = topOverlay({
        dialog: Boolean(dialog),
        moveDialog: Boolean(moveDialogEntry),
        settings: settingsOpen,
        contextMenu: Boolean(contextMenuEntry),
        file: Boolean(openFile),
        explorer: explorerFolderId !== undefined,
        viewEditor: editingViews,
      });
      if (!owner) return;
      if (owner === "moveDialog" && moveDialogSubmitting) return;
      event.preventDefault();
      if (owner === "dialog") setDialog(null);
      else if (owner === "moveDialog") setMoveDialogEntryId(null);
      else if (owner === "settings") setSettingsOpen(false);
      else if (owner === "contextMenu") setContextMenu(null);
      else if (owner === "viewEditor") { setEditingViews(false); setDraggedPageKey(null); }
      else {
        const current = routeRef.current;
        if (!current) return;
        if (owner === "file") closeToRouteRef.current({
          pageIndex: current.pageIndex,
          ...(current.explorerFolderId !== undefined ? { explorerFolderId: current.explorerFolderId } : {}),
        });
        else closeToRouteRef.current({ pageIndex: current.pageIndex });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenuEntry, dialog, editingViews, explorerFolderId, moveDialogEntry, moveDialogSubmitting, openFile, settingsOpen]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function childrenCount(parentId: string | null) {
    return parentId !== null ? workspace.children.get(parentId)?.length ?? 0 : pages[activePageIndex]?.entries.length ?? 0;
  }

  function positionFor(parentId: string | null) {
    if (parentId === null) {
      const slots = desktopSlots(desktopSize, pages.length > 1);
      return slots[childrenCount(null) % slots.length];
    }
    const position = nextDesktopPosition(childrenCount(parentId), window.innerHeight);
    return position;
  }

  function snapPositionInView(position: EntryPosition) {
    return {
      x: snapAxis(position.x, GRID_ORIGIN.x, GRID_STEP.x, Math.max(8, desktopSize.width - FILE_ICON_SIZE.width)),
      y: snapAxis(position.y, GRID_ORIGIN.y, GRID_STEP.y, Math.max(8, desktopSize.height - FILE_ICON_SIZE.height)),
    };
  }

  function snapDesktopPosition(position: EntryPosition) {
    const { column, row } = pagePositionTarget(pages.length, pageColumns, { x: desktopSize.width, y: desktopSize.height }, position);
    const local = snapPositionInView({
      x: position.x - column * desktopSize.width,
      y: position.y - row * desktopSize.height,
    });
    return {
      x: column * desktopSize.width + local.x,
      y: row * desktopSize.height + local.y,
    };
  }

  function placeRootIds(ids: string[]) {
    const added = new Set(ids);
    const current = layoutRef.current;
    const remaining = current.rootOrder.filter((id) => !added.has(id));
    const insertionIndex = Math.min(remaining.length, (activePageIndex + 1) * responsive.capacity);
    applyLayout({ ...current, rootOrder: [...remaining.slice(0, insertionIndex), ...ids, ...remaining.slice(insertionIndex)] });
  }

  function pageIndexForRoot(id: string) {
    const current = responsiveDesktop(entriesRef.current, layoutRef.current.rootOrder, desktopSize, layoutRef.current.workspaceBreaks);
    return Math.max(0, current.pages.findIndex((candidate) => candidate.entries.some((entry) => entry.id === id)));
  }

  function chooseUpload(parentId: string | null) {
    if (!canMutate) return;
    uploadParentRef.current = parentId;
    uploadRef.current?.click();
  }

  function applyLayout(next: DesktopLayout, persist = true) {
    if (persist && !canMutate) return;
    layoutRef.current = next;
    setLayout(next);
    if (!persist) return;
    layoutSaveRef.current = layoutSaveRef.current
      .then(() => saveDesktopLayout(next))
      .catch(() => { setError("The desktop view layout could not be saved."); });
  }

  function applyEditorSettings(next: EditorSettings) {
    if (!canMutate) return;
    setEditorSettings(next);
    editorSettingsSaveRef.current = editorSettingsSaveRef.current
      .then(() => saveEditorSettings(next))
      .catch(() => { setError("The editor settings could not be saved."); });
  }

  async function handleDialogSubmit(name: string) {
    if (!dialog || !canMutate) return;
    if (dialog.type === "create-file" || dialog.type === "create-folder") {
      const parentId = dialog.parentId;
      const created = dialog.type === "create-file"
        ? await createTextFile(name, parentId, positionFor(parentId))
        : await createFolder(name, parentId, positionFor(parentId));
      setEntries((current) => current.some((entry) => entry.id === created.id) ? current : [...current, created]);
      if (parentId === null) placeRootIds([created.id]);
      setSelectedId(created.id);
      if (parentId === null) goToPage(pageIndexForRoot(created.id));
      setNotice(`${created.name} created`);
    } else if (dialog.type === "rename") {
      if (!dialogEntry) { setDialog(null); return; }
      const renamed = await renameEntry(dialogEntry.id, name);
      setEntries((current) => current.map((entry) => entry.id === renamed.id ? renamed : entry));
      if (renamed.kind === "file" && openFileRef.current?.file.id === renamed.id) updateOpenFile({ ...openFileRef.current, file: renamed });
      setNotice(`${renamed.kind === "folder" ? "Folder" : "File"} renamed`);
    } else {
      if (!dialogEntry) { setDialog(null); return; }
      const deleted = await deleteEntry(dialogEntry.id);
      const deletedIds = new Set(deleted.map((entry) => entry.id));
      setEntries((current) => current.filter((entry) => !deletedIds.has(entry.id)));
      setSelectedId((current) => current && deletedIds.has(current) ? null : current);
      setNotice(`${dialogEntry.name} deleted`);
    }
    setDialog(null);
  }

  async function handleImport(sources: File[], parentId: string | null, base?: EntryPosition) {
    if (!sources.length || !canMutate) return;
    setError("");
    try {
      const offset = childrenCount(parentId);
      const slots = parentId === null ? desktopSlots(desktopSize, pages.length > 1 || offset + sources.length > responsive.capacity) : [];
      const positions = sources.map((_, index) => parentId === null
        ? base && index === 0 ? snapPositionInView(base) : slots[(offset + index) % slots.length]
        : nextDesktopPosition(offset + index, window.innerHeight, base));
      const imported = await importFiles(sources, parentId, positions);
      setEntries((current) => {
        const existingIds = new Set(current.map((entry) => entry.id));
        return [...current, ...imported.filter((entry) => !existingIds.has(entry.id))];
      });
      if (parentId === null) placeRootIds(imported.map((entry) => entry.id));
      setSelectedId(imported.at(-1)?.id ?? null);
      const lastImported = imported.at(-1);
      if (lastImported && parentId === null) goToPage(pageIndexForRoot(lastImported.id));
      setNotice(`${imported.length} ${imported.length === 1 ? "file" : "files"} added`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "The upload could not be completed.");
    }
  }

  async function handleDesktopMove(entry: DesktopEntry, position: EntryPosition, targetParentId: string | null) {
    if (!canMutate) return false;
    if (targetParentId) {
      const pending = edgeNavigationRef.current;
      if (pending?.originalLayout) applyLayout(pending.originalLayout, false);
      return handleMoveTo(entry, targetParentId, true);
    }
    const finalPosition = layoutRef.current.snapToGrid ? snapDesktopPosition(position) : position;
    const currentDesktop = responsiveDesktop(entriesRef.current, layoutRef.current.rootOrder, desktopSize, layoutRef.current.workspaceBreaks);
    const currentPages = currentDesktop.pages.length ? currentDesktop.pages : [{ entries: [] }];
    const target = pagePositionTarget(currentPages.length, currentDesktop.columns, { x: desktopSize.width, y: desktopSize.height }, finalPosition);
    const localPosition = {
      x: Math.max(8, finalPosition.x - target.column * desktopSize.width),
      y: Math.max(8, finalPosition.y - target.row * desktopSize.height),
    };
    setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, position: localPosition } : item));
    try {
      const pending = edgeNavigationRef.current;
      if (pending?.draftEntryId === entry.id) {
        await moveDesktopEntry(entry.id, localPosition, layoutRef.current);
        return true;
      }
      const nextLayout = moveEntryToWorkspaceLayout(layoutRef.current, currentPages, entry.id, target.index, currentDesktop.breakCapacity);
      if (nextLayout !== layoutRef.current) {
        applyLayout(nextLayout, false);
        await moveDesktopEntry(entry.id, localPosition, nextLayout);
        return true;
      }
      await updateEntryPosition(entry.id, localPosition);
      return true;
    } catch {
      const pending = edgeNavigationRef.current;
      if (pending?.originalLayout) applyLayout(pending.originalLayout, false);
      setError("The new icon position could not be saved.");
      return false;
    }
  }

  async function handleMoveTo(entry: DesktopEntry, parentId: string | null, bubbleError = false) {
    if (!canMutate) return false;
    setError("");
    try {
      if (entry.parentId === parentId) return true;
      const moved = await moveEntry(entry.id, parentId, positionFor(parentId));
      setEntries((current) => current.map((item) => item.id === moved.id ? moved : item));
      if (entry.parentId !== null && parentId === null) placeRootIds([moved.id]);
      setSelectedId(null);
      setContextMenu(null);
      setNotice(`${entry.name} moved`);
      return true;
    } catch (moveError) {
      const message = moveError instanceof Error ? moveError.message : "The item could not be moved.";
      setError(message);
      if (bubbleError) throw moveError;
      return false;
    }
  }

  function handleOpen(entry: DesktopEntry) {
    setContextMenu(null);
    const currentRoute = routeRef.current;
    if (!currentRoute) return;
    if (entry.kind === "folder") {
      navigateRoute({ ...currentRoute, explorerFolderId: entry.id, fileId: undefined });
      return;
    }
    setError("");
    navigateRoute({ ...currentRoute, fileId: entry.id });
  }

  async function download(file: FileEntry) {
    try {
      const blob = await readFile(file.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setContextMenu(null);
    } catch {
      setError("The file could not be downloaded.");
    }
  }

  async function handleExport() {
    setError("");
    setExporting(true);
    try {
      const archive = await exportSeededDesktop();
      const url = URL.createObjectURL(archive);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "hiraya-seeded.zip";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Saved desktop exported");
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "The desktop could not be exported.");
    } finally {
      setExporting(false);
    }
  }

  async function save(content: string) {
    const fileId = routeRef.current?.fileId;
    if (!openFileRef.current || openFileRef.current.file.id !== fileId) return;
    const saved = await saveTextFile(fileId, content);
    setEntries((current) => current.map((entry) => entry.id === saved.id ? saved : entry));
    const current = openFileRef.current;
    if (routeRef.current?.fileId === saved.id && current?.file.id === saved.id) {
      updateOpenFile({ ...current, file: saved, contentRevision: contentRevisionsRef.current[saved.id] ?? 0, remoteChanged: false });
    }
    setNotice(syncStatus === "local" ? "Changes saved locally" : "Changes synced");
  }

  function goToPage(pageIndex: number, mode: "push" | "replace" = "push") {
    const current = responsiveDesktop(entriesRef.current, layoutRef.current.rootOrder, desktopSize, layoutRef.current.workspaceBreaks);
    const pageCount = Math.max(1, current.pages.length);
    const index = Math.max(0, Math.min(pageCount - 1, pageIndex));
    const currentRoute = routeRef.current;
    if (!currentRoute) return;
    const column = index % current.columns;
    const row = Math.floor(index / current.columns);
    if (canvasRef.current) canvasRef.current.style.transform = `translate3d(${-column * desktopSize.width}px, ${-row * desktopSize.height}px, 0)`;
    navigateRoute({ ...currentRoute, pageIndex: index }, mode);
  }

  function handleDesktopPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".file-icon, .empty-state__actions")) return;
    event.preventDefault();
    swipeRef.current = { axis: null, pointerId: event.pointerId, startIndex: activePageIndex, startTime: performance.now(), startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
  }

  function handleIconDragAtEdge(entry: DesktopEntry, clientX: number, clientY: number) {
    const desktop = desktopRef.current;
    if (!desktop) return null;
    const bounds = desktop.getBoundingClientRect();
    const threshold = Math.min(36, Math.max(24, Math.min(bounds.width, bounds.height) * 0.06));
    const candidates = [
      { direction: "left", distance: clientX - bounds.left },
      { direction: "right", distance: bounds.right - clientX },
      { direction: "up", distance: clientY - bounds.top },
      { direction: "down", distance: bounds.bottom - clientY },
    ].filter((candidate) => candidate.distance <= threshold).sort((a, b) => a.distance - b.distance);
    const edge = candidates[0];
    if (!edge) {
      edgeDragRef.current.direction = "";
      return null;
    }
    const now = performance.now();
    if (edgeDragRef.current.direction === edge.direction && now - edgeDragRef.current.time < 520) return null;
    const previousIndex = activePageIndex;
    const previousColumn = previousIndex % pageColumns;
    const previousRow = Math.floor(previousIndex / pageColumns);
    const neighborIndex = edge.direction === "left" ? previousIndex - 1
      : edge.direction === "right" ? previousIndex + 1
        : edge.direction === "up" ? previousIndex - pageColumns
          : previousIndex + pageColumns;
    const hasNeighbor = edge.direction === "left" ? page.column > 0
      : edge.direction === "right" ? page.column < pageColumns - 1 && neighborIndex < pages.length
        : edge.direction === "up" ? neighborIndex >= 0
          : neighborIndex < pages.length;
    let targetIndex = neighborIndex;
    let targetColumns = pageColumns;
    let targetRows = pageRows;
    if (!hasNeighbor) {
      const pending = edgeNavigationRef.current;
      if (pending?.draftEntryId) return null;
      const originalLayout = layoutRef.current;
      const draftLayout = createEdgeWorkspaceLayout(originalLayout, pages, entry.id, activePageIndex, edge.direction === "left" || edge.direction === "up", responsive.breakCapacity);
      const draftDesktop = responsiveDesktop(entriesRef.current, draftLayout.rootOrder, desktopSize, draftLayout.workspaceBreaks);
      targetIndex = draftDesktop.pages.findIndex((candidate) => candidate.entries.some((item) => item.id === entry.id));
      if (targetIndex < 0 || draftDesktop.pages.length <= responsive.pages.length) return null;
      if (!edgeNavigationRef.current && routeRef.current) edgeNavigationRef.current = { route: routeRef.current, historyState: window.history.state };
      if (edgeNavigationRef.current) {
        edgeNavigationRef.current.originalLayout = originalLayout;
        edgeNavigationRef.current.draftEntryId = entry.id;
      }
      applyLayout(draftLayout, false);
      targetColumns = draftDesktop.columns;
      targetRows = draftDesktop.rows;
    } else if (!edgeNavigationRef.current && routeRef.current) {
      edgeNavigationRef.current = { route: routeRef.current, historyState: window.history.state };
    }
    targetIndex = Math.max(0, targetIndex);
    const nextColumn = targetIndex % targetColumns;
    const nextRow = Math.floor(targetIndex / targetColumns);
    edgeDragRef.current = { direction: edge.direction, time: now };
    goToPage(targetIndex, "replace");
    return {
      deltaX: (nextColumn - previousColumn) * desktopSize.width,
      deltaY: (nextRow - previousRow) * desktopSize.height,
      maxX: Math.max(8, targetColumns * desktopSize.width - FILE_ICON_SIZE.width),
      maxY: Math.max(8, targetRows * desktopSize.height - FILE_ICON_SIZE.height),
    };
  }

  function finishEdgeNavigation(cancelled: boolean) {
    const pending = edgeNavigationRef.current;
    edgeNavigationRef.current = null;
    edgeDragRef.current.direction = "";
    if (!pending) return;
    const finalRoute = routeRef.current;
    window.history.replaceState(pending.historyState, "", formatDesktopRoute(pending.route));
    if (cancelled || !finalRoute) {
      if (pending.originalLayout) applyLayout(pending.originalLayout, false);
      setCurrentRoute(pending.route);
      return;
    }
    writeRoute(finalRoute, "push");
  }

  function handleDesktopPointerMove(event: React.PointerEvent<HTMLElement>) {
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId || !canvasRef.current) return;
    swipe.x = event.clientX;
    swipe.y = event.clientY;
    const deltaX = swipe.x - swipe.startX;
    const deltaY = swipe.y - swipe.startY;
    if (!swipe.axis) {
      if (Math.hypot(deltaX, deltaY) < 7) return;
      swipe.axis = Math.abs(deltaX) >= Math.abs(deltaY) ? "x" : "y";
      canvasRef.current.dataset.swiping = "true";
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const startColumn = swipe.startIndex % pageColumns;
    const startRow = Math.floor(swipe.startIndex / pageColumns);
    const x = -startColumn * desktopSize.width + (swipe.axis === "x" ? deltaX : 0);
    const y = -startRow * desktopSize.height + (swipe.axis === "y" ? deltaY : 0);
    const clampedX = Math.max(-(pageColumns - 1) * desktopSize.width, Math.min(0, x));
    const clampedY = Math.max(-(pageRows - 1) * desktopSize.height, Math.min(0, y));
    canvasRef.current.style.transform = `translate3d(${clampedX}px, ${clampedY}px, 0)`;
  }

  function finishDesktopSwipe(event: React.PointerEvent<HTMLElement>) {
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const delta = swipe.axis === "x" ? swipe.x - swipe.startX : swipe.y - swipe.startY;
    const distance = swipe.axis === "x" ? desktopSize.width : desktopSize.height;
    const velocity = Math.abs(delta) / Math.max(1, performance.now() - swipe.startTime);
    const advance = swipe.axis && (Math.abs(delta) > distance * 0.16 || velocity > 0.45) ? (delta < 0 ? 1 : -1) : 0;
    let nextIndex = swipe.startIndex;
    if (swipe.axis === "x") nextIndex += advance;
    if (swipe.axis === "y") nextIndex += advance * pageColumns;
    suppressClickRef.current = swipe.axis !== null;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    swipeRef.current = null;
    if (canvasRef.current) delete canvasRef.current.dataset.swiping;
    nextIndex = Math.max(0, Math.min(pages.length - 1, nextIndex));
    goToPage(nextIndex);
  }

  function movePage(pageKey: string, targetIndex: number, persist = true) {
    const current = layoutRef.current;
    const currentPages = responsiveDesktop(entriesRef.current, current.rootOrder, desktopSize, current.workspaceBreaks).pages;
    const sourceIndex = currentPages.findIndex((candidate) => candidate.entries[0]?.id === pageKey);
    const boundedTarget = Math.max(0, Math.min(currentPages.length - 1, targetIndex));
    if (sourceIndex < 0 || sourceIndex === boundedTarget) return;
    const chunks = currentPages.map((candidate) => candidate.entries.map((entry) => entry.id));
    const [moved] = chunks.splice(sourceIndex, 1);
    chunks.splice(boundedTarget, 0, moved);
    applyLayout(layoutForPageOrder(current, chunks, responsive.breakCapacity), persist);
  }

  function startMinimapPress(event: React.PointerEvent<HTMLButtonElement>, pageKey: string) {
    if (event.button !== 0 || !canMutate) return;
    const press = {
      activated: editingViews,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
      pageKey,
      initialLayout: structuredClone(layoutRef.current),
    };
    press.timer = window.setTimeout(() => {
      press.activated = true;
      setEditingViews(true);
      setDraggedPageKey(pageKey);
      suppressClickRef.current = true;
    }, editingViews ? 0 : MINIMAP_LONG_PRESS_MS);
    minimapPointerRef.current = press;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveMinimapPress(event: React.PointerEvent<HTMLButtonElement>) {
    const press = minimapPointerRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (!press.activated && Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > 7) {
      window.clearTimeout(press.timer);
      minimapPointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (!press.activated) return;
    const target = document.elementsFromPoint(event.clientX, event.clientY)
      .map((element) => element.closest<HTMLElement>("[data-page-key]"))
      .find(Boolean);
    if (!target?.dataset.pageKey) return;
    const currentPages = responsiveDesktop(entriesRef.current, layoutRef.current.rootOrder, desktopSize, layoutRef.current.workspaceBreaks).pages;
    const targetIndex = currentPages.findIndex((candidate) => candidate.entries[0]?.id === target.dataset.pageKey);
    movePage(press.pageKey, targetIndex, false);
  }

  function finishMinimapPress(event: React.PointerEvent<HTMLButtonElement>, cancelled = false) {
    const press = minimapPointerRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    window.clearTimeout(press.timer);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    minimapPointerRef.current = null;
    if (press.activated && cancelled) {
      applyLayout(press.initialLayout, false);
      setDraggedPageKey(null);
    } else if (press.activated) {
      applyLayout(layoutRef.current);
      setDraggedPageKey(null);
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    } else if (!cancelled) {
      const currentPages = responsiveDesktop(entriesRef.current, layoutRef.current.rootOrder, desktopSize, layoutRef.current.workspaceBreaks).pages;
      goToPage(Math.max(0, currentPages.findIndex((candidate) => candidate.entries[0]?.id === press.pageKey)));
    }
  }

  function invalidMoveIds(entry: DesktopEntry) {
    return new Set([entry.id, ...workspace.descendants(entry.id).map((descendant) => descendant.id)]);
  }

  async function toggleFullscreen() {
    setError("");
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setError("Fullscreen mode could not be changed.");
    }
  }

  return (
    <main className="desktop-shell">
      <header className="menu-bar">
        <div className="brand-mark" aria-label="Hiraya Desktop"><span className="brand-mark__shape"><span /></span><strong>Hiraya</strong></div>
        <div className="menu-bar__actions">
          <button type="button" aria-label="New file" disabled={!canMutate} onClick={() => setDialog({ type: "create-file", parentId: null })}><Plus size={15} weight="bold" /> <span>New file</span></button>
          <button type="button" aria-label="New folder" disabled={!canMutate} onClick={() => setDialog({ type: "create-folder", parentId: null })}><FolderPlus size={16} /> <span>New folder</span></button>
          <button type="button" aria-label="Upload files" disabled={!canMutate} onClick={() => chooseUpload(null)}><UploadSimple size={16} /> <span>Upload</span></button>
          <button type="button" aria-label="Open settings" title="Settings" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}><GearSix size={16} /> <span>Settings</span></button>
          <span className="menu-bar__sync" data-status={syncStatus} title={syncStatus === "local" ? "Changes are saved in this browser" : syncStatus === "online" ? "Changes are synced" : syncStatus === "connecting" ? "Connecting to sync server" : "Sync server unavailable; editing is disabled"}>
            {syncStatus === "local" ? <HardDrive size={15} /> : syncStatus === "online" ? <CloudCheck size={15} /> : syncStatus === "connecting" ? <SpinnerGap size={15} /> : <CloudSlash size={15} />}
            <span>{syncStatus === "local" ? "Saved locally" : syncStatus === "online" ? "Synced" : syncStatus === "connecting" ? "Connecting" : "Offline"}</span>
          </span>
          <span className="menu-bar__clock">{formatClock(clock)}</span>
        </div>
      </header>

      <section
        className="desktop"
        data-wallpaper={layout.wallpaper}
        ref={desktopRef}
        aria-label="Desktop"
        onClickCapture={(event) => {
          if (!suppressClickRef.current) return;
          suppressClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => { if (!(event.target as Element).closest(".file-icon, .empty-state__actions")) setSelectedId(null); }}
        onContextMenu={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }}
        onDragOver={(event) => { if (!canMutate) return; event.preventDefault(); event.currentTarget.dataset.dropActive = "true"; }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) delete event.currentTarget.dataset.dropActive; }}
        onDrop={(event) => {
          if (!canMutate) return;
          event.preventDefault();
          delete event.currentTarget.dataset.dropActive;
          const bounds = event.currentTarget.getBoundingClientRect();
          void handleImport(Array.from(event.dataTransfer.files), null, {
            x: event.clientX - bounds.left - 42,
            y: event.clientY - bounds.top - 42,
          });
        }}
        onPointerDown={handleDesktopPointerDown}
        onPointerMove={handleDesktopPointerMove}
        onPointerUp={finishDesktopSwipe}
        onPointerCancel={finishDesktopSwipe}
      >
        <div className="wallpaper-grain" aria-hidden="true" />
        <div className="desktop-canvas" ref={canvasRef} style={{ width: pageColumns * desktopSize.width, height: pageRows * desktopSize.height, transform: `translate3d(${-page.column * desktopSize.width}px, ${-page.row * desktopSize.height}px, 0)` }}>
          {pages.flatMap((desktopPage, pageIndex) => desktopPage.entries.map((entry) => {
            const viewColumn = pageIndex % pageColumns;
            const viewRow = Math.floor(pageIndex / pageColumns);
            const projectedPosition = responsive.positions.get(entry.id) ?? entry.position;
            const renderedEntry = {
              ...entry,
              position: {
                x: viewColumn * desktopSize.width + projectedPosition.x,
                y: viewRow * desktopSize.height + projectedPosition.y,
              },
            };
            return <FileIcon
              key={entry.id}
              entry={renderedEntry}
              selected={selectedId === entry.id}
              onSelect={() => setSelectedId(entry.id)}
              onOpen={() => void handleOpen(entry)}
              onMove={(position, targetParentId) => handleDesktopMove(entry, position, targetParentId)}
              onDragAtEdge={(clientX, clientY) => handleIconDragAtEdge(entry, clientX, clientY)}
              onDragEnd={finishEdgeNavigation}
              getSnapPreview={layout.snapToGrid ? snapDesktopPosition : undefined}
              onExternalDrop={(sources) => void handleImport(sources, entry.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedId(entry.id);
                setContextMenu({ entryId: entry.id, x: event.clientX, y: event.clientY });
              }}
            />;
          }))}
        </div>

        {loading && <div className="desktop-state desktop-state--loading" aria-live="polite"><span className="loading-line" /><span className="loading-line loading-line--short" /></div>}
        {!loading && !error && rootEntries.length === 0 && (
          <div className="desktop-state empty-state">
            <span className="empty-state__icon"><HardDrive size={28} weight="duotone" /></span>
            <h1>Your space is ready.</h1>
            <p>Create a note or folder, or drop a file anywhere. Everything stays in this browser.</p>
            <div className="empty-state__actions">
              <button className="button button--primary" type="button" disabled={!canMutate} onClick={() => setDialog({ type: "create-file", parentId: null })}><Plus size={17} /> New file</button>
              <button className="button button--quiet" type="button" disabled={!canMutate} onClick={() => setDialog({ type: "create-folder", parentId: null })}><FolderPlus size={17} /> New folder</button>
              <button className="button button--quiet" type="button" disabled={!canMutate} onClick={() => chooseUpload(null)}><UploadSimple size={17} /> Upload</button>
            </div>
          </div>
        )}
        <div className="drop-message" aria-hidden="true"><UploadSimple size={25} /> Drop files to store them privately</div>
      </section>

      {(pageColumns > 1 || pageRows > 1) && (
        <nav className="desktop-minimap" data-editing={editingViews || undefined} aria-label="Desktop workspaces">
          {editingViews && (
            <div className="desktop-minimap__toolbar">
              <span>Arrange workspaces</span>
              <button type="button" onClick={() => { setEditingViews(false); setDraggedPageKey(null); }}><Check size={12} /> Done</button>
            </div>
          )}
          <div className="desktop-minimap__grid" style={{ "--minimap-columns": pageColumns, "--minimap-rows": pageRows } as React.CSSProperties}>
            {pages.map((desktopPage, index) => {
              const column = index % pageColumns;
              const row = Math.floor(index / pageColumns);
              const pageKey = desktopPage.entries[0]?.id ?? `page-${index}`;
              return (
                <div className="desktop-minimap__slot" data-page-key={pageKey} data-dragging={draggedPageKey === pageKey || undefined} key={pageKey}>
                  <button
                    className="desktop-minimap__page"
                    data-active={index === activePageIndex || undefined}
                    type="button"
                    aria-label={`Workspace ${row + 1}, ${column + 1}${editingViews ? ", use arrow keys to move" : ", long press to arrange"}`}
                    aria-current={index === activePageIndex ? "true" : undefined}
                    onClick={(event) => { if (event.detail === 0 && !editingViews) goToPage(index); }}
                    onContextMenu={(event) => { event.preventDefault(); setEditingViews(true); }}
                    onPointerDown={(event) => startMinimapPress(event, pageKey)}
                    onPointerMove={moveMinimapPress}
                    onPointerUp={(event) => finishMinimapPress(event)}
                    onPointerCancel={(event) => finishMinimapPress(event, true)}
                    onKeyDown={(event) => {
                      if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
                        event.preventDefault();
                        setEditingViews(true);
                      } else if (editingViews && (event.key === "ArrowLeft" || event.key === "ArrowUp")) {
                        event.preventDefault();
                        movePage(pageKey, index - 1);
                      } else if (editingViews && (event.key === "ArrowRight" || event.key === "ArrowDown")) {
                        event.preventDefault();
                        movePage(pageKey, index + 1);
                      }
                    }}
                  >
                    {desktopPage.entries.map((entry) => {
                      const position = responsive.positions.get(entry.id) ?? entry.position;
                      return <span className="desktop-minimap__file" key={entry.id} style={{ left: `${position.x / desktopSize.width * 100}%`, top: `${position.y / desktopSize.height * 100}%` }} />;
                    })}
                  </button>
                </div>
              );
            })}
          </div>
          <span className="visually-hidden" aria-live="polite">Desktop workspace row {page.row + 1} of {pageRows}, column {page.column + 1} of {pageColumns}</span>
        </nav>
      )}

      <input ref={uploadRef} className="visually-hidden" type="file" multiple onChange={(event) => {
        void handleImport(Array.from(event.target.files ?? []), uploadParentRef.current);
        event.target.value = "";
      }} />

      {error && <div className="error-banner" role="alert"><WarningCircle size={19} weight="fill" /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">Dismiss</button></div>}
      {notice && <div className="notice" role="status">{notice}</div>}

      {explorerFolderId !== undefined && !openFile && (
        <FolderExplorer
          folder={explorerFolder}
          breadcrumbs={breadcrumbs}
          children={explorerChildren}
          onClose={() => { const current = routeRef.current; if (current) closeToRoute({ pageIndex: current.pageIndex }); }}
          onNavigate={(folder) => { const current = routeRef.current; if (current) navigateRoute({ ...current, explorerFolderId: folder?.id ?? null, fileId: undefined }); }}
          onOpen={handleOpen}
          onCreateFolder={(parentId) => setDialog({ type: "create-folder", parentId })}
          onCreateFile={(parentId) => setDialog({ type: "create-file", parentId })}
          onUpload={chooseUpload}
          onMove={(entry, parentId) => void handleMoveTo(entry, parentId)}
          onContextMenu={(entry, x, y) => setContextMenu({ entryId: entry.id, x, y })}
          readOnly={!canMutate}
        />
      )}

      {contextMenu && contextMenuEntry && (
        <ContextMenu
          menu={contextMenu}
          entry={contextMenuEntry}
          onOpen={() => handleOpen(contextMenuEntry)}
          onRename={() => { setDialog({ type: "rename", entryId: contextMenuEntry.id }); setContextMenu(null); }}
          onDownload={contextMenuEntry.kind === "file" ? () => void download(contextMenuEntry) : undefined}
          onMove={() => { setMoveDialogSubmitting(false); setMoveDialogEntryId(contextMenuEntry.id); setContextMenu(null); }}
          onDelete={() => { setDialog({ type: "delete", entryId: contextMenuEntry.id }); setContextMenu(null); }}
          readOnly={!canMutate}
        />
      )}
      {dialog && (!(dialog.type === "rename" || dialog.type === "delete") || dialogEntry) && <FileDialog dialog={dialog} entry={dialogEntry} onClose={() => setDialog(null)} onSubmit={handleDialogSubmit} />}
      {moveDialogEntry && (
        <MoveDialog
          entry={moveDialogEntry}
          folders={folders}
          invalidIds={invalidMoveIds(moveDialogEntry)}
          onClose={() => { setMoveDialogSubmitting(false); setMoveDialogEntryId(null); }}
          onMove={async (parentId) => { await handleMoveTo(moveDialogEntry, parentId, true); setMoveDialogSubmitting(false); setMoveDialogEntryId(null); }}
          onSubmittingChange={setMoveDialogSubmitting}
        />
      )}
      {settingsOpen && (
        <SettingsWindow
          layout={layout}
          canMutate={canMutate}
          exportDisabled={loading}
          exporting={exporting}
          fullscreenEnabled={document.fullscreenEnabled}
          isFullscreen={isFullscreen}
          onClose={() => setSettingsOpen(false)}
          onLayoutChange={applyLayout}
          onExport={() => void handleExport()}
          onToggleFullscreen={() => void toggleFullscreen()}
        />
      )}
      {openFile && (
        <FileWindow
          key={openFile.file.id}
          file={openFile.file}
          blob={openFile.blob}
          editable={openFile.editable}
          readOnly={!canMutate}
          remoteChanged={openFile.remoteChanged}
          editorSettings={editorSettings}
          onClose={() => {
            const current = routeRef.current;
            if (!current) return;
            closeToRoute({
              pageIndex: current.pageIndex,
              ...(current.explorerFolderId !== undefined ? { explorerFolderId: current.explorerFolderId } : {}),
            });
          }}
          onSave={save}
          onDownload={() => void download(openFile.file)}
          onEditorSettingsChange={applyEditorSettings}
          onResolveLink={(path) => readFileByRelativePath(openFile.file.id, path)}
          onOpenLinkedFile={handleOpen}
          onDirtyChange={(dirty) => { openFileDirtyRef.current = dirty; }}
        />
      )}
    </main>
  );
}

export default App;

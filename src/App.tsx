import { useEffect, useRef, useState } from "react";
import { Check, CloudCheck, CloudSlash, CornersIn, CornersOut, ExportIcon, FolderPlus, GridFour, HardDrive, Plus, SpinnerGap, Trash, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import predefinedDesktop from "virtual:hiraya-predefined";
import { ContextMenu } from "./components/ContextMenu";
import { FileDialog } from "./components/FileDialog";
import { FileIcon } from "./components/FileIcon";
import { FileWindow } from "./components/FileWindow";
import { FolderExplorer } from "./components/FolderExplorer";
import { MoveDialog } from "./components/MoveDialog";
import {
  createFolder,
  createTextFile,
  deleteEntry,
  importFiles,
  initializeDesktop,
  moveEntry,
  readFile,
  readFileByRelativePath,
  renameEntry,
  saveDesktopLayout,
  saveEditorSettings,
  saveTextFile,
  updateEntryPosition,
  subscribeToSync,
  type SyncStatus,
} from "./lib/sync";
import { DEFAULT_EDITOR_SETTINGS } from "./lib/opfs";
import { exportPredefinedDesktop } from "./lib/predefined";
import { formatDesktopRoute, normalizeDesktopRoute, parseDesktopRoute, type DesktopRoute } from "./lib/routes";
import type { ContextMenuState, DesktopEntry, DesktopLayout, DialogState, EditorSettings, EntryPosition, FileEntry, FolderEntry } from "./types";

type OpenFile = { file: FileEntry; blob: File; editable: boolean; contentRevision: number; remoteChanged: boolean } | null;
type RouteHistoryState = { hiraya: true; parentHash?: string };
const FILE_ICON_WIDTH = 98;
const FILE_ICON_HEIGHT = 102;
const GRID_ORIGIN = { x: 22, y: 22 };
const GRID_STEP = { x: 104, y: 112 };
const MINIMAP_LONG_PRESS_MS = 500;
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "js", "jsx", "ts", "tsx", "css", "html", "xml", "csv", "yaml", "yml"]);

function isEditable(file: FileEntry) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.mimeType.startsWith("text/") || file.mimeType.includes("json") || TEXT_EXTENSIONS.has(extension);
}

function formatClock(date: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function nextPosition(index: number, base?: EntryPosition) {
  if (base) return { x: Math.max(12, base.x + (index % 4) * 18), y: Math.max(12, base.y + (index % 4) * 18) };
  const rows = Math.max(1, Math.floor((window.innerHeight - 130) / 112));
  return { x: 22 + Math.floor(index / rows) * 104, y: 22 + (index % rows) * 112 };
}

function snapAxis(value: number, origin: number, step: number, max: number) {
  if (max <= origin) return Math.max(8, max);
  const index = Math.max(0, Math.min(Math.floor((max - origin) / step), Math.round((value - origin) / step)));
  return origin + index * step;
}

function App() {
  const [entries, setEntries] = useState<DesktopEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [moveDialogEntry, setMoveDialogEntry] = useState<DesktopEntry | null>(null);
  const [openFile, setOpenFile] = useState<OpenFile>(null);
  const [route, setRoute] = useState<DesktopRoute | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [desktopSize, setDesktopSize] = useState(() => ({ width: window.innerWidth, height: Math.max(1, window.innerHeight - 44) }));
  const [layout, setLayout] = useState<DesktopLayout>(() => ({ views: [{ id: crypto.randomUUID() }], columns: 1, snapToGrid: false }));
  const [editorSettings, setEditorSettings] = useState<EditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const [exporting, setExporting] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");
  const [editingViews, setEditingViews] = useState(false);
  const [draggedViewId, setDraggedViewId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));
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
    viewId: string;
    initialViews: DesktopLayout["views"];
  } | null>(null);
  const suppressClickRef = useRef(false);
  const edgeDragRef = useRef({ direction: "", time: 0 });
  const edgeNavigationRef = useRef<{ route: DesktopRoute; historyState: unknown } | null>(null);
  const layoutRef = useRef(layout);
  const entriesRef = useRef(entries);
  const routeRef = useRef<DesktopRoute | null>(null);
  const navigationReadyRef = useRef(false);
  const applyLocationRouteRef = useRef<(entriesValue?: DesktopEntry[], layoutValue?: DesktopLayout) => void>(() => undefined);
  const navigateRouteRef = useRef<(next: DesktopRoute, mode?: "push" | "replace") => void>(() => undefined);
  const fileLoadGenerationRef = useRef(0);
  const openFileRef = useRef<OpenFile>(null);
  const layoutSaveRef = useRef<Promise<void>>(Promise.resolve());
  const editorSettingsSaveRef = useRef<Promise<void>>(Promise.resolve());
  const contentRevisionsRef = useRef<Record<string, number>>({});
  const openFileDirtyRef = useRef(false);
  const activeViewId = route?.viewId ?? "";
  const explorerFolderId = route?.explorerFolderId;
  const canMutate = syncStatus === "online";
  const rootEntries = entries.filter((entry) => entry.parentId === null);
  const folders = entries.filter((entry): entry is FolderEntry => entry.kind === "folder");
  const explorerFolder = explorerFolderId === null ? null : folders.find((folder) => folder.id === explorerFolderId) ?? null;
  const explorerChildren = explorerFolderId === undefined ? [] : entries.filter((entry) => entry.parentId === (explorerFolder?.id ?? null));
  const breadcrumbs: FolderEntry[] = [];
  if (explorerFolder) {
    const parents: FolderEntry[] = [];
    let parentId = explorerFolder.parentId;
    while (parentId) {
      const parent = folders.find((folder) => folder.id === parentId);
      if (!parent) break;
      parents.unshift(parent);
      parentId = parent.parentId;
    }
    breadcrumbs.push(...parents);
  }

  const pageColumns = Math.max(1, Math.min(layout.columns, layout.views.length));
  const pageRows = Math.ceil(layout.views.length / pageColumns);
  const activeViewIndex = Math.max(0, layout.views.findIndex((view) => view.id === activeViewId));
  const page = { column: activeViewIndex % pageColumns, row: Math.floor(activeViewIndex / pageColumns) };

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
    const normalized = normalizeDesktopRoute(parseDesktopRoute(window.location.hash), entriesValue, layoutValue);
    if (!normalized) return;
    const canonicalHash = formatDesktopRoute(normalized);
    if (canonicalHash !== window.location.hash) writeRoute(normalized, "replace");
    else setCurrentRoute(normalized);
  }

  function navigateRoute(next: DesktopRoute, mode: "push" | "replace" = "push") {
    const normalized = normalizeDesktopRoute(next, entriesRef.current, layoutRef.current);
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
      setSelectedId((current) => current && !synced.entries.some((entry) => entry.id === current) ? null : current);
      setContextMenu((current) => current && !synced.entries.some((entry) => entry.id === current.entry.id) ? null : current);
      setMoveDialogEntry((current) => current && !synced.entries.some((entry) => entry.id === current.id) ? null : current);
      setDialog((current) => {
        if (!current) return null;
        if (current.type === "create-file" || current.type === "create-folder") {
          return current.parentId && !synced.entries.some((entry) => entry.id === current.parentId && entry.kind === "folder") ? null : current;
        }
        return synced.entries.some((entry) => entry.id === current.entry.id) ? current : null;
      });
      applyLocationRouteRef.current(synced.entries, synced.layout);
    }, (nextStatus) => { if (active) setSyncStatus(nextStatus); });
    void initializeDesktop({ x: window.innerWidth, y: Math.max(1, window.innerHeight - 44) }, predefinedDesktop)
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
      setMoveDialogEntry(null);
      setEditingViews(false);
      setDraggedViewId(null);
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
    const file = entries.find((entry): entry is FileEntry => entry.id === fileId && entry.kind === "file");
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
      if (generation !== fileLoadGenerationRef.current || routeRef.current?.fileId !== file.id || contentRevisionsRef.current[file.id] !== expectedRevision) return;
      updateOpenFile({ file, blob, editable: isEditable(file), contentRevision: expectedRevision, remoteChanged: false });
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
  }, [entries, loading, route?.fileId]);

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
    function onPointerDown(event: PointerEvent) {
      if (editingViews && !(event.target as Element).closest?.(".desktop-minimap")) {
        setEditingViews(false);
        setDraggedViewId(null);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && editingViews) {
        setEditingViews(false);
        setDraggedViewId(null);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [editingViews]);

  useEffect(() => {
    function closeMenu(event: MouseEvent) {
      if (!(event.target as Element).closest?.(".context-menu")) setContextMenu(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setContextMenu(null);
      if (event.key.toLowerCase() === "r" && contextMenu && canMutate) {
        setDialog({ type: "rename", entry: contextMenu.entry });
        setContextMenu(null);
      }
    }
    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [canMutate, contextMenu]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function childrenCount(parentId: string | null) {
    return entries.filter((entry) => entry.parentId === parentId && (parentId !== null || entry.viewId === activeViewId)).length;
  }

  function positionFor(parentId: string | null) {
    const position = nextPosition(childrenCount(parentId));
    return parentId === null && layoutRef.current.snapToGrid ? snapPositionInView(position) : position;
  }

  function snapPositionInView(position: EntryPosition) {
    return {
      x: snapAxis(position.x, GRID_ORIGIN.x, GRID_STEP.x, Math.max(8, desktopSize.width - FILE_ICON_WIDTH)),
      y: snapAxis(position.y, GRID_ORIGIN.y, GRID_STEP.y, Math.max(8, desktopSize.height - FILE_ICON_HEIGHT)),
    };
  }

  function snapDesktopPosition(position: EntryPosition) {
    const currentLayout = layoutRef.current;
    const columns = Math.max(1, Math.min(currentLayout.columns, currentLayout.views.length));
    const rows = Math.ceil(currentLayout.views.length / columns);
    const column = Math.max(0, Math.min(columns - 1, Math.floor(position.x / desktopSize.width)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor(position.y / desktopSize.height)));
    const local = snapPositionInView({
      x: position.x - column * desktopSize.width,
      y: position.y - row * desktopSize.height,
    });
    return {
      x: column * desktopSize.width + local.x,
      y: row * desktopSize.height + local.y,
    };
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
      const viewId = parentId === null ? activeViewId || layout.views[0].id : null;
      const created = dialog.type === "create-file"
        ? await createTextFile(name, parentId, positionFor(parentId), viewId)
        : await createFolder(name, parentId, positionFor(parentId), viewId);
      setEntries((current) => current.some((entry) => entry.id === created.id) ? current : [...current, created]);
      setSelectedId(created.id);
      if (parentId === null && created.viewId) goToView(created.viewId);
      setNotice(`${created.name} created`);
    } else if (dialog.type === "rename") {
      const renamed = await renameEntry(dialog.entry.id, name);
      setEntries((current) => current.map((entry) => entry.id === renamed.id ? renamed : entry));
      if (renamed.kind === "file" && openFileRef.current?.file.id === renamed.id) updateOpenFile({ ...openFileRef.current, file: renamed });
      setNotice(`${renamed.kind === "folder" ? "Folder" : "File"} renamed`);
    } else {
      const deleted = await deleteEntry(dialog.entry.id);
      const deletedIds = new Set(deleted.map((entry) => entry.id));
      setEntries((current) => current.filter((entry) => !deletedIds.has(entry.id)));
      setSelectedId((current) => current && deletedIds.has(current) ? null : current);
      setNotice(`${dialog.entry.name} deleted`);
    }
    setDialog(null);
  }

  async function handleImport(sources: File[], parentId: string | null, base?: EntryPosition) {
    if (!sources.length || !canMutate) return;
    setError("");
    try {
      const offset = childrenCount(parentId);
      const viewId = parentId === null ? activeViewId || layout.views[0].id : null;
      const positions = sources.map((_, index) => nextPosition(offset + index, base));
      const imported = await importFiles(sources, parentId, parentId === null && layoutRef.current.snapToGrid ? positions.map(snapPositionInView) : positions, viewId);
      setEntries((current) => {
        const existingIds = new Set(current.map((entry) => entry.id));
        return [...current, ...imported.filter((entry) => !existingIds.has(entry.id))];
      });
      setSelectedId(imported.at(-1)?.id ?? null);
      const lastImported = imported.at(-1);
      if (lastImported?.viewId) goToView(lastImported.viewId);
      setNotice(`${imported.length} ${imported.length === 1 ? "file" : "files"} added`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "The upload could not be completed.");
    }
  }

  async function handleDesktopMove(entry: DesktopEntry, position: EntryPosition, targetParentId: string | null) {
    if (!canMutate) return;
    if (targetParentId) {
      await handleMoveTo(entry, targetParentId);
      return;
    }
    const finalPosition = layoutRef.current.snapToGrid ? snapDesktopPosition(position) : position;
    const columns = Math.max(1, Math.min(layoutRef.current.columns, layoutRef.current.views.length));
    const rows = Math.ceil(layoutRef.current.views.length / columns);
    const column = Math.max(0, Math.min(columns - 1, Math.floor(finalPosition.x / desktopSize.width)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor(finalPosition.y / desktopSize.height)));
    const targetView = layoutRef.current.views[Math.min(layoutRef.current.views.length - 1, row * columns + column)];
    const localPosition = {
      x: Math.max(8, finalPosition.x - column * desktopSize.width),
      y: Math.max(8, finalPosition.y - row * desktopSize.height),
    };
    setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, position: localPosition, viewId: targetView.id } : item));
    try {
      await layoutSaveRef.current;
      await updateEntryPosition(entry.id, localPosition, targetView.id);
    } catch {
      setError("The new icon position could not be saved.");
    }
  }

  async function handleMoveTo(entry: DesktopEntry, parentId: string | null, bubbleError = false) {
    if (!canMutate) return;
    setError("");
    try {
      if (entry.parentId === parentId) return;
      const moved = await moveEntry(entry.id, parentId, positionFor(parentId), parentId === null ? activeViewId : null);
      setEntries((current) => current.map((item) => item.id === moved.id ? moved : item));
      setSelectedId(null);
      setContextMenu(null);
      setNotice(`${entry.name} moved`);
    } catch (moveError) {
      const message = moveError instanceof Error ? moveError.message : "The item could not be moved.";
      setError(message);
      if (bubbleError) throw moveError;
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
      const blob = openFile?.file.id === file.id ? openFile.blob : await readFile(file.id);
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
      const archive = await exportPredefinedDesktop();
      const url = URL.createObjectURL(archive);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "hiraya-predefined.zip";
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
    if (!openFile || openFile.file.id !== fileId) return;
    const saved = await saveTextFile(fileId, content);
    const blob = await readFile(saved.id);
    setEntries((current) => current.map((entry) => entry.id === saved.id ? saved : entry));
    if (routeRef.current?.fileId === saved.id) updateOpenFile({ file: saved, blob, editable: true, contentRevision: contentRevisionsRef.current[saved.id] ?? 0, remoteChanged: false });
    setNotice("Changes synced");
  }

  function goToView(viewId: string, mode: "push" | "replace" = "push") {
    const index = layoutRef.current.views.findIndex((view) => view.id === viewId);
    const currentRoute = routeRef.current;
    if (index < 0 || !currentRoute) return;
    const columns = Math.max(1, Math.min(layoutRef.current.columns, layoutRef.current.views.length));
    const column = index % columns;
    const row = Math.floor(index / columns);
    if (canvasRef.current) canvasRef.current.style.transform = `translate3d(${-column * desktopSize.width}px, ${-row * desktopSize.height}px, 0)`;
    navigateRoute({ ...currentRoute, viewId }, mode);
  }

  function handleDesktopPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".file-icon, .empty-state__actions")) return;
    swipeRef.current = { axis: null, pointerId: event.pointerId, startIndex: activeViewIndex, startTime: performance.now(), startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
  }

  function handleIconDragAtEdge(clientX: number, clientY: number) {
    const desktop = desktopRef.current;
    if (!desktop) return null;
    const bounds = desktop.getBoundingClientRect();
    const threshold = Math.min(36, Math.max(24, Math.min(bounds.width, bounds.height) * 0.06));
    const candidates = [
      { direction: "left", distance: clientX - bounds.left, enabled: page.column > 0 },
      { direction: "right", distance: bounds.right - clientX, enabled: true },
      { direction: "up", distance: clientY - bounds.top, enabled: page.row > 0 },
      { direction: "down", distance: bounds.bottom - clientY, enabled: true },
    ].filter((candidate) => candidate.enabled && candidate.distance <= threshold).sort((a, b) => a.distance - b.distance);
    const edge = candidates[0];
    if (!edge) {
      edgeDragRef.current.direction = "";
      return null;
    }
    const now = performance.now();
    if (edgeDragRef.current.direction === edge.direction && now - edgeDragRef.current.time < 520) return null;
    const previousIndex = layoutRef.current.views.findIndex((view) => view.id === activeViewId);
    const previousColumn = previousIndex % pageColumns;
    const previousRow = Math.floor(previousIndex / pageColumns);
    let columns = pageColumns;
    let targetIndex = previousIndex;
    const views = [...layoutRef.current.views];
    if (edge.direction === "left") targetIndex -= 1;
    if (edge.direction === "up") targetIndex -= columns;
    if (edge.direction === "right") {
      targetIndex += 1;
      if (previousColumn === columns - 1) {
        columns += 1;
        views.splice(targetIndex, 0, { id: crypto.randomUUID() });
      } else if (targetIndex >= views.length) {
        views.push({ id: crypto.randomUUID() });
      }
    }
    if (edge.direction === "down") {
      targetIndex += columns;
      while (views.length <= targetIndex) views.push({ id: crypto.randomUUID() });
    }
    targetIndex = Math.max(0, Math.min(views.length - 1, targetIndex));
    const nextColumn = targetIndex % columns;
    const nextRow = Math.floor(targetIndex / columns);
    edgeDragRef.current = { direction: edge.direction, time: now };
    if (views.length !== layoutRef.current.views.length || columns !== layoutRef.current.columns) applyLayout({ ...layoutRef.current, views, columns });
    if (!edgeNavigationRef.current && routeRef.current) edgeNavigationRef.current = { route: routeRef.current, historyState: window.history.state };
    goToView(views[targetIndex].id, "replace");
    return {
      deltaX: (nextColumn - previousColumn) * desktopSize.width,
      deltaY: (nextRow - previousRow) * desktopSize.height,
      maxX: Math.max(8, columns * desktopSize.width - FILE_ICON_WIDTH),
      maxY: Math.max(8, Math.ceil(views.length / columns) * desktopSize.height - FILE_ICON_HEIGHT),
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
    nextIndex = Math.max(0, Math.min(layoutRef.current.views.length - 1, nextIndex));
    goToView(layoutRef.current.views[nextIndex].id);
  }

  function moveView(viewId: string, targetIndex: number, persist = true) {
    const current = layoutRef.current;
    const sourceIndex = current.views.findIndex((view) => view.id === viewId);
    const boundedTarget = Math.max(0, Math.min(current.views.length - 1, targetIndex));
    if (sourceIndex < 0 || sourceIndex === boundedTarget) return;
    const views = [...current.views];
    const [moved] = views.splice(sourceIndex, 1);
    views.splice(boundedTarget, 0, moved);
    applyLayout({ ...current, views }, persist);
  }

  function deleteView(viewId: string) {
    if (!canMutate) return;
    if (layout.views.length === 1) {
      setError("The final desktop view cannot be deleted.");
      return;
    }
    if (rootEntries.some((entry) => entry.viewId === viewId)) {
      setError("Move or delete this view's items before deleting it.");
      return;
    }
    const deletedIndex = layout.views.findIndex((view) => view.id === viewId);
    const views = layout.views.filter((view) => view.id !== viewId);
    const next = { ...layout, views, columns: Math.max(1, Math.min(layout.columns, views.length)) };
    if (activeViewId === viewId && routeRef.current) navigateRoute({ ...routeRef.current, viewId: views[Math.min(deletedIndex, views.length - 1)].id }, "replace");
    applyLayout(next);
    setNotice("Desktop view deleted");
  }

  function startMinimapPress(event: React.PointerEvent<HTMLButtonElement>, viewId: string) {
    if (event.button !== 0 || !canMutate) return;
    const press = {
      activated: editingViews,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
      viewId,
      initialViews: [...layoutRef.current.views],
    };
    press.timer = window.setTimeout(() => {
      press.activated = true;
      setEditingViews(true);
      setDraggedViewId(viewId);
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
      .map((element) => element.closest<HTMLElement>("[data-view-id]"))
      .find(Boolean);
    if (!target?.dataset.viewId) return;
    const targetIndex = layoutRef.current.views.findIndex((view) => view.id === target.dataset.viewId);
    moveView(press.viewId, targetIndex, false);
  }

  function finishMinimapPress(event: React.PointerEvent<HTMLButtonElement>, cancelled = false) {
    const press = minimapPointerRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    window.clearTimeout(press.timer);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    minimapPointerRef.current = null;
    if (press.activated && cancelled) {
      applyLayout({ ...layoutRef.current, views: press.initialViews }, false);
      setDraggedViewId(null);
    } else if (press.activated) {
      applyLayout(layoutRef.current);
      setDraggedViewId(null);
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    } else if (!cancelled) {
      goToView(press.viewId);
    }
  }

  function invalidMoveIds(entry: DesktopEntry) {
    const ids = new Set([entry.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of entries) {
        if (candidate.parentId && ids.has(candidate.parentId) && !ids.has(candidate.id)) {
          ids.add(candidate.id);
          changed = true;
        }
      }
    }
    return ids;
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
          <button type="button" aria-label="Export saved desktop" title="Export the saved desktop as a predefined package" disabled={loading || exporting} onClick={() => void handleExport()}><ExportIcon size={16} /> <span>{exporting ? "Exporting" : "Export"}</span></button>
          <button
            type="button"
            aria-label={`${layout.snapToGrid ? "Disable" : "Enable"} snap to grid`}
            aria-pressed={layout.snapToGrid}
            title={`${layout.snapToGrid ? "Disable" : "Enable"} snap to grid`}
            disabled={!canMutate}
            onClick={() => applyLayout({ ...layoutRef.current, snapToGrid: !layoutRef.current.snapToGrid })}
          ><GridFour size={16} weight={layout.snapToGrid ? "fill" : "regular"} /> <span>Snap to grid</span></button>
          {document.fullscreenEnabled && <button type="button" aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"} title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={() => void toggleFullscreen()}>{isFullscreen ? <CornersIn size={16} /> : <CornersOut size={16} />} <span>{isFullscreen ? "Exit fullscreen" : "Fullscreen"}</span></button>}
          <span className="menu-bar__sync" data-status={syncStatus} title={syncStatus === "online" ? "Changes are synced" : syncStatus === "connecting" ? "Connecting to sync server" : "Sync server unavailable; editing is disabled"}>
            {syncStatus === "online" ? <CloudCheck size={15} /> : syncStatus === "connecting" ? <SpinnerGap size={15} /> : <CloudSlash size={15} />}
            <span>{syncStatus === "online" ? "Synced" : syncStatus === "connecting" ? "Connecting" : "Offline"}</span>
          </span>
          <span className="menu-bar__clock">{formatClock(clock)}</span>
        </div>
      </header>

      <section
        className="desktop"
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
          {rootEntries.map((entry) => {
            const viewIndex = layout.views.findIndex((view) => view.id === entry.viewId);
            if (viewIndex < 0) return null;
            const viewColumn = viewIndex % pageColumns;
            const viewRow = Math.floor(viewIndex / pageColumns);
            const renderedEntry = {
              ...entry,
              position: {
                x: viewColumn * desktopSize.width + entry.position.x,
                y: viewRow * desktopSize.height + entry.position.y,
              },
            };
            return <FileIcon
              key={entry.id}
              entry={renderedEntry}
              selected={selectedId === entry.id}
              onSelect={() => setSelectedId(entry.id)}
              onOpen={() => void handleOpen(entry)}
              onMove={(position, targetParentId) => void handleDesktopMove(entry, position, targetParentId)}
              onDragAtEdge={handleIconDragAtEdge}
              onDragEnd={finishEdgeNavigation}
              getSnapPreview={layout.snapToGrid ? snapDesktopPosition : undefined}
              onExternalDrop={(sources) => void handleImport(sources, entry.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedId(entry.id);
                setContextMenu({ entry, x: event.clientX, y: event.clientY });
              }}
            />;
          })}
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
        <nav className="desktop-minimap" data-editing={editingViews || undefined} aria-label="Desktop views">
          {editingViews && (
            <div className="desktop-minimap__toolbar">
              <span>Arrange views</span>
              <button type="button" onClick={() => { setEditingViews(false); setDraggedViewId(null); }}><Check size={12} /> Done</button>
            </div>
          )}
          <div className="desktop-minimap__grid" style={{ "--minimap-columns": pageColumns, "--minimap-rows": pageRows } as React.CSSProperties}>
            {layout.views.map((view, index) => {
              const column = index % pageColumns;
              const row = Math.floor(index / pageColumns);
              const viewEntries = rootEntries.filter((entry) => entry.viewId === view.id);
              const deleteDisabled = viewEntries.length > 0 || layout.views.length === 1;
              return (
                <div className="desktop-minimap__slot" data-view-id={view.id} data-dragging={draggedViewId === view.id || undefined} key={view.id}>
                  <button
                    className="desktop-minimap__page"
                    data-active={view.id === activeViewId || undefined}
                    type="button"
                    aria-label={`View ${row + 1}, ${column + 1}${editingViews ? ", use arrow keys to move or Delete to remove" : ", long press to arrange"}`}
                    aria-current={view.id === activeViewId ? "true" : undefined}
                    onClick={(event) => { if (event.detail === 0 && !editingViews) goToView(view.id); }}
                    onContextMenu={(event) => { event.preventDefault(); setEditingViews(true); }}
                    onPointerDown={(event) => startMinimapPress(event, view.id)}
                    onPointerMove={moveMinimapPress}
                    onPointerUp={(event) => finishMinimapPress(event)}
                    onPointerCancel={(event) => finishMinimapPress(event, true)}
                    onKeyDown={(event) => {
                      if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
                        event.preventDefault();
                        setEditingViews(true);
                      } else if (editingViews && (event.key === "ArrowLeft" || event.key === "ArrowUp")) {
                        event.preventDefault();
                        moveView(view.id, index - 1);
                      } else if (editingViews && (event.key === "ArrowRight" || event.key === "ArrowDown")) {
                        event.preventDefault();
                        moveView(view.id, index + 1);
                      } else if (editingViews && event.key === "Delete") {
                        event.preventDefault();
                        deleteView(view.id);
                      }
                    }}
                  >
                    {viewEntries.map((entry) => (
                      <span className="desktop-minimap__file" key={entry.id} style={{ left: `${entry.position.x / desktopSize.width * 100}%`, top: `${entry.position.y / desktopSize.height * 100}%` }} />
                    ))}
                  </button>
                  {editingViews && (
                    <button className="desktop-minimap__delete" type="button" disabled={deleteDisabled} title={deleteDisabled ? "Only empty views can be deleted" : "Delete empty view"} aria-label={`Delete view ${index + 1}`} onClick={() => deleteView(view.id)}>
                      <Trash size={10} weight="bold" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <span className="visually-hidden" aria-live="polite">Desktop view row {page.row + 1} of {pageRows}, column {page.column + 1} of {pageColumns}</span>
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
          onClose={() => { const current = routeRef.current; if (current) closeToRoute({ viewId: current.viewId }); }}
          onNavigate={(folder) => { const current = routeRef.current; if (current) navigateRoute({ ...current, explorerFolderId: folder?.id ?? null, fileId: undefined }); }}
          onOpen={handleOpen}
          onCreateFolder={(parentId) => setDialog({ type: "create-folder", parentId })}
          onCreateFile={(parentId) => setDialog({ type: "create-file", parentId })}
          onUpload={chooseUpload}
          onMove={(entry, parentId) => void handleMoveTo(entry, parentId)}
          onContextMenu={(entry, x, y) => setContextMenu({ entry, x, y })}
          readOnly={!canMutate}
        />
      )}

      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          onOpen={() => handleOpen(contextMenu.entry)}
          onRename={() => { setDialog({ type: "rename", entry: contextMenu.entry }); setContextMenu(null); }}
          onDownload={contextMenu.entry.kind === "file" ? () => void download(contextMenu.entry as FileEntry) : undefined}
          onMove={() => { setMoveDialogEntry(contextMenu.entry); setContextMenu(null); }}
          onDelete={() => { setDialog({ type: "delete", entry: contextMenu.entry }); setContextMenu(null); }}
          readOnly={!canMutate}
        />
      )}
      {dialog && <FileDialog dialog={dialog} onClose={() => setDialog(null)} onSubmit={handleDialogSubmit} />}
      {moveDialogEntry && (
        <MoveDialog
          entry={moveDialogEntry}
          folders={folders}
          invalidIds={invalidMoveIds(moveDialogEntry)}
          onClose={() => setMoveDialogEntry(null)}
          onMove={async (parentId) => { await handleMoveTo(moveDialogEntry, parentId, true); setMoveDialogEntry(null); }}
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
              viewId: current.viewId,
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

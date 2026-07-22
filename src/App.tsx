import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CloudCheck, CloudSlash, File as FileGlyph, Folder, FolderPlus, GearSix, HardDrive, LinkSimple, Plus, SpinnerGap, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import seededDesktop from "virtual:hiraya-seeded";
import { ContextMenu, DesktopContextMenu } from "./components/ContextMenu";
import { AppWindow } from "./components/AppWindow";
import { FileDialog } from "./components/FileDialog";
import { FileIcon } from "./components/FileIcon";
import { FileWindow } from "./components/FileWindow";
import { FolderExplorer } from "./components/FolderExplorer";
import { MoveDialog } from "./components/MoveDialog";
import { PasteConflictDialog } from "./components/PasteConflictDialog";
import { SettingsWindow } from "./components/SettingsWindow";
import { UpdateToast } from "./components/UpdateToast";
import {
  createFolder,
  createTextFile,
  deleteCustomTheme,
  captureEntries,
  deleteEntries,
  getOutboxStatus,
  importFiles,
  initializeDesktop,
  moveEntries,
  pasteEntries,
  readFile,
  readFileByRelativePath,
  renameEntry,
  saveCustomTheme,
  saveDesktopLayout,
  saveEditorSettings,
  saveTextFile,
  selectTheme,
  updateDesktopPositions,
  updateEntryPosition,
  subscribeToSync,
  stopDesktopSync,
  type SyncStatus,
} from "./lib/sync";
import { DEFAULT_EDITOR_SETTINGS, readLocalPreferences, saveLocalPreferences } from "./lib/opfs";
import { createPwaUpdater, type PwaUpdater } from "./lib/pwa-update";
import { exportSeededDesktop } from "./lib/seeded";
import { CLIPBOARD_ARCHIVE_WEB_MIME_TYPE, decodeClipboardArchiveItem, encodeClipboardArchive, snapshotFromClipboardItems, type ClipboardEntrySnapshot } from "./lib/clipboard";
import { formatDesktopRoute, normalizeDesktopRoute, parseDesktopRoute, type DesktopRoute } from "./lib/routes";
import { DEFAULT_THEME_STATE, isBuiltinThemeId, resolveTheme, themeIconMetrics, themeStyle, type CustomTheme, type ThemeDefinition, type ThemeState } from "./lib/themes";
import { DEFAULT_WALLPAPER, type ContextMenuState, type DesktopEntry, type DesktopLayout, type DialogState, type EditorSettings, type EntryPosition, type FileEntry } from "./types";
import { GRID_ORIGIN, nextAvailableDesktopSlot, nextDesktopPosition, projectLogicalPosition, reorderDesktopPages, responsiveDesktop, restoreLogicalPosition, segmentKey, snapAxis } from "./ui/desktop-geometry";
import { fileCapabilities } from "./ui/file-capabilities";
import { topOverlay } from "./ui/overlay";
import { createWorkspaceIndex } from "./ui/workspace-index";
import { clampWindowBounds, initialWindowBounds, type WindowBounds } from "./ui/window-manager";
import { namesMatch } from "./lib/entry-validation";

type BaseRunningApp = { id: string; bounds: WindowBounds; minimized: boolean; zIndex: number };
type FileApp = BaseRunningApp & { kind: "file"; fileId: string; file?: FileEntry; blob?: File; editable?: boolean; contentRevision: number; remoteChanged: boolean };
type ExplorerApp = BaseRunningApp & { kind: "explorer"; folderId: string | null };
type SettingsApp = BaseRunningApp & { kind: "settings" };
type RunningApp = FileApp | ExplorerApp | SettingsApp;
type RouteHistoryState = { hiraya: true; parentHash?: string };
type PendingPaste = { snapshot: ClipboardEntrySnapshot; parentId: string | null; position?: EntryPosition };
const MINIMAP_LONG_PRESS_MS = 500;
const DESKTOP_LONG_PRESS_MS = 500;

function formatClock(date: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function App() {
  const [entries, setEntries] = useState<DesktopEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionSurface, setSelectionSurface] = useState("desktop");
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [moveDialogEntryIds, setMoveDialogEntryIds] = useState<string[]>([]);
  const [moveDialogSubmitting, setMoveDialogSubmitting] = useState(false);
  const [runningApps, setRunningApps] = useState<RunningApp[]>([]);
  const [focusedAppId, setFocusedAppId] = useState<string | null>(null);
  const [route, setRoute] = useState<DesktopRoute | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [desktopSize, setDesktopSize] = useState(() => ({ width: window.innerWidth, height: Math.max(1, window.innerHeight - 44) }));
  const [layout, setLayout] = useState<DesktopLayout>(() => ({ snapToGrid: false, wallpaper: DEFAULT_WALLPAPER }));
  const [editorSettings, setEditorSettings] = useState<EditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const [appearance, setAppearance] = useState<ThemeState>(DEFAULT_THEME_STATE);
  const [themePreview, setThemePreview] = useState<ThemeDefinition | null>(null);
  const [exporting, setExporting] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");
  const [isSyncing, setIsSyncing] = useState(false);
  const [editingViews, setEditingViews] = useState(false);
  const [draggedPageKey, setDraggedPageKey] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 620px)").matches);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [updateSupported, setUpdateSupported] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [showUpdateToast, setShowUpdateToast] = useState(false);
  const [updateBlocked, setUpdateBlocked] = useState(false);
  const [updateApplying, setUpdateApplying] = useState(false);
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const desktopRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadParentRef = useRef<string | null>(null);
  const uploadPositionRef = useRef<EntryPosition | undefined>(undefined);
  const swipeRef = useRef<{ axis: "x" | "y" | null; pointerId: number; startSegment: { column: number; row: number }; startTime: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const minimapPointerRef = useRef<{
    activated: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    timer: number;
    pageKey: string;
    initialPositions: Array<{ entryId: string; position: EntryPosition }>;
  } | null>(null);
  const desktopPressRef = useRef<{
    activated: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    timer: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const selectedIdsRef = useRef<string[]>([]);
  const clipboardRef = useRef<ClipboardEntrySnapshot | null>(null);
  const marqueeRef = useRef<{ pointerId: number; startX: number; startY: number; additive: boolean; initial: string[] } | null>(null);
  const beginPasteRef = useRef<(parentId: string | null, position?: EntryPosition, snapshot?: ClipboardEntrySnapshot) => Promise<void>>(async () => undefined);
  const handleImportRef = useRef<(files: File[], parentId: string | null, base?: EntryPosition) => Promise<void>>(async () => undefined);
  const edgeDragRef = useRef({ direction: "", time: 0 });
  const edgeNavigationRef = useRef<{
    route: DesktopRoute;
    historyState: unknown;
    draftEntryId?: string;
    targetSegment?: { column: number; row: number };
  } | null>(null);
  const layoutRef = useRef(layout);
  const entriesRef = useRef(entries);
  const routeRef = useRef<DesktopRoute | null>(null);
  const navigationReadyRef = useRef(false);
  const applyLocationRouteRef = useRef<(entriesValue?: DesktopEntry[], layoutValue?: DesktopLayout) => void>(() => undefined);
  const navigateRouteRef = useRef<(next: DesktopRoute, mode?: "push" | "replace") => void>(() => undefined);
  const openRouteAppsRef = useRef<(next: DesktopRoute) => void>(() => undefined);
  const closeAppRef = useRef<(id: string) => void>(() => undefined);
  const runningAppsRef = useRef<RunningApp[]>([]);
  const focusedAppIdRef = useRef<string | null>(null);
  const nextWindowZRef = useRef(1);
  const fileLoadGenerationsRef = useRef<Record<string, number>>({});
  const layoutSaveRef = useRef<Promise<void>>(Promise.resolve());
  const editorSettingsSaveRef = useRef<Promise<void>>(Promise.resolve());
  const contentRevisionsRef = useRef<Record<string, number>>({});
  const fileDirtyRef = useRef<Record<string, boolean>>({});
  const updaterRef = useRef<PwaUpdater | null>(null);
  const autoUpdateRef = useRef(true);
  const updatePreferenceLoadedRef = useRef(false);
  const manualUpdateCheckRef = useRef(false);
  const activeSegment = { column: route?.column ?? 0, row: route?.row ?? 0 };
  const routeExplorerFolderId = route?.explorerFolderId;
  const routeFileId = route?.fileId;
  const canMutate = syncStatus !== "connecting";
  const syncIndicatorStatus = syncStatus === "online" && isSyncing ? "syncing" : syncStatus;
  const workspace = useMemo(() => createWorkspaceIndex(entries), [entries]);
  const activeTheme = useMemo(() => themePreview ?? resolveTheme(appearance), [appearance, themePreview]);
  const iconMetrics = useMemo(() => themeIconMetrics(activeTheme), [activeTheme]);
  const rootEntries = workspace.roots;
  const responsive = useMemo(() => responsiveDesktop(entries, desktopSize, iconMetrics), [desktopSize, entries, iconMetrics]);
  const activePageKey = segmentKey(activeSegment);
  const actualActivePage = responsive.pages.find((candidate) => candidate.key === activePageKey);
  const pages = actualActivePage
    ? responsive.pages
    : [...responsive.pages, { entries: [], key: activePageKey, segment: activeSegment }]
      .sort((a, b) => a.segment.row - b.segment.row || a.segment.column - b.segment.column);
  const minColumn = Math.min(responsive.minColumn, activeSegment.column);
  const minRow = Math.min(responsive.minRow, activeSegment.row);
  const maxColumn = Math.max(responsive.maxColumn, activeSegment.column);
  const maxRow = Math.max(responsive.maxRow, activeSegment.row);
  const pageColumns = maxColumn - minColumn + 1;
  const pageRows = maxRow - minRow + 1;
  const page = { column: activeSegment.column - minColumn, row: activeSegment.row - minRow };
  const activeDesktopPage = actualActivePage ?? { entries: [], key: activePageKey, segment: activeSegment };
  const minimapWidth = Math.min(112, Math.max(42, pageColumns * 24)) + 26;
  const minimapHeight = Math.min(84, Math.max(30, pageRows * 20)) + 27;
  const minimapObscured = !editingViews && activeDesktopPage.entries.some((entry) => {
    const position = responsive.positions.get(entry.id) ?? entry.position;
    return position.x + iconMetrics.width > desktopSize.width - minimapWidth
      && position.y + iconMetrics.height > desktopSize.height - minimapHeight;
  });
  const folders = workspace.folders;
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  selectedIdsRef.current = selectedIds;
  const selectedEntries = selectedIds.map((id) => workspace.byId.get(id)).filter((entry): entry is DesktopEntry => Boolean(entry));
  const dialogEntry = dialog?.type === "rename" ? workspace.byId.get(dialog.entryId) ?? null : dialog?.type === "delete" ? workspace.byId.get(dialog.entryIds[0]) ?? null : null;
  const contextMenuEntry = contextMenu?.type === "entry" ? workspace.byId.get(contextMenu.entryId) ?? null : null;
  const contextMenuEntries = contextMenuEntry && selectedIdSet.has(contextMenuEntry.id) ? selectedEntries : contextMenuEntry ? [contextMenuEntry] : [];
  const moveDialogEntries = moveDialogEntryIds.map((id) => workspace.byId.get(id)).filter((entry): entry is DesktopEntry => Boolean(entry));
  function setCurrentRoute(next: DesktopRoute) {
    routeRef.current = next;
    setRoute(next);
  }

  function replaceSelection(surface: string, ids: string[], anchorId = ids.at(-1) ?? null) {
    const unique = [...new Set(ids)];
    selectedIdsRef.current = unique;
    setSelectedIds(unique);
    setSelectionSurface(surface);
    setSelectionAnchorId(anchorId);
  }

  function selectEntry(surface: string, entry: DesktopEntry, options: { toggle?: boolean; range?: boolean; orderedIds?: string[] } = {}) {
    const current = selectionSurface === surface ? selectedIdsRef.current : [];
    if (options.range && selectionSurface === surface && selectionAnchorId && options.orderedIds) {
      const start = options.orderedIds.indexOf(selectionAnchorId);
      const end = options.orderedIds.indexOf(entry.id);
      if (start >= 0 && end >= 0) {
        replaceSelection(surface, options.orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1), selectionAnchorId);
        return;
      }
    }
    if (options.toggle) {
      replaceSelection(surface, current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id], entry.id);
      return;
    }
    if (current.includes(entry.id)) return;
    replaceSelection(surface, [entry.id], entry.id);
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
    void layoutValue;
    const normalized = normalizeDesktopRoute(parseDesktopRoute(window.location.hash), entriesValue);
    if (!normalized) return;
    const canonicalHash = formatDesktopRoute(normalized);
    if (canonicalHash !== window.location.hash) writeRoute(normalized, "replace");
    else setCurrentRoute(normalized);
  }

  function navigateRoute(next: DesktopRoute, mode: "push" | "replace" = "push") {
    const normalized = normalizeDesktopRoute(next, entriesRef.current);
    if (normalized) writeRoute(normalized, mode);
  }

  function updateRunningApps(updater: RunningApp[] | ((current: RunningApp[]) => RunningApp[])) {
    setRunningApps((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      runningAppsRef.current = next;
      return next;
    });
  }

  function setFocusedApp(id: string | null) {
    focusedAppIdRef.current = id;
    setFocusedAppId(id);
  }

  function focusApp(id: string) {
    const target = runningAppsRef.current.find((app) => app.id === id);
    const zIndex = ++nextWindowZRef.current;
    updateRunningApps((current) => current.map((app) => app.id === id ? { ...app, minimized: false, zIndex } : app));
    setFocusedApp(id);
    const currentRoute = routeRef.current;
    if (!target || !currentRoute) return;
    if (target.kind === "file") navigateRoute({ column: currentRoute.column, row: currentRoute.row, fileId: target.fileId }, "replace");
    else if (target.kind === "explorer") navigateRoute({ column: currentRoute.column, row: currentRoute.row, explorerFolderId: target.folderId }, "replace");
    else navigateRoute({ column: currentRoute.column, row: currentRoute.row }, "replace");
  }

  function closeApp(id: string) {
    const closing = runningAppsRef.current.find((app) => app.id === id);
    delete fileDirtyRef.current[id];
    delete fileLoadGenerationsRef.current[id];
    const remaining = runningAppsRef.current.filter((app) => app.id !== id);
    updateRunningApps(remaining);
    if (focusedAppIdRef.current === id) {
      const next = [...remaining].filter((app) => !app.minimized).sort((a, b) => b.zIndex - a.zIndex)[0] ?? null;
      setFocusedApp(next?.id ?? null);
    }
    const currentRoute = routeRef.current;
    if (!closing || !currentRoute) return;
    if (closing.kind === "file" && currentRoute.fileId === closing.fileId) {
      navigateRoute({ column: currentRoute.column, row: currentRoute.row, ...(currentRoute.explorerFolderId !== undefined ? { explorerFolderId: currentRoute.explorerFolderId } : {}) }, "replace");
    } else if (closing.kind === "explorer" && currentRoute.explorerFolderId === closing.folderId) {
      navigateRoute({ column: currentRoute.column, row: currentRoute.row, ...(currentRoute.fileId ? { fileId: currentRoute.fileId } : {}) }, "replace");
    }
  }

  function minimizeApp(id: string) {
    updateRunningApps((current) => current.map((app) => app.id === id ? { ...app, minimized: true } : app));
    if (focusedAppIdRef.current === id) {
      const next = [...runningAppsRef.current].filter((app) => app.id !== id && !app.minimized).sort((a, b) => b.zIndex - a.zIndex)[0] ?? null;
      setFocusedApp(next?.id ?? null);
    }
  }

  function updateAppBounds(id: string, bounds: WindowBounds) {
    updateRunningApps((current) => current.map((app) => app.id === id ? { ...app, bounds } : app));
  }

  function createAppBase(id: string, width: number, height: number, minWidth: number, minHeight: number): BaseRunningApp {
    return {
      id,
      bounds: initialWindowBounds(desktopSize, { width, height, minWidth, minHeight, index: runningAppsRef.current.length }),
      minimized: false,
      zIndex: ++nextWindowZRef.current,
    };
  }

  applyLocationRouteRef.current = applyLocationRoute;
  navigateRouteRef.current = navigateRoute;
  openRouteAppsRef.current = (next) => {
    if (next.explorerFolderId !== undefined) openExplorerWindow(next.explorerFolderId);
    if (next.fileId) {
      const entry = workspace.byId.get(next.fileId);
      if (entry?.kind === "file") openFileWindow(entry);
    }
  };
  closeAppRef.current = closeApp;

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
      setAppearance(synced.appearance);
      setLoading(false);
      const syncedIds = new Set(synced.entries.map((entry) => entry.id));
      setSelectedIds((current) => current.filter((id) => syncedIds.has(id)));
      setContextMenu((current) => current?.type === "entry" && !syncedIds.has(current.entryId) ? null : current);
      setMoveDialogEntryIds((current) => current.filter((id) => syncedIds.has(id)));
      setDialog((current) => {
        if (!current) return null;
        if (current.type === "create-file" || current.type === "create-folder") {
          return current.parentId && !synced.entries.some((entry) => entry.id === current.parentId && entry.kind === "folder") ? null : current;
        }
        return current.type === "rename" ? syncedIds.has(current.entryId) ? current : null : current.entryIds.some((id) => syncedIds.has(id)) ? { ...current, entryIds: current.entryIds.filter((id) => syncedIds.has(id)) } : null;
      });
      const availableApps = runningAppsRef.current.filter((app) => app.kind === "settings" || app.kind === "explorer" && app.folderId === null || syncedIds.has(app.kind === "file" ? app.fileId : app.folderId!));
      updateRunningApps(availableApps);
      if (focusedAppIdRef.current && !availableApps.some((app) => app.id === focusedAppIdRef.current)) {
        const next = [...availableApps].filter((app) => !app.minimized).sort((a, b) => b.zIndex - a.zIndex)[0] ?? null;
        setFocusedApp(next?.id ?? null);
      }
      navigationReadyRef.current = true;
      applyLocationRouteRef.current(synced.entries, synced.layout);
    }, (nextStatus) => { if (active) setSyncStatus(nextStatus); }, (syncing) => { if (active) setIsSyncing(syncing); });
    void initializeDesktop({ x: window.innerWidth, y: Math.max(1, window.innerHeight - 44) }, seededDesktop)
      .then(({ desktop: loadedDesktop, status: loadedStatus }) => {
        if (!active) return;
        const { entries: loadedEntries, layout: loadedLayout, editorSettings: loadedEditorSettings, appearance: loadedAppearance, sync } = loadedDesktop;
        contentRevisionsRef.current = sync.contentRevisions;
        layoutRef.current = loadedLayout;
        entriesRef.current = loadedEntries;
        setLayout(loadedLayout);
        setEntries(loadedEntries);
        setEditorSettings(loadedEditorSettings);
        setAppearance(loadedAppearance);
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
    if (syncStatus !== "blocked") return;
    let active = true;
    void getOutboxStatus().then((status) => {
      if (!active) return;
      const blocked = status.records.find((record) => record.status === "blocked");
      setError(blocked?.error ? `A queued change could not sync: ${blocked.error}` : "A queued change could not sync and needs attention.");
    }).catch(() => undefined);
    return () => { active = false; };
  }, [syncStatus]);

  useEffect(() => {
    let active = true;
    const updater = createPwaUpdater({
      onUpdateAvailable: () => {
        if (!active) return;
        setUpdateReady(true);
        if (manualUpdateCheckRef.current || updatePreferenceLoadedRef.current && autoUpdateRef.current) setShowUpdateToast(true);
      },
      onError: () => { if (active) setError("Hiraya could not check for frontend updates."); },
    });
    updaterRef.current = updater;
    setUpdateSupported(updater.supported);

    const checkAutomatically = () => {
      if (!active || !autoUpdateRef.current || !updater.supported) return;
      void updater.check().catch(() => { if (active) setError("Hiraya could not check for frontend updates."); });
    };
    const checkWhenVisible = () => { if (document.visibilityState === "visible") checkAutomatically(); };
    window.addEventListener("online", checkAutomatically);
    document.addEventListener("visibilitychange", checkWhenVisible);

    void readLocalPreferences()
      .then((preferences) => {
        if (!active) return;
        autoUpdateRef.current = preferences.autoUpdate;
        updatePreferenceLoadedRef.current = true;
        setAutoUpdate(preferences.autoUpdate);
        checkAutomatically();
      })
      .catch(() => {
        if (!active) return;
        updatePreferenceLoadedRef.current = true;
        setError("The local update preference could not be loaded.");
        checkAutomatically();
      });

    return () => {
      active = false;
      updater.dispose();
      if (updaterRef.current === updater) updaterRef.current = null;
      window.removeEventListener("online", checkAutomatically);
      document.removeEventListener("visibilitychange", checkWhenVisible);
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
      setMoveDialogEntryIds([]);
      setEditingViews(false);
      setDraggedPageKey(null);
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
    const query = window.matchMedia("(max-width: 620px)");
    const update = () => setIsMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

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

  const previousDesktopSizeRef = useRef(desktopSize);
  useEffect(() => {
    const previous = previousDesktopSizeRef.current;
    previousDesktopSizeRef.current = desktopSize;
    const current = routeRef.current;
    if (!current || (previous.width === desktopSize.width && previous.height === desktopSize.height)) return;
    navigateRouteRef.current({
      ...current,
      column: Math.floor((current.column * previous.width + previous.width / 2) / desktopSize.width),
      row: Math.floor((current.row * previous.height + previous.height / 2) / desktopSize.height),
    }, "replace");
    updateRunningApps((currentApps) => currentApps.map((app) => ({
      ...app,
      bounds: clampWindowBounds(app.bounds, desktopSize, app.kind === "file" ? { minWidth: 420, minHeight: 320 } : { minWidth: 360, minHeight: 280 }),
    })));
  }, [desktopSize]);

  useEffect(() => {
    if (loading) return;
    openRouteAppsRef.current({
      column: 0,
      row: 0,
      ...(routeExplorerFolderId !== undefined ? { explorerFolderId: routeExplorerFolderId } : {}),
      ...(routeFileId ? { fileId: routeFileId } : {}),
    });
  }, [loading, routeExplorerFolderId, routeFileId]);

  useEffect(() => {
    if (loading) return;
    const currentApps = runningAppsRef.current;
    const reconciledApps = currentApps.flatMap((app): RunningApp[] => {
      if (app.kind === "settings" || app.kind === "explorer" && app.folderId === null) return [app];
      const entryId = app.kind === "file" ? app.fileId : app.folderId;
      const entry = entryId ? workspace.byId.get(entryId) : null;
      if (!entry || app.kind === "file" && entry.kind !== "file" || app.kind === "explorer" && entry.kind !== "folder") return [];
      if (app.kind === "explorer") return [app];
      if (entry.kind !== "file") return [];
      const expectedRevision = contentRevisionsRef.current[app.fileId] ?? 0;
      if (expectedRevision !== app.contentRevision && fileDirtyRef.current[app.id]) {
        return [{ ...app, file: entry, contentRevision: expectedRevision, remoteChanged: true }];
      }
      return [{ ...app, file: entry, editable: fileCapabilities(entry).editable }];
    });
    updateRunningApps(reconciledApps);
    if (focusedAppIdRef.current && !reconciledApps.some((app) => app.id === focusedAppIdRef.current)) {
      const next = [...reconciledApps].filter((app) => !app.minimized).sort((a, b) => b.zIndex - a.zIndex)[0] ?? null;
      setFocusedApp(next?.id ?? null);
    }

    for (const app of currentApps) {
      if (app.kind !== "file" || fileDirtyRef.current[app.id]) continue;
      const entry = workspace.byId.get(app.fileId);
      const expectedRevision = contentRevisionsRef.current[app.fileId] ?? 0;
      if (entry?.kind !== "file" || app.contentRevision === expectedRevision) continue;
      const generation = (fileLoadGenerationsRef.current[app.id] ?? 0) + 1;
      fileLoadGenerationsRef.current[app.id] = generation;
      void readFile(app.fileId).then((blob) => {
        if (fileLoadGenerationsRef.current[app.id] !== generation) return;
        updateRunningApps((current) => current.map((candidate) => candidate.id === app.id && candidate.kind === "file" ? {
          ...candidate,
          file: entry,
          blob,
          editable: fileCapabilities(entry).editable,
          contentRevision: expectedRevision,
          remoteChanged: false,
        } : candidate));
      }).catch(() => setError("An open file changed on the server but could not be refreshed."));
    }
  }, [loading, workspace]);

  useEffect(() => {
    applyLocationRouteRef.current();
  }, [responsive.pages.length]);

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

  useEffect(() => () => {
    if (desktopPressRef.current) window.clearTimeout(desktopPressRef.current.timer);
  }, []);

  useEffect(() => {
    function closeMenu(event: PointerEvent) {
      if (!(event.target as Element).closest?.(".context-menu")) setContextMenu(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "r" && contextMenuEntry && canMutate) {
        setDialog({ type: "rename", entryId: contextMenuEntry.id });
        setContextMenu(null);
      }
    }
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [canMutate, contextMenuEntry]);

  useEffect(() => {
    function editableTarget(target: EventTarget | null) {
      const element = target as Element | null;
      return Boolean(element?.closest?.("input, textarea, [contenteditable='true'], .cm-editor"));
    }
    function activeExplorer() {
      const app = runningAppsRef.current.find((candidate) => candidate.id === focusedAppIdRef.current);
      return app?.kind === "explorer" ? app : null;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (editableTarget(event.target) || dialog || pendingPaste || moveDialogEntryIds.length) return;
      const focused = runningAppsRef.current.find((candidate) => candidate.id === focusedAppIdRef.current);
      if (focused && focused.kind !== "explorer") return;
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "a") {
        const explorer = activeExplorer();
        const surface = explorer?.id ?? "desktop";
        const ids = explorer ? workspace.children.get(explorer.folderId)?.map((entry) => entry.id) ?? [] : activeDesktopPage.entries.map((entry) => entry.id);
        event.preventDefault();
        replaceSelection(surface, ids);
      } else if (modifier && key === "c" && selectedIdsRef.current.length) {
        event.preventDefault();
        void copySelection();
      } else if (modifier && key === "v") {
        event.preventDefault();
        const explorer = activeExplorer();
        void beginPasteRef.current(explorer?.folderId ?? null);
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedIdsRef.current.length && canMutate) {
        event.preventDefault();
        setDialog({ type: "delete", entryIds: [...selectedIdsRef.current] });
      }
    }
    function onPaste(event: ClipboardEvent) {
      if (editableTarget(event.target) || !canMutate) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length || !event.clipboardData) return;
      event.preventDefault();
      const explorer = activeExplorer();
      void snapshotFromClipboardItems(event.clipboardData.items).then((snapshot) => snapshot
        ? beginPasteRef.current(explorer?.folderId ?? null, undefined, snapshot)
        : handleImportRef.current(files, explorer?.folderId ?? null)).catch((pasteError) => setError(pasteError instanceof Error ? pasteError.message : "Clipboard files could not be pasted."));
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("paste", onPaste); };
  }, [activeDesktopPage.entries, canMutate, dialog, moveDialogEntryIds.length, pendingPaste, selectionSurface, workspace]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const owner = topOverlay({
        dialog: Boolean(dialog),
        moveDialog: moveDialogEntries.length > 0,
        settings: false,
        contextMenu: Boolean(contextMenu),
        file: false,
        explorer: false,
        viewEditor: editingViews,
      });
      if (!owner && !focusedAppIdRef.current) return;
       if (owner === "moveDialog" && moveDialogSubmitting) return;
      event.preventDefault();
      if (owner === "dialog") setDialog(null);
       else if (owner === "moveDialog") setMoveDialogEntryIds([]);
      else if (owner === "contextMenu") setContextMenu(null);
      else if (owner === "viewEditor") { setEditingViews(false); setDraggedPageKey(null); }
      else if (focusedAppIdRef.current) closeAppRef.current(focusedAppIdRef.current);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenu, dialog, editingViews, moveDialogEntries.length, moveDialogSubmitting]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function childrenCount(parentId: string | null) {
    return parentId !== null ? workspace.children.get(parentId)?.length ?? 0 : activeDesktopPage.entries.length;
  }

  function positionFor(parentId: string | null) {
    if (parentId === null) {
      const pageCount = childrenCount(null);
      const occupied = activeDesktopPage.entries.map((entry) => responsive.positions.get(entry.id) ?? projectLogicalPosition(entry.position, desktopSize).local);
      const localPosition = nextAvailableDesktopSlot(desktopSize, occupied, responsive.pages.length > 1, pageCount, iconMetrics);
      return restoreLogicalPosition(localPosition, activeSegment, desktopSize);
    }
    const position = nextDesktopPosition(childrenCount(parentId), window.innerHeight, undefined, iconMetrics);
    return position;
  }

  function snapPositionInView(position: EntryPosition) {
    return {
      x: snapAxis(position.x, GRID_ORIGIN.x, iconMetrics.stepX, Math.max(8, desktopSize.width - iconMetrics.width)),
      y: snapAxis(position.y, GRID_ORIGIN.y, iconMetrics.stepY, Math.max(8, desktopSize.height - iconMetrics.height)),
    };
  }

  function snapDesktopPosition(position: EntryPosition) {
    const logical = { x: position.x + minColumn * desktopSize.width, y: position.y + minRow * desktopSize.height };
    const projection = projectLogicalPosition(logical, desktopSize);
    const snapped = restoreLogicalPosition(snapPositionInView(projection.local), projection.segment, desktopSize);
    return { x: snapped.x - minColumn * desktopSize.width, y: snapped.y - minRow * desktopSize.height };
  }

  function positionAtDesktopPoint(clientX: number, clientY: number) {
    const bounds = desktopRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 8, y: 8 };
    const position = {
      x: Math.min(Math.max(8, desktopSize.width - iconMetrics.width), Math.max(8, clientX - bounds.left - iconMetrics.width / 2)),
      y: Math.min(Math.max(8, desktopSize.height - iconMetrics.height), Math.max(8, clientY - bounds.top - iconMetrics.height / 2)),
    };
    return layoutRef.current.snapToGrid ? snapPositionInView(position) : position;
  }

  function openDesktopContextMenu(clientX: number, clientY: number) {
    window.getSelection()?.removeAllRanges();
    replaceSelection("desktop", []);
    setContextMenu({ type: "desktop", parentId: null, x: clientX, y: clientY, position: positionAtDesktopPoint(clientX, clientY) });
  }

  function openEntryContextMenu(entryId: string, clientX: number, clientY: number) {
    window.getSelection()?.removeAllRanges();
    setContextMenu({ type: "entry", entryId, x: clientX, y: clientY });
  }

  function chooseUpload(parentId: string | null, position?: EntryPosition) {
    if (!canMutate) return;
    uploadParentRef.current = parentId;
    uploadPositionRef.current = position;
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

  async function changeTheme(themeId: string) {
    if (!canMutate) return;
    setThemePreview(null);
    try {
      setAppearance(await selectTheme(themeId));
    } catch (themeError) {
      setError(themeError instanceof Error ? themeError.message : "The selected theme could not be saved.");
      throw themeError;
    }
  }

  async function persistCustomTheme(theme: CustomTheme) {
    if (!canMutate) return;
    try {
      const saved = await saveCustomTheme(theme);
      setAppearance(await selectTheme(saved.id));
      setThemePreview(null);
      setNotice(`${saved.name} saved`);
    } catch (themeError) {
      setError(themeError instanceof Error ? themeError.message : "The custom theme could not be saved.");
      throw themeError;
    }
  }

  async function removeCustomTheme(themeId: string) {
    if (!canMutate) return;
    try {
      setAppearance(await deleteCustomTheme(themeId));
      setThemePreview(null);
      setNotice("Custom theme deleted");
    } catch (themeError) {
      setError(themeError instanceof Error ? themeError.message : "The custom theme could not be deleted.");
      throw themeError;
    }
  }

  async function checkForUpdate() {
    const updater = updaterRef.current;
    if (!updater?.supported || updateChecking) return;
    if (updateReady) {
      setUpdateBlocked(false);
      setShowUpdateToast(true);
      return;
    }
    manualUpdateCheckRef.current = true;
    setUpdateChecking(true);
    try {
      const result = await updater.check();
      if (result === "current") setNotice("Hiraya is already up to date.");
    } catch {
      setError("Hiraya could not check for frontend updates.");
    } finally {
      manualUpdateCheckRef.current = false;
      setUpdateChecking(false);
    }
  }

  async function changeAutoUpdate(enabled: boolean) {
    const previous = autoUpdateRef.current;
    autoUpdateRef.current = enabled;
    setAutoUpdate(enabled);
    try {
      await saveLocalPreferences({ autoUpdate: enabled });
      if (enabled) void updaterRef.current?.check().catch(() => setError("Hiraya could not check for frontend updates."));
    } catch {
      autoUpdateRef.current = previous;
      setAutoUpdate(previous);
      setError("The local update preference could not be saved.");
    }
  }

  async function activateUpdate() {
    if (Object.values(fileDirtyRef.current).some(Boolean)) {
      setUpdateBlocked(true);
      return;
    }
    const updater = updaterRef.current;
    if (!updater) return;
    setUpdateBlocked(false);
    setUpdateApplying(true);
    try {
      await updater.activate();
    } catch {
      setUpdateApplying(false);
      setError("The frontend update could not be applied.");
    }
  }

  async function handleDialogSubmit(name: string) {
    if (!dialog || !canMutate) return;
    if (dialog.type === "create-file" || dialog.type === "create-folder") {
      const parentId = dialog.parentId;
      const created = dialog.type === "create-file"
        ? await createTextFile(name, parentId, dialog.position ?? positionFor(parentId))
        : await createFolder(name, parentId, dialog.position ?? positionFor(parentId));
      setEntries((current) => current.some((entry) => entry.id === created.id) ? current : [...current, created]);
      replaceSelection(parentId === null ? "desktop" : `explorer:${parentId}`, [created.id]);
      setNotice(`${created.name} created`);
    } else if (dialog.type === "rename") {
      if (!dialogEntry) { setDialog(null); return; }
      const renamed = await renameEntry(dialogEntry.id, name);
      setEntries((current) => current.map((entry) => entry.id === renamed.id ? renamed : entry));
      updateRunningApps((current) => current.map((app) => app.kind === "file" && app.fileId === renamed.id ? {
        ...app,
        file: renamed as FileEntry,
        editable: renamed.kind === "file" ? fileCapabilities(renamed).editable : app.editable,
      } : app));
      setNotice(`${renamed.kind === "folder" ? "Folder" : "File"} renamed`);
    } else {
      if (!dialogEntry) { setDialog(null); return; }
      const ids = dialog.type === "delete" ? dialog.entryIds : [];
      const deleted = await deleteEntries(ids);
      const deletedIds = new Set(deleted.map((entry) => entry.id));
      setEntries((current) => current.filter((entry) => !deletedIds.has(entry.id)));
      replaceSelection(selectionSurface, selectedIdsRef.current.filter((id) => !deletedIds.has(id)));
      setNotice(`${ids.length === 1 ? dialogEntry.name : `${ids.length} items`} deleted`);
    }
    setDialog(null);
  }

  async function handleImport(sources: File[], parentId: string | null, base?: EntryPosition) {
    if (!sources.length || !canMutate) return;
    setError("");
    try {
      const offset = childrenCount(parentId);
      const occupied = parentId === null
        ? activeDesktopPage.entries.map((entry) => responsive.positions.get(entry.id) ?? projectLogicalPosition(entry.position, desktopSize).local)
        : [];
      const positions = sources.map((_, index) => {
        if (parentId !== null) return nextDesktopPosition(offset + index, window.innerHeight, base, iconMetrics);
        const localPosition = base && index === 0
          ? layoutRef.current.snapToGrid ? snapPositionInView(base) : base
          : nextAvailableDesktopSlot(desktopSize, occupied, responsive.pages.length > 1, offset + index, iconMetrics);
        occupied.push(localPosition);
        return restoreLogicalPosition(localPosition, activeSegment, desktopSize);
      });
      const imported = await importFiles(sources, parentId, positions);
      setEntries((current) => {
        const existingIds = new Set(current.map((entry) => entry.id));
        return [...current, ...imported.filter((entry) => !existingIds.has(entry.id))];
      });
      replaceSelection(parentId === null ? "desktop" : `explorer:${parentId}`, imported.map((entry) => entry.id));
      setNotice(`${imported.length} ${imported.length === 1 ? "file" : "files"} added`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "The upload could not be completed.");
    }
  }
  handleImportRef.current = handleImport;

  async function handleDesktopMove(entry: DesktopEntry, position: EntryPosition, targetParentId: string | null) {
    if (!canMutate) return false;
    if (targetParentId) {
      return handleMoveTo(selectedIdSet.has(entry.id) ? selectedEntries : [entry], targetParentId, true);
    }
    const finalPosition = layoutRef.current.snapToGrid ? snapDesktopPosition(position) : position;
    const logicalCanvasPosition = {
      x: finalPosition.x + minColumn * desktopSize.width,
      y: finalPosition.y + minRow * desktopSize.height,
    };
    const projected = projectLogicalPosition(logicalCanvasPosition, desktopSize);
    const targetSegment = edgeNavigationRef.current?.targetSegment ?? projected.segment;
    const localPosition = {
      x: Math.min(Math.max(8, desktopSize.width - iconMetrics.width), Math.max(8, logicalCanvasPosition.x - targetSegment.column * desktopSize.width)),
      y: Math.min(Math.max(8, desktopSize.height - iconMetrics.height), Math.max(8, logicalCanvasPosition.y - targetSegment.row * desktopSize.height)),
    };
    const logicalPosition = restoreLogicalPosition(localPosition, targetSegment, desktopSize);
    const group = selectedIdSet.has(entry.id) ? selectedEntries.filter((item) => item.parentId === null) : [entry];
    if (group.length > 1) {
      const delta = { x: logicalPosition.x - entry.position.x, y: logicalPosition.y - entry.position.y };
      const updates = group.map((item) => ({ entryId: item.id, position: { x: item.position.x + delta.x, y: item.position.y + delta.y } }));
      const previous = new Map(group.map((item) => [item.id, item.position]));
      const nextPositions = new Map(updates.map((item) => [item.entryId, item.position]));
      setEntries((current) => current.map((item) => nextPositions.has(item.id) ? { ...item, position: nextPositions.get(item.id)! } : item));
      try { await updateDesktopPositions(updates); return true; }
      catch {
        setEntries((current) => current.map((item) => previous.has(item.id) ? { ...item, position: previous.get(item.id)! } : item));
        setError("The selected icon positions could not be saved.");
        return false;
      }
    }
    setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, position: logicalPosition } : item));
    try {
      await updateEntryPosition(entry.id, logicalPosition);
      return true;
    } catch {
      setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, position: entry.position } : item));
      setError("The new icon position could not be saved.");
      return false;
    }
  }

  async function handleMoveTo(items: readonly DesktopEntry[], parentId: string | null, bubbleError = false) {
    if (!canMutate) return false;
    setError("");
    try {
      if (items.every((entry) => entry.parentId === parentId)) return true;
      const moved = await moveEntries(items.map((entry) => entry.id), parentId);
      const movedById = new Map(moved.map((entry) => [entry.id, entry]));
      setEntries((current) => current.map((item) => movedById.get(item.id) ?? item));
      replaceSelection(selectionSurface, []);
      setContextMenu(null);
      setNotice(items.length === 1 ? `${items[0].name} moved` : `${items.length} items moved`);
      return true;
    } catch (moveError) {
      const message = moveError instanceof Error ? moveError.message : "The item could not be moved.";
      setError(message);
      if (bubbleError) throw moveError;
      return false;
    }
  }

  function openExplorerWindow(folderId: string | null) {
    const id = `explorer:${folderId ?? "root"}`;
    if (runningAppsRef.current.some((app) => app.id === id)) {
      focusApp(id);
      return;
    }
    const app: ExplorerApp = { ...createAppBase(id, 760, 590, 360, 280), kind: "explorer", folderId };
    updateRunningApps((current) => [...current, app]);
    setFocusedApp(id);
  }

  function navigateExplorerWindow(appId: string, folderId: string | null) {
    const nextId = `explorer:${folderId ?? "root"}`;
    if (nextId === appId) return;
    if (runningAppsRef.current.some((app) => app.id === nextId)) {
      closeApp(appId);
      focusApp(nextId);
    } else {
      const zIndex = ++nextWindowZRef.current;
      updateRunningApps((current) => current.map((app) => app.id === appId && app.kind === "explorer" ? { ...app, id: nextId, folderId, zIndex } : app));
      setFocusedApp(nextId);
    }
    const currentRoute = routeRef.current;
    if (currentRoute) navigateRoute({ column: currentRoute.column, row: currentRoute.row, explorerFolderId: folderId });
  }

  function openSettingsWindow() {
    const id = "settings";
    if (runningAppsRef.current.some((app) => app.id === id)) {
      focusApp(id);
      return;
    }
    const app: SettingsApp = { ...createAppBase(id, 720, 700, 360, 280), kind: "settings" };
    updateRunningApps((current) => [...current, app]);
    setFocusedApp(id);
    const currentRoute = routeRef.current;
    if (currentRoute) navigateRoute({ column: currentRoute.column, row: currentRoute.row }, "replace");
  }

  function openFileWindow(file: FileEntry) {
    const id = `file:${file.id}`;
    if (runningAppsRef.current.some((app) => app.id === id)) {
      focusApp(id);
      return;
    }
    const expectedRevision = contentRevisionsRef.current[file.id] ?? 0;
    const app: FileApp = {
      ...createAppBase(id, 920, 680, 420, 320),
      kind: "file",
      fileId: file.id,
      file,
      contentRevision: expectedRevision,
      remoteChanged: false,
    };
    updateRunningApps((current) => [...current, app]);
    setFocusedApp(id);
    const generation = (fileLoadGenerationsRef.current[id] ?? 0) + 1;
    fileLoadGenerationsRef.current[id] = generation;
    void readFile(file.id).then((blob) => {
      if (fileLoadGenerationsRef.current[id] !== generation || !runningAppsRef.current.some((candidate) => candidate.id === id)) return;
      updateRunningApps((current) => current.map((candidate) => candidate.id === id && candidate.kind === "file" ? {
        ...candidate,
        blob,
        editable: fileCapabilities(file).editable,
        contentRevision: expectedRevision,
      } : candidate));
    }).catch((openError) => {
      if (fileLoadGenerationsRef.current[id] !== generation) return;
      closeApp(id);
      setError(openError instanceof Error ? openError.message : "The file could not be opened.");
    });
  }

  function handleOpen(entry: DesktopEntry) {
    setContextMenu(null);
    const currentRoute = routeRef.current;
    if (!currentRoute) return;
    if (entry.kind === "folder") {
      openExplorerWindow(entry.id);
      navigateRoute({ column: currentRoute.column, row: currentRoute.row, explorerFolderId: entry.id });
      return;
    }
    setError("");
    openFileWindow(entry);
    navigateRoute({ column: currentRoute.column, row: currentRoute.row, fileId: entry.id });
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

  async function copySelection() {
    if (!selectedIdsRef.current.length) return;
    setError("");
    try {
      const snapshot = await captureEntries(selectedIdsRef.current);
      clipboardRef.current = snapshot;
      if (navigator.clipboard?.write && "ClipboardItem" in window) {
        try {
          const archive = await encodeClipboardArchive(snapshot);
          const summary = snapshot.selectedRootIds.map((id) => snapshot.entries.find((entry) => entry.id === id)?.name).filter(Boolean).join("\n");
          await navigator.clipboard.write([new ClipboardItem({ [CLIPBOARD_ARCHIVE_WEB_MIME_TYPE]: archive, "text/plain": new Blob([summary], { type: "text/plain" }) })]);
        } catch { /* The durable in-app clipboard remains available. */ }
      }
      setContextMenu(null);
      setNotice(`${snapshot.selectedRootIds.length} ${snapshot.selectedRootIds.length === 1 ? "item" : "items"} copied`);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "The selected items could not be copied.");
    }
  }

  function pastePositions(snapshot: ClipboardEntrySnapshot, parentId: string | null, base?: EntryPosition) {
    const roots = snapshot.selectedRootIds.map((id) => snapshot.entries.find((entry) => entry.id === id)!);
    const positions = new Map<string, EntryPosition>();
    if (parentId !== null) {
      roots.forEach((entry, index) => positions.set(entry.id, nextDesktopPosition(childrenCount(parentId) + index, window.innerHeight, undefined, iconMetrics)));
      return positions;
    }
    const first = roots[0];
    const origin = base ? restoreLogicalPosition(base, activeSegment, desktopSize) : positionFor(null);
    for (const entry of roots) positions.set(entry.id, { x: origin.x + entry.position.x - first.position.x, y: origin.y + entry.position.y - first.position.y });
    return positions;
  }

  async function commitPaste(snapshot: ClipboardEntrySnapshot, parentId: string | null, position: EntryPosition | undefined, names: Map<string, string>) {
    const pasted = await pasteEntries(snapshot, parentId, names, pastePositions(snapshot, parentId, position));
    const pastedIds = new Set(pasted.map((entry) => entry.id));
    const rootIds = pasted.filter((entry) => !pastedIds.has(entry.parentId ?? "")).map((entry) => entry.id);
    replaceSelection(parentId === null ? "desktop" : `explorer:${parentId}`, rootIds);
    setPendingPaste(null);
    setContextMenu(null);
    setNotice(`${rootIds.length} ${rootIds.length === 1 ? "item" : "items"} pasted`);
  }

  async function beginPaste(parentId: string | null, position?: EntryPosition, supplied?: ClipboardEntrySnapshot) {
    if (!canMutate) return;
    setError("");
    let snapshot = supplied ?? clipboardRef.current;
    if (!supplied && navigator.clipboard?.read) {
      try {
        const item = (await navigator.clipboard.read()).find((candidate) => candidate.types.some((type) => type.includes("x-hiraya-entry-archive")));
        if (item) snapshot = await decodeClipboardArchiveItem(item);
      } catch { /* Permission denial falls back to the in-app clipboard. */ }
    }
    if (!snapshot) { setError("Nothing has been copied in Hiraya yet."); return; }
    const roots = snapshot.selectedRootIds.map((id) => snapshot!.entries.find((entry) => entry.id === id)!);
    const existingNames = entriesRef.current.filter((entry) => entry.parentId === parentId).map((entry) => entry.name);
    const conflicts = roots.some((entry, index) => existingNames.some((name) => namesMatch(name, entry.name)) || roots.slice(0, index).some((previous) => namesMatch(previous.name, entry.name)));
    if (conflicts) { setPendingPaste({ snapshot, parentId, position }); setContextMenu(null); return; }
    try {
      await commitPaste(snapshot, parentId, position, new Map(roots.map((entry) => [entry.id, entry.name])));
    } catch (pasteError) {
      setError(pasteError instanceof Error ? pasteError.message : "The copied items could not be pasted.");
    }
  }
  beginPasteRef.current = beginPaste;

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

  async function save(appId: string, fileId: string, content: string) {
    const app = runningAppsRef.current.find((candidate) => candidate.id === appId);
    if (app?.kind !== "file" || app.fileId !== fileId) return;
    const saved = await saveTextFile(fileId, content);
    setEntries((current) => current.map((entry) => entry.id === saved.id ? saved : entry));
    updateRunningApps((current) => current.map((candidate) => candidate.id === appId && candidate.kind === "file" ? { ...candidate, file: saved, contentRevision: contentRevisionsRef.current[saved.id] ?? candidate.contentRevision, remoteChanged: false } : candidate));
    setNotice(syncStatus === "local" ? "Changes saved locally" : syncStatus === "offline" ? "Changes queued for sync" : "Changes synced");
  }

  function goToSegment(segment: { column: number; row: number }, mode: "push" | "replace" = "push") {
    const currentRoute = routeRef.current;
    if (!currentRoute) return;
    if (canvasRef.current) {
      const nextMinColumn = Math.min(responsive.minColumn, segment.column);
      const nextMinRow = Math.min(responsive.minRow, segment.row);
      canvasRef.current.style.transform = `translate3d(${-(segment.column - nextMinColumn) * desktopSize.width}px, ${-(segment.row - nextMinRow) * desktopSize.height}px, 0)`;
    }
    navigateRoute({ ...currentRoute, ...segment }, mode);
  }

  function handleDesktopPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".file-icon, .empty-state__actions, .app-window")) return;
    if (event.pointerType !== "touch") {
      event.preventDefault();
      const additive = event.metaKey || event.ctrlKey;
      const initial = additive && selectionSurface === "desktop" ? [...selectedIdsRef.current] : [];
      if (!additive) replaceSelection("desktop", []);
      marqueeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, additive, initial };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    event.preventDefault();
    swipeRef.current = { axis: null, pointerId: event.pointerId, startSegment: activeSegment, startTime: performance.now(), startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    if (event.pointerType !== "touch") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const press = {
      activated: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
    };
    press.timer = window.setTimeout(() => {
      if (desktopPressRef.current !== press) return;
      press.activated = true;
      swipeRef.current = null;
      suppressClickRef.current = true;
      openDesktopContextMenu(press.startX, press.startY);
    }, DESKTOP_LONG_PRESS_MS);
    desktopPressRef.current = press;
  }

  function handleIconDragAtEdge(entry: DesktopEntry, clientX: number, clientY: number) {
    const desktop = desktopRef.current;
    if (!desktop) return null;
    const bounds = desktop.getBoundingClientRect();
    const threshold = Math.min(36, Math.max(24, Math.min(bounds.width, bounds.height) * 0.06));
    const candidates: Array<{ direction: "left" | "right" | "up" | "down"; distance: number }> = [
      { direction: "left" as const, distance: clientX - bounds.left },
      { direction: "right" as const, distance: bounds.right - clientX },
      { direction: "up" as const, distance: clientY - bounds.top },
      { direction: "down" as const, distance: bounds.bottom - clientY },
    ].filter((candidate) => candidate.distance <= threshold).sort((a, b) => a.distance - b.distance);
    const edge = candidates[0];
    if (!edge) {
      edgeDragRef.current.direction = "";
      return null;
    }
    const now = performance.now();
    if (edgeDragRef.current.direction === edge.direction && now - edgeDragRef.current.time < 520) return null;
    const previousSegment = edgeNavigationRef.current?.targetSegment ?? activeSegment;
    const targetSegment = {
      column: previousSegment.column + (edge.direction === "left" ? -1 : edge.direction === "right" ? 1 : 0),
      row: previousSegment.row + (edge.direction === "up" ? -1 : edge.direction === "down" ? 1 : 0),
    };
    if (!edgeNavigationRef.current && routeRef.current) {
      edgeNavigationRef.current = { route: routeRef.current, historyState: window.history.state, draftEntryId: entry.id };
    }
    const pending = edgeNavigationRef.current;
    if (!pending || pending.draftEntryId !== entry.id) return null;
    pending.targetSegment = targetSegment;
    const targetMinColumn = Math.min(responsive.minColumn, targetSegment.column);
    const targetMinRow = Math.min(responsive.minRow, targetSegment.row);
    const targetMaxColumn = Math.max(responsive.maxColumn, targetSegment.column);
    const targetMaxRow = Math.max(responsive.maxRow, targetSegment.row);
    const previousViewColumn = previousSegment.column - minColumn;
    const previousViewRow = previousSegment.row - minRow;
    const targetViewColumn = targetSegment.column - targetMinColumn;
    const targetViewRow = targetSegment.row - targetMinRow;
    edgeDragRef.current = { direction: edge.direction, time: now };
    goToSegment(targetSegment, "replace");
    return {
      deltaX: (targetViewColumn - previousViewColumn) * desktopSize.width,
      deltaY: (targetViewRow - previousViewRow) * desktopSize.height,
      maxX: Math.max(8, (targetMaxColumn - targetMinColumn + 1) * desktopSize.width - iconMetrics.width),
      maxY: Math.max(8, (targetMaxRow - targetMinRow + 1) * desktopSize.height - iconMetrics.height),
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
    const marqueePress = marqueeRef.current;
    if (marqueePress?.pointerId === event.pointerId) {
      const left = Math.min(marqueePress.startX, event.clientX);
      const top = Math.min(marqueePress.startY, event.clientY);
      const right = Math.max(marqueePress.startX, event.clientX);
      const bottom = Math.max(marqueePress.startY, event.clientY);
      if (Math.hypot(event.clientX - marqueePress.startX, event.clientY - marqueePress.startY) < 4) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      setMarquee({ left: left - bounds.left, top: top - bounds.top, width: right - left, height: bottom - top });
      const hits = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".file-icon[data-entry-id]")).filter((icon) => {
        const rect = icon.getBoundingClientRect();
        return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
      }).map((icon) => icon.dataset.entryId!).filter(Boolean);
      replaceSelection("desktop", [...marqueePress.initial, ...hits]);
      return;
    }
    const press = desktopPressRef.current;
    if (press?.pointerId === event.pointerId) {
      if (press.activated) {
        event.preventDefault();
        return;
      }
      if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) >= 7) {
        window.clearTimeout(press.timer);
        desktopPressRef.current = null;
      }
    }
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
    const startColumn = swipe.startSegment.column - minColumn;
    const startRow = swipe.startSegment.row - minRow;
    const x = -startColumn * desktopSize.width + (swipe.axis === "x" ? deltaX : 0);
    const y = -startRow * desktopSize.height + (swipe.axis === "y" ? deltaY : 0);
    canvasRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function finishDesktopSwipe(event: React.PointerEvent<HTMLElement>) {
    if (marqueeRef.current?.pointerId === event.pointerId) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      marqueeRef.current = null;
      setMarquee(null);
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      return;
    }
    const press = desktopPressRef.current;
    if (press?.pointerId === event.pointerId) {
      window.clearTimeout(press.timer);
      desktopPressRef.current = null;
      if (press.activated) {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        swipeRef.current = null;
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
        return;
      }
    }
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const delta = swipe.axis === "x" ? swipe.x - swipe.startX : swipe.y - swipe.startY;
    const distance = swipe.axis === "x" ? desktopSize.width : desktopSize.height;
    const velocity = Math.abs(delta) / Math.max(1, performance.now() - swipe.startTime);
    const advance = swipe.axis && (Math.abs(delta) > distance * 0.16 || velocity > 0.45) ? (delta < 0 ? 1 : -1) : 0;
    const nextSegment = { ...swipe.startSegment };
    if (swipe.axis === "x") nextSegment.column += advance;
    if (swipe.axis === "y") nextSegment.row += advance;
    suppressClickRef.current = swipe.axis !== null;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    swipeRef.current = null;
    if (canvasRef.current) delete canvasRef.current.dataset.swiping;
    goToSegment(nextSegment);
  }

  function previewPageMove(pageKey: string, targetIndex: number) {
    const currentPages = responsiveDesktop(entriesRef.current, desktopSize, iconMetrics).pages;
    const updates = reorderDesktopPages(currentPages, pageKey, targetIndex, desktopSize);
    if (!updates.length) return null;
    const positions = new Map(updates.map((update) => [update.entryId, update.position]));
    const targetKey = currentPages[Math.max(0, Math.min(currentPages.length - 1, targetIndex))]?.key ?? pageKey;
    const next = entriesRef.current.map((entry) => positions.has(entry.id) ? { ...entry, position: positions.get(entry.id)! } : entry);
    entriesRef.current = next;
    setEntries(next);
    return targetKey;
  }

  function restoreArrangement(initialPositions: Array<{ entryId: string; position: EntryPosition }>) {
    const initial = new Map(initialPositions.map((update) => [update.entryId, update.position]));
    const next = entriesRef.current.map((entry) => initial.has(entry.id) ? { ...entry, position: initial.get(entry.id)! } : entry);
    entriesRef.current = next;
    setEntries(next);
  }

  function persistArrangement(initialPositions: Array<{ entryId: string; position: EntryPosition }>) {
    const updates = entriesRef.current
      .filter((entry) => entry.parentId === null)
      .map((entry) => ({ entryId: entry.id, position: entry.position }));
    void updateDesktopPositions(updates).catch(() => {
      restoreArrangement(initialPositions);
      setError("The workspace arrangement could not be saved.");
    });
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
      initialPositions: entriesRef.current
        .filter((entry) => entry.parentId === null)
        .map((entry) => ({ entryId: entry.id, position: { ...entry.position } })),
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
    const currentPages = responsiveDesktop(entriesRef.current, desktopSize, iconMetrics).pages;
    const targetIndex = currentPages.findIndex((candidate) => candidate.key === target.dataset.pageKey);
    const targetKey = previewPageMove(press.pageKey, targetIndex);
    if (targetKey) {
      press.pageKey = targetKey;
      setDraggedPageKey(targetKey);
    }
  }

  function finishMinimapPress(event: React.PointerEvent<HTMLButtonElement>, cancelled = false) {
    const press = minimapPointerRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    window.clearTimeout(press.timer);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    minimapPointerRef.current = null;
    if (press.activated && cancelled) {
      restoreArrangement(press.initialPositions);
      setDraggedPageKey(null);
    } else if (press.activated) {
      setDraggedPageKey(null);
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      persistArrangement(press.initialPositions);
    } else if (!cancelled) {
      const selectedPage = responsiveDesktop(entriesRef.current, desktopSize, iconMetrics).pages.find((candidate) => candidate.key === press.pageKey);
      if (selectedPage) goToSegment(selectedPage.segment);
    }
  }

  function invalidMoveIds(items: readonly DesktopEntry[]) {
    return new Set(items.flatMap((entry) => [entry.id, ...workspace.descendants(entry.id).map((descendant) => descendant.id)]));
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
    <main className="desktop-shell" data-theme={isBuiltinThemeId(appearance.selectedThemeId) ? appearance.selectedThemeId : "custom"} style={themeStyle(activeTheme)}>
      <header className="menu-bar">
        <div className="brand-mark" aria-label="Hiraya Desktop"><span className="brand-mark__shape"><span /></span><strong>Hiraya</strong></div>
        <nav className="taskbar" aria-label="Running apps">
          {runningApps.map((app) => {
            const entry = app.kind === "file" ? workspace.byId.get(app.fileId) : app.kind === "explorer" && app.folderId ? workspace.byId.get(app.folderId) : null;
            const label = app.kind === "settings" ? "Settings" : app.kind === "explorer" ? entry?.name ?? "Desktop" : entry?.name ?? app.file?.name ?? "File";
            return (
              <button
                className="taskbar__entry"
                data-active={focusedAppId === app.id && !app.minimized || undefined}
                data-minimized={app.minimized || undefined}
                type="button"
                key={app.id}
                title={label}
                aria-label={`${app.minimized ? "Restore" : focusedAppId === app.id && !isMobile ? "Minimize" : "Switch to"} ${label}`}
                aria-pressed={focusedAppId === app.id && !app.minimized}
                onClick={() => focusedAppId === app.id && !app.minimized && !isMobile ? minimizeApp(app.id) : focusApp(app.id)}
              >
                {app.kind === "file" ? entry?.kind === "file" && fileCapabilities(entry).preview === "url" ? <LinkSimple size={15} /> : <FileGlyph size={15} /> : app.kind === "explorer" ? <Folder size={15} /> : <GearSix size={15} />}
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
        <div className="menu-bar__actions">
          <button type="button" aria-label="New file" disabled={!canMutate} onClick={() => setDialog({ type: "create-file", parentId: null })}><Plus size={15} weight="bold" /> <span>New file</span></button>
          <button type="button" aria-label="New folder" disabled={!canMutate} onClick={() => setDialog({ type: "create-folder", parentId: null })}><FolderPlus size={16} /> <span>New folder</span></button>
          <button type="button" aria-label="Upload files" disabled={!canMutate} onClick={() => chooseUpload(null)}><UploadSimple size={16} /> <span>Upload</span></button>
          <button type="button" aria-label="Open settings" title="Settings" onClick={openSettingsWindow}><GearSix size={16} /> <span>Settings</span></button>
          <span className="menu-bar__sync" data-status={syncIndicatorStatus} role="status" title={syncIndicatorStatus === "local" ? "Changes are saved in this browser" : syncIndicatorStatus === "syncing" ? "Syncing changes" : syncIndicatorStatus === "online" ? "Changes are synced" : syncIndicatorStatus === "connecting" ? "Connecting to sync server" : syncIndicatorStatus === "blocked" ? "A queued change needs attention before synchronization can continue" : "Offline changes are saved and will sync after reconnecting"}>
            {syncIndicatorStatus === "local" ? <HardDrive size={15} /> : syncIndicatorStatus === "online" ? <CloudCheck size={15} /> : syncIndicatorStatus === "blocked" ? <WarningCircle size={15} weight="fill" /> : syncIndicatorStatus === "connecting" || syncIndicatorStatus === "syncing" ? <SpinnerGap size={15} /> : <CloudSlash size={15} />}
            <span>{syncIndicatorStatus === "local" ? "Saved locally" : syncIndicatorStatus === "syncing" ? "Syncing" : syncIndicatorStatus === "online" ? "Synced" : syncIndicatorStatus === "connecting" ? "Connecting" : syncIndicatorStatus === "blocked" ? "Sync blocked" : "Offline"}</span>
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
        onClick={(event) => { if (!(event.target as Element).closest(".file-icon, .empty-state__actions, .app-window")) replaceSelection("desktop", []); }}
        onContextMenu={(event) => {
          if ((event.target as Element).closest(".file-icon, .empty-state__actions, .app-window")) return;
          event.preventDefault();
          const press = desktopPressRef.current;
          if (press) {
            window.clearTimeout(press.timer);
            press.activated = true;
          }
          swipeRef.current = null;
          openDesktopContextMenu(event.clientX, event.clientY);
        }}
        onDragOver={(event) => { if (!canMutate) return; event.preventDefault(); event.currentTarget.dataset.dropActive = "true"; }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) delete event.currentTarget.dataset.dropActive; }}
        onDrop={(event) => {
          if (!canMutate) return;
          event.preventDefault();
          delete event.currentTarget.dataset.dropActive;
          const bounds = event.currentTarget.getBoundingClientRect();
          void handleImport(Array.from(event.dataTransfer.files), null, {
            x: event.clientX - bounds.left - iconMetrics.width / 2,
            y: event.clientY - bounds.top - iconMetrics.height / 2,
          });
        }}
        onPointerDown={handleDesktopPointerDown}
        onPointerMove={handleDesktopPointerMove}
        onPointerUp={finishDesktopSwipe}
        onPointerCancel={finishDesktopSwipe}
      >
        <div className="wallpaper-grain" aria-hidden="true" />
        <div className="desktop-canvas" ref={canvasRef} style={{ width: pageColumns * desktopSize.width, height: pageRows * desktopSize.height, transform: `translate3d(${-page.column * desktopSize.width}px, ${-page.row * desktopSize.height}px, 0)` }}>
          {responsive.pages.flatMap((desktopPage) => desktopPage.entries.map((entry) => {
            const viewColumn = desktopPage.segment.column - minColumn;
            const viewRow = desktopPage.segment.row - minRow;
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
              selected={selectedIdSet.has(entry.id)}
              onSelect={(event) => selectEntry("desktop", entry, { toggle: event.metaKey || event.ctrlKey })}
              onOpen={() => void handleOpen(entry)}
              onMove={(position, targetParentId) => handleDesktopMove(entry, position, targetParentId)}
              onDragAtEdge={(clientX, clientY) => handleIconDragAtEdge(entry, clientX, clientY)}
              onDragEnd={finishEdgeNavigation}
              getSnapPreview={layout.snapToGrid ? snapDesktopPosition : undefined}
              onExternalDrop={(sources) => void handleImport(sources, entry.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!selectedIdSet.has(entry.id)) replaceSelection("desktop", [entry.id]);
                openEntryContextMenu(entry.id, event.clientX, event.clientY);
              }}
            />;
          }))}
        </div>
        {marquee && <div className="desktop-marquee" aria-hidden="true" style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }} />}

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

        <div className="app-window-layer" aria-label="Running applications">
          {runningApps.map((app, index) => {
            const titleId = `running-app-title-${index}`;
            const folderEntry = app.kind === "explorer" && app.folderId ? workspace.byId.get(app.folderId) : null;
            const folder = folderEntry?.kind === "folder" ? folderEntry : null;
            const fileEntry = app.kind === "file" ? app.file ?? workspace.byId.get(app.fileId) : null;
            const file = fileEntry?.kind === "file" ? fileEntry : null;
            const title = app.kind === "settings" ? "Settings" : app.kind === "explorer" ? folder?.name ?? "Desktop" : file?.name ?? "Opening file";
            return (
              <AppWindow
                key={app.id}
                id={app.id}
                title={title}
                titleId={titleId}
                bounds={app.bounds}
                minWidth={app.kind === "file" ? 420 : 360}
                minHeight={app.kind === "file" ? 320 : 280}
                zIndex={app.zIndex}
                focused={focusedAppId === app.id}
                minimized={app.minimized}
                mobile={isMobile}
                onFocus={focusApp}
                onBoundsChange={updateAppBounds}
                onMinimize={minimizeApp}
                onClose={closeApp}
                titleArea={<div><span className="window-kicker">{app.kind === "file" ? file && fileCapabilities(file).preview === "url" ? "URL editor" : app.editable ? "Text editor" : "Preview" : app.kind === "explorer" ? "Folder" : "Hiraya desktop"}</span><h2 id={titleId}>{title}</h2></div>}
              >
                {app.kind === "file" && file && app.blob ? (
                  <FileWindow
                    file={file}
                    blob={app.blob}
                    editable={Boolean(app.editable)}
                    readOnly={!canMutate}
                    remoteChanged={app.remoteChanged}
                    editorSettings={editorSettings}
                    theme={activeTheme}
                    onSave={(content) => save(app.id, file.id, content)}
                    onDownload={() => void download(file)}
                    onEditorSettingsChange={applyEditorSettings}
                    onResolveLink={(path) => readFileByRelativePath(file.id, path)}
                    onOpenLinkedFile={handleOpen}
                    onDirtyChange={(dirty) => { fileDirtyRef.current[app.id] = dirty; }}
                  />
                ) : app.kind === "file" ? <div className="app-window__loading"><SpinnerGap size={22} /> Opening file</div> : null}
                {app.kind === "explorer" && (
                  <FolderExplorer
                    folder={folder}
                    breadcrumbs={folder ? workspace.ancestors(folder.id) : []}
                    children={workspace.children.get(folder?.id ?? null) ?? []}
                    selectedIds={selectionSurface === app.id ? selectedIdSet : new Set()}
                    onSelect={(entry, options) => selectEntry(app.id, entry, options)}
                    onNavigate={(nextFolder) => navigateExplorerWindow(app.id, nextFolder?.id ?? null)}
                    onOpen={handleOpen}
                    onCreateFolder={(parentId) => setDialog({ type: "create-folder", parentId })}
                    onCreateFile={(parentId) => setDialog({ type: "create-file", parentId })}
                    onUpload={chooseUpload}
                    onMove={(entry, parentId) => void handleMoveTo(selectionSurface === app.id && selectedIdSet.has(entry.id) ? selectedEntries : [entry], parentId)}
                    onContextMenu={(entry, x, y) => {
                      if (selectionSurface !== app.id || !selectedIdSet.has(entry.id)) replaceSelection(app.id, [entry.id]);
                      openEntryContextMenu(entry.id, x, y);
                    }}
                    onBlankContextMenu={(parentId, x, y) => {
                      window.getSelection()?.removeAllRanges();
                      replaceSelection(app.id, []);
                      setContextMenu({ type: "desktop", parentId, x, y, position: positionFor(parentId) });
                    }}
                    readOnly={!canMutate}
                  />
                )}
                {app.kind === "settings" && (
                  <SettingsWindow
                    layout={layout}
                    appearance={appearance}
                    activeTheme={activeTheme}
                    canMutate={canMutate}
                    exportDisabled={loading}
                    exporting={exporting}
                    fullscreenEnabled={document.fullscreenEnabled}
                    isFullscreen={isFullscreen}
                    updateSupported={updateSupported}
                    updateReady={updateReady}
                    updateChecking={updateChecking}
                    autoUpdate={autoUpdate}
                    onLayoutChange={applyLayout}
                    onThemeSelect={changeTheme}
                    onThemePreview={setThemePreview}
                    onThemeSave={persistCustomTheme}
                    onThemeDelete={removeCustomTheme}
                    onExport={() => void handleExport()}
                    onToggleFullscreen={() => void toggleFullscreen()}
                    onCheckForUpdate={() => void checkForUpdate()}
                    onAutoUpdateChange={(enabled) => void changeAutoUpdate(enabled)}
                  />
                )}
              </AppWindow>
            );
          })}
        </div>
      </section>

      {(pageColumns > 1 || pageRows > 1 || responsive.pages.length > 1) && (
        <nav className="desktop-minimap" data-editing={editingViews || undefined} data-obscured={minimapObscured || undefined} aria-label="Desktop workspaces">
          {editingViews && (
            <div className="desktop-minimap__toolbar">
              <span>Arrange workspaces</span>
              <button type="button" onClick={() => { setEditingViews(false); setDraggedPageKey(null); }}><Check size={12} /> Done</button>
            </div>
          )}
          <div className="desktop-minimap__grid" style={{ "--minimap-columns": pageColumns, "--minimap-rows": pageRows } as React.CSSProperties}>
            {pages.map((desktopPage) => {
              const column = desktopPage.segment.column - minColumn;
              const row = desktopPage.segment.row - minRow;
              const pageKey = desktopPage.key;
              const actualIndex = responsive.pages.findIndex((candidate) => candidate.key === pageKey);
              const isActualPage = actualIndex >= 0;
              return (
                <div className="desktop-minimap__slot" data-page-key={isActualPage ? pageKey : undefined} data-dragging={draggedPageKey === pageKey || undefined} key={pageKey} style={{ gridColumn: column + 1, gridRow: row + 1 }}>
                  <button
                    className="desktop-minimap__page"
                    data-active={pageKey === activePageKey || undefined}
                    type="button"
                    aria-label={`Workspace ${desktopPage.segment.column}, ${desktopPage.segment.row}${editingViews && isActualPage ? ", use arrow keys to move" : isActualPage ? ", long press to arrange" : ""}`}
                    aria-current={pageKey === activePageKey ? "true" : undefined}
                    onClick={(event) => { if (event.detail === 0 && !editingViews) goToSegment(desktopPage.segment); }}
                    onContextMenu={isActualPage ? (event) => { event.preventDefault(); setEditingViews(true); } : undefined}
                    onPointerDown={isActualPage ? (event) => startMinimapPress(event, pageKey) : undefined}
                    onPointerMove={moveMinimapPress}
                    onPointerUp={(event) => finishMinimapPress(event)}
                    onPointerCancel={(event) => finishMinimapPress(event, true)}
                    onKeyDown={(event) => {
                      if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
                        event.preventDefault();
                        setEditingViews(true);
                      } else if (editingViews && isActualPage && (event.key === "ArrowLeft" || event.key === "ArrowUp")) {
                        event.preventDefault();
                        const initial = entriesRef.current.filter((entry) => entry.parentId === null).map((entry) => ({ entryId: entry.id, position: { ...entry.position } }));
                        const targetKey = previewPageMove(pageKey, actualIndex - 1);
                        if (targetKey) { setDraggedPageKey(targetKey); persistArrangement(initial); }
                      } else if (editingViews && isActualPage && (event.key === "ArrowRight" || event.key === "ArrowDown")) {
                        event.preventDefault();
                        const initial = entriesRef.current.filter((entry) => entry.parentId === null).map((entry) => ({ entryId: entry.id, position: { ...entry.position } }));
                        const targetKey = previewPageMove(pageKey, actualIndex + 1);
                        if (targetKey) { setDraggedPageKey(targetKey); persistArrangement(initial); }
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
          <span className="visually-hidden" aria-live="polite">Desktop workspace column {activeSegment.column}, row {activeSegment.row}</span>
        </nav>
      )}

      <input ref={uploadRef} className="visually-hidden" type="file" multiple onChange={(event) => {
        const position = uploadPositionRef.current;
        uploadPositionRef.current = undefined;
        void handleImport(Array.from(event.target.files ?? []), uploadParentRef.current, position);
        event.target.value = "";
      }} />

      {error && <div className="error-banner" role="alert"><WarningCircle size={19} weight="fill" /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">Dismiss</button></div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {showUpdateToast && (
        <UpdateToast
          applying={updateApplying}
          blocked={updateBlocked}
          onConfirm={() => void activateUpdate()}
          onDismiss={() => { setShowUpdateToast(false); setUpdateBlocked(false); }}
        />
      )}

      {contextMenu?.type === "entry" && contextMenuEntry && (
        <ContextMenu
          menu={contextMenu}
          entry={contextMenuEntry}
          onOpen={() => handleOpen(contextMenuEntry)}
          onRename={() => { setDialog({ type: "rename", entryId: contextMenuEntry.id }); setContextMenu(null); }}
          onDownload={contextMenuEntry.kind === "file" ? () => void download(contextMenuEntry) : undefined}
          onCopy={() => void copySelection()}
          onPasteInto={contextMenuEntry.kind === "folder" && clipboardRef.current ? () => void beginPaste(contextMenuEntry.id) : undefined}
          onMove={() => { setMoveDialogSubmitting(false); setMoveDialogEntryIds(contextMenuEntries.map((entry) => entry.id)); setContextMenu(null); }}
          onDelete={() => { setDialog({ type: "delete", entryIds: contextMenuEntries.map((entry) => entry.id) }); setContextMenu(null); }}
          selectionCount={contextMenuEntries.length}
          readOnly={!canMutate}
        />
      )}
      {contextMenu?.type === "desktop" && (
        <DesktopContextMenu
          menu={contextMenu}
          onCreateFile={() => {
            setDialog({ type: "create-file", parentId: contextMenu.parentId, position: contextMenu.parentId === null ? restoreLogicalPosition(contextMenu.position, activeSegment, desktopSize) : contextMenu.position });
            setContextMenu(null);
          }}
          onCreateFolder={() => {
            setDialog({ type: "create-folder", parentId: contextMenu.parentId, position: contextMenu.parentId === null ? restoreLogicalPosition(contextMenu.position, activeSegment, desktopSize) : contextMenu.position });
            setContextMenu(null);
          }}
          onUpload={() => {
            chooseUpload(contextMenu.parentId, contextMenu.position);
            setContextMenu(null);
          }}
          onSettings={() => {
            openSettingsWindow();
            setContextMenu(null);
          }}
          onPaste={clipboardRef.current ? () => void beginPaste(contextMenu.parentId, contextMenu.parentId === null ? contextMenu.position : undefined) : undefined}
          readOnly={!canMutate}
        />
      )}
      {dialog && (!(dialog.type === "rename" || dialog.type === "delete") || dialogEntry) && <FileDialog dialog={dialog} entry={dialogEntry} entryCount={dialog.type === "delete" ? dialog.entryIds.length : 1} onClose={() => setDialog(null)} onSubmit={handleDialogSubmit} />}
      {moveDialogEntries.length > 0 && (
        <MoveDialog
          entries={moveDialogEntries}
          folders={folders}
          invalidIds={invalidMoveIds(moveDialogEntries)}
          onClose={() => { setMoveDialogSubmitting(false); setMoveDialogEntryIds([]); }}
          onMove={async (parentId) => { await handleMoveTo(moveDialogEntries, parentId, true); setMoveDialogSubmitting(false); setMoveDialogEntryIds([]); }}
          onSubmittingChange={setMoveDialogSubmitting}
        />
      )}
      {pendingPaste && <PasteConflictDialog roots={pendingPaste.snapshot.selectedRootIds.map((id) => pendingPaste.snapshot.entries.find((entry) => entry.id === id)!)} existingNames={entries.filter((entry) => entry.parentId === pendingPaste.parentId).map((entry) => entry.name)} onClose={() => setPendingPaste(null)} onPaste={(names) => commitPaste(pendingPaste.snapshot, pendingPaste.parentId, pendingPaste.position, names)} />}
    </main>
  );
}

export default App;

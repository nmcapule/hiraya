import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CloudCheck, CloudSlash, File as FileGlyph, Folder, FolderPlus, GearSix, HardDrive, Info, Keyboard, LinkSimple, MagnifyingGlass, Plus, ShareNetwork, SpinnerGap, SquaresFour, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import seededDesktop from "virtual:hiraya-seeded";
import { ContextMenu, DesktopContextMenu } from "./components/ContextMenu";
import { AppWindow } from "./components/AppWindow";
import { FileDialog } from "./components/FileDialog";
import { FileIcon } from "./components/FileIcon";
import { FileWindow } from "./components/FileWindow";
import { FolderExplorer } from "./components/FolderExplorer";
import { MoveDialog } from "./components/MoveDialog";
import { DesktopSwitcher } from "./components/DesktopSwitcher";
import type { CatalogQuota } from "./lib/desktop-catalog";
import { PasteConflictDialog } from "./components/PasteConflictDialog";
import { PropertiesWindow } from "./components/PropertiesWindow";
import { SettingsWindow } from "./components/SettingsWindow";
import { AppPickerDialog } from "./components/AppPickerDialog";
import { UpdateToast } from "./components/UpdateToast";
import {
  createFolder,
  createDesktop as createDesktopMutation,
  createTextFile,
  deleteCustomTheme,
  captureEntries,
  deleteEntries,
  deleteDesktop as deleteDesktopMutation,
  fetchServerBuildTimestamp,
  getOutboxStatus,
  importFiles,
  initializeDesktop,
  listActivity,
  listDesktops,
  moveEntries,
  transferEntries,
  pasteEntries,
  readFile,
  readFileByRelativePath,
  renameEntry,
  renameDesktop as renameDesktopMutation,
  saveCustomTheme,
  saveDesktopLayout,
  saveEditorSettings,
  saveTextFile,
  selectTheme,
  updateRootEntryPositions,
  updateEntryPosition,
  subscribeToSync,
  subscribeToActivityChanges,
  subscribeToDesktopCatalog,
  subscribeToOutbox,
  listOutboxRecords,
  retryBlockedOutboxRecord,
  discardBlockedOutboxRecord,
  isFileAvailableOffline,
  makeFileAvailableOffline,
  removeFileFromOfflineCache,
  listTrash,
  restoreTrash,
  permanentlyDeleteTrash,
  stopDesktopSync,
  type SyncStatus,
} from "./lib/sync";
import { clearAppStorage, DEFAULT_EDITOR_SETTINGS, installApp, listInstalledApps, pruneLocalDesktops, readAppStorage, readDesktopEntries, readLocalPreferences, readWindowSession, removeAppStorage, saveLocalPreferences, saveWindowSession, switchDesktop as switchLocalDesktop, uninstallApp, writeAppStorage, type DesktopStateSnapshot, type LocalPreferences } from "./lib/opfs";
import { createPwaUpdater, type PwaUpdater } from "./lib/pwa-update";
import { exportSeededDesktop } from "./lib/seeded";
import { CLIPBOARD_ARCHIVE_WEB_MIME_TYPE, decodeClipboardArchiveItem, encodeClipboardArchive, snapshotFromClipboardItems, type ClipboardEntrySnapshot } from "./lib/clipboard";
import { formatDesktopRoute, normalizeDesktopRoute, parseDesktopRoute, resolveOpenFilePath, type DesktopRoute } from "./lib/routes";
import { DEFAULT_THEME_STATE, isBuiltinThemeId, resolveTheme, themeIconMetrics, themeStyle, type CustomTheme, type ThemeDefinition, type ThemeState } from "./lib/themes";
import { DEFAULT_WALLPAPER, type ContextMenuState, type DesktopEntry, type DesktopIdentity, type DesktopLayout, type DialogState, type EditorSettings, type EntryPosition, type FileEntry } from "./types";
import { GRID_ORIGIN, nextAvailableDesktopSlot, nextRootEntryPosition, projectLogicalPosition, reorderSurfaceSegments, responsiveDesktop, restoreLogicalPosition, segmentKey, snapAxis, type SurfaceSegment } from "./ui/desktop-geometry";
import { fileCapabilities } from "./ui/file-capabilities";
import { topOverlay } from "./ui/overlay";
import { createEntryIndex } from "./ui/entry-index";
import { clampWindowBounds, initialWindowBounds, type WindowBounds } from "./ui/window-manager";
import { namesMatch } from "./lib/entry-validation";
import { createWindowSession, parseWindowTargets, restoreWindowSession, type WindowSession, type WindowTarget } from "./lib/window-session";
import { parseInternetShortcut } from "./lib/internet-shortcut";
import { createSerialTaskQueue } from "./lib/serial-task";
import { validateWallpaperImage } from "./lib/wallpaper-image";
import { AccountMenu } from "./components/AccountMenu";
import { MobileHeaderMenu } from "./components/MobileHeaderMenu";
import type { AuthSession } from "./lib/auth";
import { SearchCommandPalette } from "./components/SearchCommandPalette";
import { SyncIssuesPanel } from "./components/SyncIssuesPanel";
import { AllWindowsPanel } from "./components/AllWindowsPanel";
import { KeyboardShortcutsPanel } from "./components/KeyboardShortcutsPanel";
import { TrashWindow } from "./components/TrashWindow";
import { PanelDialog } from "./components/PanelDialog";
import { ConfirmationDialog, type ConfirmationRequest } from "./components/ConfirmationDialog";
import { SharingDialog } from "./components/SharingDialog";
import { canOpenActivity } from "./ui/activity-navigation";
import type { OutboxRecord } from "./lib/outbox";
import type { TrashItem } from "./lib/contracts";
import type { KeyboardShortcut, WindowListItem } from "./ui/panel-data";
import { canMutateDesktop, sharedOfflineMessage } from "./lib/permissions";
import { builtinAppEntryDependency, builtinAppMaximizeRestoreWindow, builtinAppTargetId, builtinAppWindow, extractBuiltinAppTarget } from "./apps/registry";
import { createAppCommandService, RuntimeCommandContributions, type AppCommandContext, type CommandId } from "./apps/commands";
import type { AppPackageInspection } from "@hiraya/app-cli";
import { isAppPackageName, RpcDispatcher } from "@hiraya/app-runtime";
import { SandboxAppFrame } from "@hiraya/app-runtime/react";
import { AppHostServices, AppLifecycleService, AppPersistentStorageService, AppThemeService, CapabilityStore, FileService, HostServiceError, grantPickedFiles, grantPickedFolder, mapThemeTokens, type AppNotification, type DialogRequest } from "./apps/host";
import { createFile as createAppFile, deleteEntry as deleteAppEntry, moveEntry as moveAppEntry, saveFile as saveAppFile } from "./lib/sync";
import { installedAppAcceptsFile, installedAppIsAvailable, packageMatchesInstall, type InstalledApp } from "./apps/installed-apps";
import { COMPACT_CHROME_QUERY, MOBILE_WINDOW_QUERY, useMediaQuery } from "./ui/responsive";

type BaseRunningApp = { id: string; bounds: WindowBounds; minimized: boolean; zIndex: number };
type FileApp = BaseRunningApp & { kind: "file"; fileId: string; file?: FileEntry; blob?: File; editable?: boolean; loadError?: string; editMode: boolean; contentRevision: number; remoteChanged: boolean };
type ExplorerApp = BaseRunningApp & { kind: "explorer"; folderId: string | null };
type SettingsApp = BaseRunningApp & { kind: "settings" };
type PropertiesApp = BaseRunningApp & { kind: "properties"; entryId: string };
type SandboxApp = BaseRunningApp & { kind: "sandbox"; fileId: string; title: string; dirty: boolean; package: AppPackageInspection; dispatcher: RpcDispatcher };
type RunningApp = FileApp | ExplorerApp | PropertiesApp | SettingsApp | SandboxApp;
type RouteHistoryState = { hiraya: true; schemaVersion: 1; parentHash?: string; apps: WindowTarget[] };
type PendingPaste = { snapshot: ClipboardEntrySnapshot; parentId: string | null; position?: EntryPosition };
const MINIMAP_LONG_PRESS_MS = 500;
const DESKTOP_LONG_PRESS_MS = 500;

function formatClock(date: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function transientMenuOpen() {
  return Boolean(document.querySelector(".mobile-header-menu__panel, .desktop-switcher__panel, .app-window__menu"));
}

function topRunningAppInSegment(apps: RunningApp[], segment: SurfaceSegment, size: { width: number; height: number }, excludedId?: string) {
  return [...apps]
    .filter((app) => {
      const appSegment = projectLogicalPosition(app.bounds, size).segment;
      return app.id !== excludedId && !app.minimized && appSegment.column === segment.column && appSegment.row === segment.row;
    })
    .sort((a, b) => b.zIndex - a.zIndex)[0] ?? null;
}

function App({ session }: { session: AuthSession | null }) {
  const commandService = useMemo(createAppCommandService, []);
  const appLifecycle = useMemo(() => new AppLifecycleService(2_000, ({ instanceId }) => closeAppRef.current(instanceId)), []);
  const appTheme = useMemo(() => new AppThemeService(resolveTheme(DEFAULT_THEME_STATE)), []);
  const appHostServices = useMemo(() => new AppHostServices(appLifecycle, appTheme, new AppPersistentStorageService({ get: readAppStorage, set: writeAppStorage, remove: removeAppStorage, clear: clearAppStorage })), [appLifecycle, appTheme]);
  const appCapabilities = useMemo(() => new CapabilityStore(), []);
  const [entries, setEntries] = useState<DesktopEntry[]>([]);
  const [desktops, setDesktops] = useState<DesktopIdentity[]>([]);
  const [catalogQuota, setCatalogQuota] = useState<CatalogQuota | null>(null);
  const [activeDesktopId, setActiveDesktopId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [dirtyAppIds, setDirtyAppIds] = useState<Set<string>>(() => new Set());
  const [selectionScope, setSelectionScope] = useState("desktop");
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [moveDialogEntryIds, setMoveDialogEntryIds] = useState<string[]>([]);
  const [moveDialogSubmitting, setMoveDialogSubmitting] = useState(false);
  const [desktopMoveFolders, setDesktopMoveFolders] = useState<Record<string, DesktopEntry[]>>({});
  const [moveDestinationsLoading, setMoveDestinationsLoading] = useState(false);
  const [runningApps, setRunningApps] = useState<RunningApp[]>([]);
  const [focusedAppId, setFocusedAppId] = useState<string | null>(null);
  const [windowSessionRestored, setWindowSessionRestored] = useState(false);
  const [routeHistoryReady, setRouteHistoryReady] = useState(false);
  const [route, setRoute] = useState<DesktopRoute | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [desktopSize, setDesktopSize] = useState(() => ({ width: window.innerWidth, height: Math.max(1, window.innerHeight - 44) }));
  const [layout, setLayout] = useState<DesktopLayout>(() => ({ snapToGrid: false, wallpaper: DEFAULT_WALLPAPER }));
  const [wallpaperAsset, setWallpaperAsset] = useState<{ key: string; url: string } | null>(null);
  const [editorSettings, setEditorSettings] = useState<EditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const [appearance, setAppearance] = useState<ThemeState>(DEFAULT_THEME_STATE);
  const [themePreview, setThemePreview] = useState<ThemeDefinition | null>(null);
  const [exporting, setExporting] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");
  const [isSyncing, setIsSyncing] = useState(false);
  const [editingAreas, setEditingAreas] = useState(false);
  const [draggedSegmentKey, setDraggedSegmentKey] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));
  const isMobile = useMediaQuery(MOBILE_WINDOW_QUERY);
  const compactChrome = useMediaQuery(COMPACT_CHROME_QUERY);
  const [settingsPage, setSettingsPage] = useState<"main" | "themes" | "activity" | "apps">("main");
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [appDialogRequests, setAppDialogRequests] = useState<readonly DialogRequest[]>([]);
  const [appNotifications, setAppNotifications] = useState<readonly AppNotification[]>([]);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [externalEmbeddedPreviews, setExternalEmbeddedPreviews] = useState<boolean | null>(null);
  const [updateSupported, setUpdateSupported] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [showUpdateToast, setShowUpdateToast] = useState(false);
  const [updateBlocked, setUpdateBlocked] = useState(false);
  const [updateApplying, setUpdateApplying] = useState(false);
  const [serverBuildTimestamp, setServerBuildTimestamp] = useState<string | null>(null);
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [activePanel, setActivePanel] = useState<"search" | "sync" | "windows" | "shortcuts" | "trash" | null>(null);
  const [outboxRecords, setOutboxRecords] = useState<OutboxRecord[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [offlineAvailability, setOfflineAvailability] = useState<Record<string, boolean | null>>({});
  const [offlineBusyId, setOfflineBusyId] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{ count: number; phase: "preparing" | "saving" | "syncing" } | null>(null);
  const [undoTrash, setUndoTrash] = useState<{ desktopId: string; label: string; rootIds: string[] } | null>(null);
  const [sharingOpen, setSharingOpen] = useState(false);
  const desktopRef = useRef<HTMLElement>(null);
  const desktopSizeRef = useRef(desktopSize);
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
    segmentKey: string;
    initialPositions: Array<{ entryId: string; position: EntryPosition }>;
    initialAppBounds: Array<{ appId: string; bounds: WindowBounds }>;
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
  const windowEdgeDragRef = useRef({ direction: "", time: 0 });
  const edgeNavigationRef = useRef<{
    route: DesktopRoute;
    historyState: unknown;
    draftEntryId?: string;
    focusedAppId?: string | null;
    targetSegment?: { column: number; row: number };
  } | null>(null);
  const windowEdgeNavigationRef = useRef<{
    appId: string;
    bounds: WindowBounds;
    route: DesktopRoute;
    historyState: unknown;
    targetSegment?: SurfaceSegment;
  } | null>(null);
  const layoutRef = useRef(layout);
  const wallpaperAssetRef = useRef<{ key: string; url: string } | null>(null);
  const entriesRef = useRef(entries);
  const routeRef = useRef<DesktopRoute | null>(null);
  const navigationReadyRef = useRef(false);
  const applyLocationRouteRef = useRef<(entriesValue?: DesktopEntry[], layoutValue?: DesktopLayout) => void>(() => undefined);
  const navigateRouteRef = useRef<(next: DesktopRoute, mode?: "push" | "replace", previousApps?: WindowTarget[]) => void>(() => undefined);
  const openRouteAppsRef = useRef<(next: DesktopRoute) => void>(() => undefined);
  const restoreHistoryAppsRef = useRef<(apps: WindowTarget[]) => void>(() => undefined);
  const restoreRunningAppsRef = useRef<(session: WindowSession, entries: DesktopEntry[]) => void>(() => undefined);
  const applyOpenQueryRef = useRef<(entries: DesktopEntry[], layout: DesktopLayout) => void>(() => undefined);
  const closeAppRef = useRef<(id: string) => void>(() => undefined);
  const runningAppsRef = useRef<RunningApp[]>([]);
  const focusedAppIdRef = useRef<string | null>(null);
  const nextWindowZRef = useRef(1);
  const fileLoadGenerationsRef = useRef<Record<string, number>>({});
  const layoutSaveRef = useRef<Promise<void>>(Promise.resolve());
  const layoutDraftRef = useRef<{ desktopId: string; layout: DesktopLayout } | null>(null);
  const editorSettingsSaveRef = useRef<Promise<void>>(Promise.resolve());
  const contentRevisionsRef = useRef<Record<string, number>>({});
  const activeDesktopIdRef = useRef("");
  const desktopsRef = useRef<DesktopIdentity[]>([]);
  const activateDesktopRef = useRef<(desktopId: string) => Promise<boolean>>(async () => false);
  const activationQueueRef = useRef(createSerialTaskQueue());
  const activationGenerationRef = useRef(0);
  const fileDirtyRef = useRef<Record<string, boolean>>({});
  const appSnapshotRef = useRef<DesktopStateSnapshot | null>(null);
  const sandboxFullscreenBoundsRef = useRef(new Map<string, WindowBounds>());
  const windowSessionReadyRef = useRef(false);
  const windowSessionSaveRef = useRef<Promise<void>>(Promise.resolve());
  const updaterRef = useRef<PwaUpdater | null>(null);
  const confirmationResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const restoredWindowBoundsRef = useRef(new Map<string, WindowBounds>());
  const windowCommandRef = useRef<{ maximize: (id: string) => void; move: (id: string, direction: "left" | "right" | "up" | "down") => void }>({ maximize: () => {}, move: () => {} });
  const autoUpdateRef = useRef(true);
  const localPreferencesRef = useRef<LocalPreferences>({ autoUpdate: true, externalEmbeddedPreviews: true });
  const updatePreferenceLoadedRef = useRef(false);
  const manualUpdateCheckRef = useRef(false);
  const activeSegment = { column: route?.column ?? 0, row: route?.row ?? 0 };
  desktopSizeRef.current = desktopSize;
  desktopsRef.current = desktops;
  const routeExplorerFolderId = route?.explorerFolderId;
  const routeFileId = route?.fileId;
  const routePropertiesEntryId = route?.propertiesEntryId;
  const routeSettings = route?.settings;
  const activeDesktop = desktops.find((desktop) => desktop.id === activeDesktopId);
  const canMutate = canMutateDesktop(activeDesktop, syncStatus);
  const canManage = Boolean(activeDesktop?.capabilities.manage && syncStatus === "online");
  const canSettings = Boolean(activeDesktop?.capabilities.settings && canMutate);
  const canViewActivity = Boolean(activeDesktop?.capabilities.activity && syncStatus === "online");
  const offlineSharedNotice = sharedOfflineMessage(activeDesktop, syncStatus);
  const syncIndicatorStatus = syncStatus === "online" && isSyncing ? "syncing" : syncStatus;
  const activeDesktopName = desktops.find((desktop) => desktop.id === activeDesktopId)?.name ?? "Desktop";
  const entryIndex = useMemo(() => createEntryIndex(entries), [entries]);
  const activeTheme = useMemo(() => themePreview ?? resolveTheme(appearance), [appearance, themePreview]);
  const iconMetrics = useMemo(() => themeIconMetrics(activeTheme), [activeTheme]);
  const rootEntries = entryIndex.roots;
  const responsive = useMemo(() => responsiveDesktop(entries, desktopSize, iconMetrics), [desktopSize, entries, iconMetrics]);
  const activeSegmentKey = segmentKey(activeSegment);
  const actualActiveSegment = responsive.segments.find((candidate) => candidate.key === activeSegmentKey);
  const occupiedSegments = useMemo(() => {
    const byKey = new Map(responsive.segments.map((segment) => [segment.key, segment]));
    for (const app of runningApps) {
      const segment = projectLogicalPosition(app.bounds, desktopSize).segment;
      const key = segmentKey(segment);
      if (!byKey.has(key)) byKey.set(key, { entries: [], key, segment });
    }
    return [...byKey.values()].sort((a, b) => a.segment.row - b.segment.row || a.segment.column - b.segment.column);
  }, [desktopSize, responsive.segments, runningApps]);
  const visibleSegments = occupiedSegments.some((candidate) => candidate.key === activeSegmentKey)
    ? occupiedSegments
    : [...occupiedSegments, { entries: [], key: activeSegmentKey, segment: activeSegment }]
      .sort((a, b) => a.segment.row - b.segment.row || a.segment.column - b.segment.column);
  const occupiedColumns = occupiedSegments.map((candidate) => candidate.segment.column);
  const occupiedRows = occupiedSegments.map((candidate) => candidate.segment.row);
  const minColumn = Math.min(0, activeSegment.column, ...occupiedColumns);
  const minRow = Math.min(0, activeSegment.row, ...occupiedRows);
  const maxColumn = Math.max(0, activeSegment.column, ...occupiedColumns);
  const maxRow = Math.max(0, activeSegment.row, ...occupiedRows);
  const segmentColumns = maxColumn - minColumn + 1;
  const segmentRows = maxRow - minRow + 1;
  const canvasOffset = { column: activeSegment.column - minColumn, row: activeSegment.row - minRow };
  const activeDesktopSegment = actualActiveSegment ?? { entries: [], key: activeSegmentKey, segment: activeSegment };
  const minimapWidth = Math.min(112, Math.max(42, segmentColumns * 24)) + 26;
  const minimapHeight = Math.min(84, Math.max(30, segmentRows * 20)) + 27;
  const minimapObscured = !editingAreas && activeDesktopSegment.entries.some((entry) => {
    const position = responsive.positions.get(entry.id) ?? entry.position;
    return position.x + iconMetrics.width > desktopSize.width - minimapWidth
      && position.y + iconMetrics.height > desktopSize.height - minimapHeight;
  });
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  selectedIdsRef.current = selectedIds;
  const selectedEntries = selectedIds.map((id) => entryIndex.byId.get(id)).filter((entry): entry is DesktopEntry => Boolean(entry));
  const dialogEntry = dialog?.type === "rename" ? entryIndex.byId.get(dialog.entryId) ?? null : dialog?.type === "delete" ? entryIndex.byId.get(dialog.entryIds[0]) ?? null : null;
  const contextMenuEntry = contextMenu?.type === "entry" ? entryIndex.byId.get(contextMenu.entryId) ?? null : null;
  const contextMenuEntries = contextMenuEntry && selectedIdSet.has(contextMenuEntry.id) ? selectedEntries : contextMenuEntry ? [contextMenuEntry] : [];
  const moveDialogEntries = moveDialogEntryIds.map((id) => entryIndex.byId.get(id)).filter((entry): entry is DesktopEntry => Boolean(entry));
  const shortcutsSuspended = Boolean(dialog || pendingPaste || moveDialogEntryIds.length || activePanel || sharingOpen || confirmation || contextMenu || editingAreas || appDialogRequests.length);

  useEffect(() => {
    appTheme.set(activeTheme);
    const tokens = mapThemeTokens(activeTheme);
    for (const app of runningAppsRef.current) if (app.kind === "sandbox") app.dispatcher.emit("theme.changed", tokens);
  }, [activeTheme, appTheme]);

  useEffect(() => appLifecycle.subscribe((owner, state) => {
    fileDirtyRef.current[owner.instanceId] = state.dirty;
    setDirtyAppIds((current) => {
      if (current.has(owner.instanceId) === state.dirty) return current;
      const next = new Set(current);
      if (state.dirty) next.add(owner.instanceId); else next.delete(owner.instanceId);
      return next;
    });
    updateRunningApps((current) => current.map((app) => {
      if (app.id !== owner.instanceId || app.kind !== "sandbox") return app;
      app.dispatcher.emit("window.stateChanged", { focused: state.focused, maximized: state.maximized, fullscreen: state.fullscreen, width: state.width, height: state.height });
      let bounds = { ...app.bounds, width: state.width, height: state.height };
      if (state.fullscreen) {
        if (!sandboxFullscreenBoundsRef.current.has(app.id)) sandboxFullscreenBoundsRef.current.set(app.id, app.bounds);
        const segment = projectLogicalPosition(app.bounds, desktopSizeRef.current).segment;
        bounds = { ...restoreLogicalPosition({ x: 0, y: 0 }, segment, desktopSizeRef.current), ...desktopSizeRef.current };
      } else {
        bounds = sandboxFullscreenBoundsRef.current.get(app.id) ?? bounds;
        sandboxFullscreenBoundsRef.current.delete(app.id);
      }
      return { ...app, title: state.title, bounds };
    }));
  }), [appLifecycle]);

  useEffect(() => appHostServices.dialogs.subscribe(setAppDialogRequests), [appHostServices]);
  useEffect(() => appHostServices.notifications.subscribe(setAppNotifications), [appHostServices]);
  useEffect(() => {
    if (loading) return;
    void listInstalledApps().then(setInstalledApps).catch((loadError) => {
    console.error("Installed apps could not be loaded.", loadError);
    setError(loadError instanceof Error ? loadError.message : "Installed apps could not be loaded.");
    });
  }, [loading]);
  function setCurrentRoute(next: DesktopRoute) {
    routeRef.current = next;
    setRoute(next);
  }

  function requestConfirmation(request: ConfirmationRequest) {
    confirmationResolverRef.current?.(false);
    setConfirmation(request);
    return new Promise<boolean>((resolve) => { confirmationResolverRef.current = resolve; });
  }

  function resolveConfirmation(confirmed: boolean) {
    const resolve = confirmationResolverRef.current;
    confirmationResolverRef.current = null;
    setConfirmation(null);
    resolve?.(confirmed);
  }

  function replaceSelection(surface: string, ids: string[], anchorId = ids.at(-1) ?? null) {
    const unique = [...new Set(ids)];
    selectedIdsRef.current = unique;
    setSelectedIds(unique);
    setSelectionScope(surface);
    setSelectionAnchorId(anchorId);
  }

  function selectEntry(surface: string, entry: DesktopEntry, options: { toggle?: boolean; range?: boolean; orderedIds?: string[] } = {}) {
    const current = selectionScope === surface ? selectedIdsRef.current : [];
    if (options.range && selectionScope === surface && selectionAnchorId && options.orderedIds) {
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

  function runningAppTargets(apps = runningAppsRef.current): WindowTarget[] {
    return apps.flatMap((app): WindowTarget[] => {
      const target = extractBuiltinAppTarget(app);
      return target ? [target] : [];
    });
  }

  function historyApps(state: unknown) {
    if (!state || typeof state !== "object" || !(state as Partial<RouteHistoryState>).hiraya || !("apps" in state)) return null;
    try {
      return parseWindowTargets(state);
    } catch {
      return null;
    }
  }

  function routeHistoryState(apps: WindowTarget[], parentHash?: string): RouteHistoryState {
    return { hiraya: true, schemaVersion: 1, ...(parentHash ? { parentHash } : {}), apps };
  }

  function writeRoute(next: DesktopRoute, mode: "push" | "replace" = "push", previousApps?: WindowTarget[]) {
    const hash = formatDesktopRoute(next);
    if (mode === "push" && hash !== window.location.hash) {
      const current = window.history.state as Partial<RouteHistoryState> | null;
      window.history.replaceState(routeHistoryState(previousApps ?? runningAppTargets(), current?.hiraya ? current.parentHash : undefined), "", window.location.href);
      window.history.pushState(routeHistoryState(runningAppTargets(), window.location.hash), "", hash);
    } else if (mode === "replace" || hash !== window.location.hash) {
      const current = window.history.state as Partial<RouteHistoryState> | null;
      window.history.replaceState(routeHistoryState(runningAppTargets(), current?.hiraya ? current.parentHash : undefined), "", hash);
    }
    setCurrentRoute(next);
  }

  function applyLocationRoute(entriesValue = entriesRef.current, layoutValue = layoutRef.current) {
    if (!navigationReadyRef.current) return;
    void layoutValue;
    const normalized = normalizeDesktopRoute(parseDesktopRoute(window.location.hash), entriesValue, activeDesktopIdRef.current);
    if (!normalized) return;
    const canonicalHash = formatDesktopRoute(normalized);
    if (canonicalHash !== window.location.hash) writeRoute(normalized, "replace");
    else setCurrentRoute(normalized);
  }

  function navigateRoute(next: DesktopRoute, mode: "push" | "replace" = "push", previousApps?: WindowTarget[]) {
    const normalized = normalizeDesktopRoute(next, entriesRef.current, activeDesktopIdRef.current);
    if (normalized) writeRoute(normalized, mode, previousApps);
  }

  function routeForApp(app: RunningApp | null, current: DesktopRoute): DesktopRoute {
    const base = { desktopId: activeDesktopIdRef.current, column: current.column, row: current.row };
    if (!app) return base;
    if (app.kind === "file") return { ...base, fileId: app.fileId };
    if (app.kind === "explorer") return { ...base, explorerFolderId: app.folderId };
    if (app.kind === "properties") return { ...base, propertiesEntryId: app.entryId };
    if (app.kind === "sandbox") return base;
    return { ...base, settings: true };
  }

  function updateRunningApps(updater: RunningApp[] | ((current: RunningApp[]) => RunningApp[])) {
    if (Array.isArray(updater)) {
      runningAppsRef.current = updater;
      setRunningApps(updater);
      return;
    }
    setRunningApps((current) => {
      const next = updater(current);
      runningAppsRef.current = next;
      return next;
    });
  }

  function setFocusedApp(id: string | null) {
    focusedAppIdRef.current = id;
    setFocusedAppId(id);
  }

  function segmentForApp(app: RunningApp, size = desktopSize) {
    return projectLogicalPosition(app.bounds, size).segment;
  }

  function appIsInSegment(app: RunningApp, segment: SurfaceSegment, size = desktopSize) {
    const appSegment = segmentForApp(app, size);
    return appSegment.column === segment.column && appSegment.row === segment.row;
  }

  function topAppInSegment(apps: RunningApp[], segment: SurfaceSegment, excludedId?: string) {
    return topRunningAppInSegment(apps, segment, desktopSize, excludedId);
  }

  function focusApp(id: string, syncRoute = true) {
    const target = runningAppsRef.current.find((app) => app.id === id);
    if (!target) return;
    const zIndex = ++nextWindowZRef.current;
    updateRunningApps((current) => current.map((app) => app.id === id ? { ...app, minimized: false, zIndex } : app));
    for (const app of runningAppsRef.current) if (app.kind === "sandbox") appLifecycle.setHostState({ appId: app.package.manifest.id, instanceId: app.id }, { focused: app.id === id });
    setFocusedApp(id);
    const currentRoute = routeRef.current;
    if (syncRoute && currentRoute) goToSegment(segmentForApp(target), "replace", { ...target, minimized: false, zIndex });
  }

  function closeApp(id: string) {
    if (id === builtinAppTargetId({ kind: "settings" })) setSettingsPage("main");
    delete fileDirtyRef.current[id];
    setDirtyAppIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    delete fileLoadGenerationsRef.current[id];
    sandboxFullscreenBoundsRef.current.delete(id);
    const closing = runningAppsRef.current.find((app) => app.id === id);
    if (closing?.kind === "sandbox") {
      closing.dispatcher.dispose();
      appCapabilities.revokeInstance(id);
    }
    const remaining = runningAppsRef.current.filter((app) => app.id !== id);
    updateRunningApps(remaining);
    if (focusedAppIdRef.current === id) {
      const next = topAppInSegment(remaining, activeSegment);
      setFocusedApp(next?.id ?? null);
      const currentRoute = routeRef.current;
      if (currentRoute) navigateRoute(routeForApp(next, currentRoute), "replace");
    }
  }

  function requestCloseApp(id: string) {
    if (fileDirtyRef.current[id]) {
      void requestConfirmation({ title: "Discard unsaved changes?", message: "Close this file and discard its unsaved editor changes?", confirmLabel: "Discard and close", danger: true }).then((confirmed) => { if (confirmed) closeApp(id); });
      return false;
    }
    closeApp(id);
    return true;
  }

  function minimizeApp(id: string) {
    const target = runningAppsRef.current.find((app) => app.id === id);
    if (target?.kind === "sandbox") appLifecycle.setHostState({ appId: target.package.manifest.id, instanceId: target.id }, { focused: false });
    updateRunningApps((current) => current.map((app) => app.id === id ? { ...app, minimized: true } : app));
    if (focusedAppIdRef.current === id) {
      const next = topAppInSegment(runningAppsRef.current, activeSegment, id);
      setFocusedApp(next?.id ?? null);
      const currentRoute = routeRef.current;
      if (currentRoute) navigateRoute(routeForApp(next, currentRoute), "replace");
    }
  }

  function updateAppBounds(id: string, bounds: WindowBounds) {
    const target = runningAppsRef.current.find((app) => app.id === id);
    if (target?.kind === "sandbox") appLifecycle.setHostState({ appId: target.package.manifest.id, instanceId: target.id }, { width: Math.round(bounds.width), height: Math.round(bounds.height) });
    updateRunningApps((current) => current.map((app) => app.id === id ? {
      ...app,
      bounds: { ...bounds, ...restoreLogicalPosition(bounds, segmentForApp(app), desktopSize) },
    } : app));
  }

  function createAppBase(id: string, kind: RunningApp["kind"], index?: number, segment = activeSegment): BaseRunningApp {
    const staggerIndex = index ?? runningAppsRef.current.filter((app) => appIsInSegment(app, segment)).length;
    const { width, height, minWidth, minHeight } = kind === "sandbox" ? { width: 820, height: 620, minWidth: 360, minHeight: 260 } : builtinAppWindow(kind);
    const localBounds = initialWindowBounds(desktopSize, { width, height, minWidth, minHeight, index: staggerIndex });
    return {
      id,
      bounds: { ...localBounds, ...restoreLogicalPosition(localBounds, segment, desktopSize) },
      minimized: false,
      zIndex: ++nextWindowZRef.current,
    };
  }

  function loadFileApp(id: string, file: FileEntry, expectedRevision: number) {
    const generation = (fileLoadGenerationsRef.current[id] ?? 0) + 1;
    fileLoadGenerationsRef.current[id] = generation;
    updateRunningApps((current) => current.map((candidate) => candidate.id === id && candidate.kind === "file" ? { ...candidate, blob: undefined, loadError: undefined } : candidate));
    void readFile(file.id).then((blob) => {
      if (fileLoadGenerationsRef.current[id] !== generation || !runningAppsRef.current.some((candidate) => candidate.id === id)) return;
      updateRunningApps((current) => current.map((candidate) => candidate.id === id && candidate.kind === "file" ? {
        ...candidate,
        blob,
        loadError: undefined,
        editable: fileCapabilities(file).editable,
        contentRevision: expectedRevision,
      } : candidate));
    }).catch((openError) => {
      if (fileLoadGenerationsRef.current[id] !== generation) return;
      updateRunningApps((current) => current.map((candidate) => candidate.id === id && candidate.kind === "file" ? {
        ...candidate,
        loadError: openError instanceof Error ? openError.message : "The file could not be opened.",
      } : candidate));
    });
  }

  function restoreRunningApps(session: WindowSession, loadedEntries: DesktopEntry[]) {
    const byId = new Map(loadedEntries.map((entry) => [entry.id, entry]));
    const restoredRoute = routeRef.current ?? normalizeDesktopRoute(parseDesktopRoute(window.location.hash), loadedEntries, activeDesktopIdRef.current);
    const restored = restoreWindowSession(session, loadedEntries, restoredRoute, desktopSize).map((saved): RunningApp => {
      if (saved.kind === "settings") return { ...saved, id: builtinAppTargetId(saved) };
      if (saved.kind === "explorer") return { ...saved, id: builtinAppTargetId(saved) };
      if (saved.kind === "properties") return { ...saved, id: builtinAppTargetId(saved) };
      const file = byId.get(saved.fileId) as FileEntry;
      return {
        ...saved,
        id: builtinAppTargetId(saved),
        file,
        editMode: Boolean(saved.editMode),
        contentRevision: contentRevisionsRef.current[saved.fileId] ?? 0,
        remoteChanged: false,
      };
    });
    nextWindowZRef.current = Math.max(1, ...restored.map((app) => app.zIndex));
    updateRunningApps(restored);
    setFocusedApp(null);
    for (const app of restored) {
      if (app.kind === "file" && app.file) loadFileApp(app.id, app.file, app.contentRevision);
    }
  }

  function restoreHistoryApps(targets: WindowTarget[]) {
    const historySegment = normalizeDesktopRoute(parseDesktopRoute(window.location.hash), entriesRef.current, activeDesktopIdRef.current);
    const existing = new Map(runningAppsRef.current.map((app) => [app.id, app]));
    const targetIds = new Set(targets.map(builtinAppTargetId));
    const reusableExplorers = runningAppsRef.current.filter((app): app is ExplorerApp => app.kind === "explorer" && !targetIds.has(app.id));
    const restored: RunningApp[] = [];
    const filesToLoad: FileApp[] = [];
    for (const target of targets) {
      const id = builtinAppTargetId(target);
      const current = existing.get(id);
      if (current) {
        restored.push(current);
        continue;
      }
      if (target.kind === "settings") {
        restored.push({ ...createAppBase(id, target.kind, restored.length, historySegment), kind: "settings" });
        continue;
      }
      if (target.kind === "explorer") {
        if (target.folderId !== null && entriesRef.current.find((entry) => entry.id === target.folderId)?.kind !== "folder") continue;
        const reusable = reusableExplorers.shift();
        restored.push(reusable
          ? { ...reusable, id, folderId: target.folderId }
          : { ...createAppBase(id, target.kind, restored.length, historySegment), kind: "explorer", folderId: target.folderId });
        continue;
      }
      if (target.kind === "properties") {
        if (!entriesRef.current.some((entry) => entry.id === target.entryId)) continue;
        restored.push({ ...createAppBase(id, target.kind, restored.length, historySegment), kind: "properties", entryId: target.entryId });
        continue;
      }
      const file = entriesRef.current.find((entry): entry is FileEntry => entry.id === target.fileId && entry.kind === "file");
      if (!file) continue;
      const app: FileApp = {
        ...createAppBase(id, target.kind, restored.length, historySegment),
        kind: "file",
        fileId: file.id,
        file,
        editMode: Boolean(target.editMode),
        contentRevision: contentRevisionsRef.current[file.id] ?? 0,
        remoteChanged: false,
      };
      restored.push(app);
      filesToLoad.push(app);
    }
    const restoredIds = new Set(restored.map((app) => app.id));
    for (const app of runningAppsRef.current) {
      if (restoredIds.has(app.id)) continue;
      delete fileDirtyRef.current[app.id];
      delete fileLoadGenerationsRef.current[app.id];
    }
    updateRunningApps(restored);
    if (focusedAppIdRef.current && !restoredIds.has(focusedAppIdRef.current)) setFocusedApp(null);
    for (const app of filesToLoad) loadFileApp(app.id, app.file!, app.contentRevision);
  }

  function applyOpenQuery(loadedEntries: DesktopEntry[], loadedLayout: DesktopLayout) {
    void loadedLayout;
    const url = new URL(window.location.href);
    const openPath = url.searchParams.get("open");
    if (openPath === null) {
      applyLocationRouteRef.current(loadedEntries, loadedLayout);
      return;
    }
    try {
      const file = resolveOpenFilePath(loadedEntries, openPath);
      const current = normalizeDesktopRoute(parseDesktopRoute(url.hash), loadedEntries, activeDesktopIdRef.current);
      const next: DesktopRoute = {
        desktopId: current.desktopId ?? activeDesktopIdRef.current,
        column: current.column,
        row: current.row,
        ...(current.explorerFolderId !== undefined ? { explorerFolderId: current.explorerFolderId } : {}),
        fileId: file.id,
      };
      url.searchParams.delete("open");
      url.hash = formatDesktopRoute(next);
      window.history.replaceState(window.history.state, "", url);
      setCurrentRoute(next);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : `No file exists at “${openPath}”.`);
      applyLocationRouteRef.current(loadedEntries, loadedLayout);
    }
  }

  restoreRunningAppsRef.current = restoreRunningApps;
  restoreHistoryAppsRef.current = restoreHistoryApps;
  applyOpenQueryRef.current = applyOpenQuery;

  applyLocationRouteRef.current = applyLocationRoute;
  navigateRouteRef.current = navigateRoute;
  openRouteAppsRef.current = (next) => {
    if (next.explorerFolderId !== undefined) openExplorerWindow(next.explorerFolderId, false, !next.fileId && !next.propertiesEntryId && !next.settings);
    if (next.fileId) {
      const entry = entryIndex.byId.get(next.fileId);
      if (entry?.kind === "file") openFileWindow(entry, false, !next.propertiesEntryId && !next.settings);
    }
    if (next.propertiesEntryId && entryIndex.byId.has(next.propertiesEntryId)) openPropertiesWindow(next.propertiesEntryId, false);
    if (next.settings) openSettingsWindow(false);
    if (next.explorerFolderId === undefined && !next.fileId && !next.propertiesEntryId && !next.settings) setFocusedApp(null);
  };
  closeAppRef.current = requestCloseApp;

  useEffect(() => {
    let active = true;
    let sessionRestoreStarted = false;
    let savedWindowSession: Promise<{ session: WindowSession; loaded: true } | { session: null; loaded: false }> | null = null;
    const restoreSavedWindowSession = () => {
      if (sessionRestoreStarted || !savedWindowSession) return;
      sessionRestoreStarted = true;
      void savedWindowSession.then((result) => {
        if (!active) return;
        if (result.loaded) {
          restoreRunningAppsRef.current(result.session, entriesRef.current);
          const routedApps = historyApps(window.history.state);
          if (routedApps) restoreHistoryAppsRef.current(routedApps);
          windowSessionReadyRef.current = true;
        } else {
          setError("The saved app session could not be loaded.");
        }
        setWindowSessionRestored(true);
        setLoading(false);
      });
    };
    const unsubscribe = subscribeToSync((synced) => {
      if (!active) return;
      contentRevisionsRef.current = synced.sync.contentRevisions;
      layoutRef.current = synced.layout;
      entriesRef.current = synced.entries;
      setLayout(synced.layout);
      setEntries(synced.entries);
      setEditorSettings(synced.editorSettings);
      setAppearance(synced.appearance);
      const syncedIds = new Set(synced.entries.map((entry) => entry.id));
      appSnapshotRef.current = synced;
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
      const availableApps = runningAppsRef.current.filter((app) => {
        if (app.kind === "sandbox") return syncedIds.has(app.fileId);
        const dependency = builtinAppEntryDependency(app);
        return !dependency || syncedIds.has(dependency.entryId);
      });
      for (const app of runningAppsRef.current) if (app.kind === "sandbox" && !availableApps.includes(app)) app.dispatcher.dispose();
      updateRunningApps(availableApps);
      if (focusedAppIdRef.current && !availableApps.some((app) => app.id === focusedAppIdRef.current)) {
        const currentRoute = routeRef.current;
        const next = topRunningAppInSegment(availableApps, currentRoute ?? { column: 0, row: 0 }, desktopSizeRef.current);
        setFocusedApp(next?.id ?? null);
      }
      navigationReadyRef.current = true;
      applyLocationRouteRef.current(synced.entries, synced.layout);
      setLoading(false);
      restoreSavedWindowSession();
    }, (nextStatus) => {
      if (!active) return;
      setSyncStatus(nextStatus);
      if (nextStatus === "online") setLastSyncedAt(Date.now());
    }, (syncing) => { if (active) setIsSyncing(syncing); });
    const unsubscribeOutbox = subscribeToOutbox((records) => { if (active) setOutboxRecords([...records]); });
    const unsubscribeCatalog = subscribeToDesktopCatalog((registry) => {
      if (!active) return;
      desktopsRef.current = registry.desktops;
      setDesktops(registry.desktops);
      setCatalogQuota(registry.quota);
      const retainedIds = registry.desktops.map((desktop) => desktop.id);
      if (activeDesktopIdRef.current && !retainedIds.includes(activeDesktopIdRef.current)) {
        const fallback = registry.desktops[0];
        if (fallback) void activateDesktopRef.current(fallback.id).then((switched) => { if (switched) return pruneLocalDesktops(retainedIds); });
      } else {
        void pruneLocalDesktops(retainedIds);
      }
    });
    void listDesktops(seededDesktop).then((registry) => {
      if (!active) throw new DOMException("Desktop loading was stopped.", "AbortError");
      const routeDesktopId = parseDesktopRoute(window.location.hash)?.desktopId;
      const desktopId = routeDesktopId && registry.desktops.some((desktop) => desktop.id === routeDesktopId)
        ? routeDesktopId
        : registry.activeDesktopId && registry.desktops.some((desktop) => desktop.id === registry.activeDesktopId)
          ? registry.activeDesktopId
          : registry.desktops[0].id;
      setDesktops(registry.desktops);
      setCatalogQuota(registry.quota);
      activeDesktopIdRef.current = desktopId;
      setActiveDesktopId(desktopId);
      return switchLocalDesktop(desktopId)
        .then(() => pruneLocalDesktops(registry.desktops.map((desktop) => desktop.id)))
        .then(() => {
          const initialization = initializeDesktop(desktopId, { x: window.innerWidth, y: Math.max(1, window.innerHeight - 44) }, seededDesktop);
          savedWindowSession = readWindowSession(desktopId).then(
            (session) => ({ session, loaded: true as const }),
            () => ({ session: null, loaded: false as const }),
          );
          return initialization;
        });
    })
      .then(({ desktop: loadedDesktop, status: loadedStatus }) => {
        if (!active) return;
        const { entries: loadedEntries, layout: loadedLayout, editorSettings: loadedEditorSettings, appearance: loadedAppearance, sync } = loadedDesktop;
        contentRevisionsRef.current = sync.contentRevisions;
        appSnapshotRef.current = loadedDesktop;
        layoutRef.current = loadedLayout;
        entriesRef.current = loadedEntries;
        setLayout(loadedLayout);
        setEntries(loadedEntries);
        setEditorSettings(loadedEditorSettings);
        setAppearance(loadedAppearance);
        setSyncStatus(loadedStatus);
        setLoading(false);
        restoreSavedWindowSession();
        const routedApps = historyApps(window.history.state);
        if (routedApps) restoreHistoryAppsRef.current(routedApps);
        setRouteHistoryReady(true);
        navigationReadyRef.current = true;
        applyOpenQueryRef.current(loadedEntries, loadedLayout);
      })
      .catch((loadError) => {
        if (active && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(loadError instanceof Error ? loadError.message : "Your files could not be loaded.");
        }
        if (active && !sessionRestoreStarted) {
          setWindowSessionRestored(true);
          setLoading(false);
        }
        if (active) setRouteHistoryReady(true);
      });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeOutbox();
      unsubscribeCatalog();
      void stopDesktopSync();
    };
  }, []);

  useEffect(() => () => confirmationResolverRef.current?.(false), []);

  useEffect(() => {
    if (activePanel !== "sync") return;
    let active = true;
    void listOutboxRecords().then((records) => { if (active) setOutboxRecords(records); }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "The synchronization queue could not be loaded.");
    });
    return () => { active = false; };
  }, [activePanel]);

  useEffect(() => {
    if (!moveDialogEntryIds.length || !activeDesktopId) return;
    let active = true;
    setDesktopMoveFolders({});
    setMoveDestinationsLoading(true);
    void Promise.all(desktops.map(async (desktop) => [desktop.id, desktop.id === activeDesktopId ? entriesRef.current : await readDesktopEntries(desktop.id)] as const))
      .then((values) => { if (active) setDesktopMoveFolders(Object.fromEntries(values)); })
      .catch(() => { if (active) setError("Desktop destinations could not be loaded. Close and reopen Move to retry."); })
      .finally(() => { if (active) setMoveDestinationsLoading(false); });
    return () => { active = false; };
  }, [activeDesktopId, desktops, moveDialogEntryIds.length]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!Object.values(fileDirtyRef.current).some(Boolean)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);

  useEffect(() => {
    if (syncStatus !== "online" || serverBuildTimestamp) return;
    let active = true;
    void fetchServerBuildTimestamp()
      .then((timestamp) => { if (active) setServerBuildTimestamp(timestamp); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [serverBuildTimestamp, syncStatus]);

  useEffect(() => {
    if (windowSessionReadyRef.current) {
      const session = createWindowSession(runningApps);
      windowSessionSaveRef.current = windowSessionSaveRef.current
        .then(() => saveWindowSession(activeDesktopIdRef.current, session))
        .catch(() => { setError("The open app session could not be saved."); });
    }
    if (navigationReadyRef.current && windowSessionRestored && routeHistoryReady) {
      const current = window.history.state as Partial<RouteHistoryState> | null;
      window.history.replaceState(routeHistoryState(runningAppTargets(runningApps), current?.hiraya ? current.parentHash : undefined), "", window.location.href);
    }
  }, [routeHistoryReady, runningApps, windowSessionRestored]);

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
      onError: () => { if (active) setError("Hiraya could not check for app updates."); },
    });
    updaterRef.current = updater;
    setUpdateSupported(updater.supported);

    const checkAutomatically = () => {
      if (!active || !autoUpdateRef.current || !updater.supported) return;
      void updater.check().catch(() => { if (active) setError("Hiraya could not check for app updates."); });
    };
    const checkWhenVisible = () => { if (document.visibilityState === "visible") checkAutomatically(); };
    window.addEventListener("online", checkAutomatically);
    document.addEventListener("visibilitychange", checkWhenVisible);

    void readLocalPreferences()
      .then((preferences) => {
        if (!active) return;
        autoUpdateRef.current = preferences.autoUpdate;
        localPreferencesRef.current = preferences;
        updatePreferenceLoadedRef.current = true;
        setAutoUpdate(preferences.autoUpdate);
        setExternalEmbeddedPreviews(preferences.externalEmbeddedPreviews);
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
    function restoreRoute(state?: unknown) {
      if (!navigationReadyRef.current) return;
      setDialog(null);
      setContextMenu(null);
      setMoveDialogEntryIds([]);
      setEditingAreas(false);
      setDraggedSegmentKey(null);
      const requestedRoute = parseDesktopRoute(window.location.hash);
      const requestedDesktopId = requestedRoute?.desktopId;
      if (requestedDesktopId && requestedDesktopId !== activeDesktopIdRef.current && desktopsRef.current.some((desktop) => desktop.id === requestedDesktopId)) {
        void activateDesktopRef.current(requestedDesktopId).then((switched) => {
          if (switched && requestedRoute) navigateRouteRef.current(requestedRoute, "replace");
        });
        return;
      }
      const apps = historyApps(state);
      if (apps) restoreHistoryAppsRef.current(apps);
      applyLocationRouteRef.current();
    }
    const onPopState = (event: PopStateEvent) => restoreRoute(event.state);
    const onHashChange = () => restoreRoute();
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onHashChange);
    };
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
    const focused = runningAppsRef.current.find((app) => app.id === focusedAppIdRef.current);
    const selectedEntry = selectedIdsRef.current.map((id) => entriesRef.current.find((entry) => entry.id === id && entry.parentId === null)).find(Boolean);
    const projectedSegment = focused
      ? projectLogicalPosition(focused.bounds, desktopSize).segment
      : selectedEntry
        ? projectLogicalPosition(selectedEntry.position, desktopSize).segment
        : {
            column: Math.floor((current.column * previous.width + previous.width / 2) / desktopSize.width),
            row: Math.floor((current.row * previous.height + previous.height / 2) / desktopSize.height),
          };
    navigateRouteRef.current({
      ...current,
      ...projectedSegment,
    }, "replace");
    updateRunningApps((currentApps) => currentApps.map((app) => {
      const projection = projectLogicalPosition(app.bounds, desktopSize);
      const { minWidth, minHeight } = app.kind === "sandbox" ? { minWidth: 360, minHeight: 260 } : builtinAppWindow(app.kind);
      const localBounds = clampWindowBounds({ ...app.bounds, ...projection.local }, desktopSize, { minWidth, minHeight });
      return { ...app, bounds: { ...localBounds, ...restoreLogicalPosition(localBounds, projection.segment, desktopSize) } };
    }));
  }, [desktopSize]);

  useEffect(() => {
    if (loading) return;
    const currentApps = runningAppsRef.current;
    const reconciledApps = currentApps.flatMap((app): RunningApp[] => {
      if (app.kind === "sandbox") return entryIndex.byId.has(app.fileId) ? [app] : [];
      const dependency = builtinAppEntryDependency(app);
      if (!dependency) return [app];
      const entry = entryIndex.byId.get(dependency.entryId);
      if (!entry || dependency.kind !== "entry" && entry.kind !== dependency.kind) return [];
      if (app.kind !== "file") return [app];
      if (entry.kind !== "file") return [];
      const expectedRevision = contentRevisionsRef.current[app.fileId] ?? 0;
      if (expectedRevision !== app.contentRevision && fileDirtyRef.current[app.id]) {
        return [{ ...app, file: entry, contentRevision: expectedRevision, remoteChanged: true }];
      }
      return [{ ...app, file: entry, editable: fileCapabilities(entry).editable }];
    });
    updateRunningApps(reconciledApps);
    if (focusedAppIdRef.current && !reconciledApps.some((app) => app.id === focusedAppIdRef.current)) {
      const next = topRunningAppInSegment(reconciledApps, routeRef.current ?? { column: 0, row: 0 }, desktopSizeRef.current);
      setFocusedApp(next?.id ?? null);
    }

    for (const app of currentApps) {
      if (app.kind !== "file" || fileDirtyRef.current[app.id]) continue;
      const entry = entryIndex.byId.get(app.fileId);
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
  }, [entryIndex, loading]);

  useEffect(() => {
    if (loading || !windowSessionRestored) return;
    openRouteAppsRef.current({
      column: 0,
      row: 0,
      ...(routeExplorerFolderId !== undefined ? { explorerFolderId: routeExplorerFolderId } : {}),
      ...(routeFileId ? { fileId: routeFileId } : {}),
      ...(routePropertiesEntryId ? { propertiesEntryId: routePropertiesEntryId } : {}),
      ...(routeSettings ? { settings: true as const } : {}),
    });
  }, [loading, routeExplorerFolderId, routeFileId, routePropertiesEntryId, routeSettings, windowSessionRestored]);

  useEffect(() => {
    applyLocationRouteRef.current();
  }, [responsive.segments.length]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (editingAreas && !(event.target as Element).closest?.(".desktop-minimap")) {
        setEditingAreas(false);
        setDraggedSegmentKey(null);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [editingAreas]);

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
      if (editableTarget(event.target) || shortcutsSuspended || transientMenuOpen()) return;
      const focused = runningAppsRef.current.find((candidate) => candidate.id === focusedAppIdRef.current);
      if (focused && focused.kind !== "explorer") return;
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "a") {
        const explorer = activeExplorer();
        const surface = explorer?.id ?? "desktop";
        const ids = explorer ? entryIndex.children.get(explorer.folderId)?.map((entry) => entry.id) ?? [] : activeDesktopSegment.entries.map((entry) => entry.id);
        event.preventDefault();
        replaceSelection(surface, ids);
      } else if (modifier && key === "c" && selectedIdsRef.current.length) {
        event.preventDefault();
        void copySelection();
      } else if (modifier && key === "v") {
        event.preventDefault();
        const explorer = activeExplorer();
        void beginPasteRef.current(explorer?.folderId ?? null);
      } else if (event.key === "Delete" && selectedIdsRef.current.length && canMutate) {
        event.preventDefault();
        setDialog({ type: "delete", entryIds: [...selectedIdsRef.current] });
      }
    }
    function onPaste(event: ClipboardEvent) {
      if (editableTarget(event.target) || !canMutate || shortcutsSuspended || transientMenuOpen()) return;
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
  }, [activeDesktopSegment.entries, canMutate, entryIndex, selectionScope, shortcutsSuspended]);

  useEffect(() => {
    function onGlobalShortcut(event: KeyboardEvent) {
      if (shortcutsSuspended || transientMenuOpen()) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setActivePanel("search");
        return;
      }
      if (event.key === "?" && !event.metaKey && !event.ctrlKey && !(event.target as Element | null)?.closest?.("input, textarea, [contenteditable='true'], .cm-editor")) {
        event.preventDefault();
        setActivePanel("shortcuts");
        return;
      }
      if (event.altKey && event.key === "Enter" && focusedAppIdRef.current) {
        event.preventDefault();
        windowCommandRef.current.maximize(focusedAppIdRef.current);
      } else if (event.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && focusedAppIdRef.current) {
        event.preventDefault();
        windowCommandRef.current.move(focusedAppIdRef.current, event.key.replace("Arrow", "").toLowerCase() as "left" | "right" | "up" | "down");
      }
    }
    window.addEventListener("keydown", onGlobalShortcut);
    return () => window.removeEventListener("keydown", onGlobalShortcut);
  }, [shortcutsSuspended]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if ((event.target as Element | null)?.closest?.("input, textarea, [contenteditable='true'], .cm-editor")) return;
      const owner = topOverlay({
        dialog: Boolean(dialog),
        moveDialog: moveDialogEntries.length > 0,
        settings: false,
        contextMenu: Boolean(contextMenu),
        file: false,
        explorer: false,
        areaEditor: editingAreas,
      });
      if (!owner && !focusedAppIdRef.current) return;
       if (owner === "moveDialog" && moveDialogSubmitting) return;
      event.preventDefault();
      if (owner === "dialog") setDialog(null);
       else if (owner === "moveDialog") setMoveDialogEntryIds([]);
      else if (owner === "contextMenu") setContextMenu(null);
      else if (owner === "areaEditor") { setEditingAreas(false); setDraggedSegmentKey(null); }
      else if (focusedAppIdRef.current) closeAppRef.current(focusedAppIdRef.current);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenu, dialog, editingAreas, moveDialogEntries.length, moveDialogSubmitting]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => { setNotice(""); setUndoTrash(null); }, 6500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const wallpaperFileId = layout.wallpaper.source.startsWith("file:") ? layout.wallpaper.source.slice(5) : null;
  const wallpaperFile = wallpaperFileId ? entries.find((entry): entry is FileEntry => entry.id === wallpaperFileId && entry.kind === "file") : null;
  const wallpaperFileExists = Boolean(wallpaperFile);
  const wallpaperContentRevision = wallpaperFileId ? contentRevisionsRef.current[wallpaperFileId] ?? wallpaperFile?.modifiedAt ?? 0 : 0;
  const wallpaperKey = wallpaperFileId && activeDesktopId ? `${activeDesktopId}:${wallpaperFileId}:${wallpaperContentRevision}` : null;
  const wallpaperLoadReady = true;
  const wallpaperUrl = wallpaperAsset?.key === wallpaperKey ? wallpaperAsset.url : null;

  useEffect(() => {
    const previous = wallpaperAssetRef.current;
    wallpaperAssetRef.current = null;
    setWallpaperAsset(null);
    if (previous) URL.revokeObjectURL(previous.url);
  }, [wallpaperKey]);

  useEffect(() => {
    let active = true;
    if (!wallpaperKey || !wallpaperFileId || !wallpaperFileExists || !wallpaperLoadReady) return;
    void readFile(wallpaperFileId).then((file) => {
      if (!active) return;
      const next = { key: wallpaperKey, url: URL.createObjectURL(file) };
      const previous = wallpaperAssetRef.current;
      wallpaperAssetRef.current = next;
      setWallpaperAsset(next);
      if (previous) URL.revokeObjectURL(previous.url);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [wallpaperFileExists, wallpaperFileId, wallpaperKey, wallpaperLoadReady]);

  useEffect(() => () => {
    if (wallpaperAssetRef.current) URL.revokeObjectURL(wallpaperAssetRef.current.url);
  }, []);

  const availabilityEntryIds = [contextMenuEntry?.kind === "file" ? contextMenuEntry.id : null, ...runningApps.filter((app): app is PropertiesApp => app.kind === "properties").map((app) => entryIndex.byId.get(app.entryId)?.kind === "file" ? app.entryId : null)].filter((id): id is string => Boolean(id));
  const availabilityKey = [...new Set(availabilityEntryIds)].sort().join("\n");
  useEffect(() => {
    let active = true;
    for (const id of availabilityKey ? availabilityKey.split("\n") : []) {
      setOfflineAvailability((current) => ({ ...current, [id]: null }));
      void isFileAvailableOffline(id).then((available) => {
        if (active) setOfflineAvailability((current) => ({ ...current, [id]: available }));
      }).catch(() => {
        if (active) setOfflineAvailability((current) => ({ ...current, [id]: false }));
      });
    }
    return () => { active = false; };
  }, [availabilityKey]);

  function childrenCount(parentId: string | null) {
    return parentId !== null ? entryIndex.children.get(parentId)?.length ?? 0 : activeDesktopSegment.entries.length;
  }

  function positionFor(parentId: string | null) {
    if (parentId === null) {
      const segmentEntryCount = childrenCount(null);
      const occupied = activeDesktopSegment.entries.map((entry) => responsive.positions.get(entry.id) ?? projectLogicalPosition(entry.position, desktopSize).local);
      const localPosition = nextAvailableDesktopSlot(desktopSize, occupied, responsive.segments.length > 1, segmentEntryCount, iconMetrics);
      return restoreLogicalPosition(localPosition, activeSegment, desktopSize);
    }
    const position = nextRootEntryPosition(childrenCount(parentId), window.innerHeight, undefined, iconMetrics);
    return position;
  }

  function snapPositionInView(position: EntryPosition) {
    return {
      x: snapAxis(position.x, GRID_ORIGIN.x, iconMetrics.stepX, Math.max(8, desktopSize.width - iconMetrics.width)),
      y: snapAxis(position.y, GRID_ORIGIN.y, iconMetrics.stepY, Math.max(8, desktopSize.height - iconMetrics.height)),
    };
  }

  function snapRootEntryPosition(position: EntryPosition) {
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

  function previewLayout(next: DesktopLayout, desktopId: string) {
    if (!canMutate || desktopId !== activeDesktopIdRef.current) return;
    layoutDraftRef.current = { desktopId, layout: next };
    layoutRef.current = next;
    setLayout(next);
  }

  async function persistLayout(next: DesktopLayout, desktopId = activeDesktopIdRef.current) {
    if (!canMutate || desktopId !== activeDesktopIdRef.current) return;
    if (layoutDraftRef.current?.desktopId === desktopId) layoutDraftRef.current = null;
    layoutRef.current = next;
    setLayout(next);
    const save = saveDesktopLayout(next).catch(() => { setError("The desktop area layout could not be saved."); });
    layoutSaveRef.current = save;
    await save;
  }

  async function flushLayoutDraft(desktopId: string) {
    const pending = layoutDraftRef.current;
    if (!pending || pending.desktopId !== desktopId) return;
    await persistLayout(pending.layout, desktopId);
  }

  function applyEditorSettings(next: EditorSettings) {
    if (!canSettings) return;
    setEditorSettings(next);
    editorSettingsSaveRef.current = editorSettingsSaveRef.current
      .then(() => saveEditorSettings(next))
      .catch(() => { setError("The editor settings could not be saved."); });
  }

  async function changeTheme(themeId: string) {
    if (!canSettings) return;
    setThemePreview(null);
    try {
      setAppearance(await selectTheme(themeId));
    } catch (themeError) {
      setError(themeError instanceof Error ? themeError.message : "The selected theme could not be saved.");
      throw themeError;
    }
  }

  async function persistCustomTheme(theme: CustomTheme) {
    if (!canSettings) return;
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
    if (!canSettings) return;
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
      setError("Hiraya could not check for app updates.");
    } finally {
      manualUpdateCheckRef.current = false;
      setUpdateChecking(false);
    }
  }

  async function changeAutoUpdate(enabled: boolean) {
    const previous = localPreferencesRef.current;
    const next = { ...previous, autoUpdate: enabled };
    autoUpdateRef.current = enabled;
    localPreferencesRef.current = next;
    setAutoUpdate(enabled);
    try {
      await saveLocalPreferences(next);
      if (enabled) void updaterRef.current?.check().catch(() => setError("Hiraya could not check for app updates."));
    } catch {
      autoUpdateRef.current = previous.autoUpdate;
      localPreferencesRef.current = previous;
      setAutoUpdate(previous.autoUpdate);
      setError("The local update preference could not be saved.");
    }
  }

  async function changeExternalEmbeddedPreviews(enabled: boolean) {
    const previous = localPreferencesRef.current;
    const next = { ...previous, externalEmbeddedPreviews: enabled };
    localPreferencesRef.current = next;
    setExternalEmbeddedPreviews(enabled);
    try {
      await saveLocalPreferences(next);
    } catch {
      localPreferencesRef.current = previous;
      setExternalEmbeddedPreviews(previous.externalEmbeddedPreviews);
      setError("The external preview preference could not be saved.");
    }
  }

  async function applyActivatedDesktopState(desktopId: string, desktop: DesktopStateSnapshot) {
    activeDesktopIdRef.current = desktopId;
    setActiveDesktopId(desktopId);
    contentRevisionsRef.current = desktop.sync.contentRevisions;
    entriesRef.current = desktop.entries;
    layoutRef.current = desktop.layout;
    setEntries(desktop.entries);
    setLayout(desktop.layout);
    setEditorSettings(desktop.editorSettings);
    setAppearance(desktop.appearance);
    replaceSelection("desktop", []);
    for (const app of runningAppsRef.current) if (app.kind === "sandbox") app.dispatcher.dispose();
    updateRunningApps([]);
    appSnapshotRef.current = desktop;
    setFocusedApp(null);
    writeRoute(normalizeDesktopRoute({ desktopId, column: 0, row: 0 }, desktop.entries, desktopId), "replace");
    restoreRunningApps(await readWindowSession(desktopId), desktop.entries);
    windowSessionReadyRef.current = true;
    setWindowSessionRestored(true);
  }

  async function performDesktopActivation(desktopId: string, token: number) {
    activationGenerationRef.current = token;
    if (desktopId === activeDesktopIdRef.current) return true;
    if (Object.values(fileDirtyRef.current).some(Boolean) && !await requestConfirmation({ title: "Switch desktops?", message: "Switching desktops will discard unsaved editor changes in open files.", confirmLabel: "Discard and switch", danger: true })) return false;
    const previousDesktopId = activeDesktopIdRef.current;
    let syncStopped = false;
    setLoading(true);
    setError("");
    setDialog(null);
    setContextMenu(null);
    setMoveDialogEntryIds([]);
    windowSessionReadyRef.current = false;
    try {
      await flushLayoutDraft(previousDesktopId);
      await layoutSaveRef.current;
      await stopDesktopSync();
      syncStopped = true;
      const desktop = await switchLocalDesktop(desktopId);
      await applyActivatedDesktopState(desktopId, desktop);
      await initializeDesktop(desktopId, { x: window.innerWidth, y: Math.max(1, window.innerHeight - 44) });
      if (activationGenerationRef.current !== token || activeDesktopIdRef.current !== desktopId) throw new Error("Desktop activation lost ownership.");
      return true;
    } catch (switchError) {
      if (syncStopped && previousDesktopId && previousDesktopId !== desktopId) {
        try {
          await stopDesktopSync();
          const previous = await switchLocalDesktop(previousDesktopId);
          await applyActivatedDesktopState(previousDesktopId, previous);
          await initializeDesktop(previousDesktopId, { x: window.innerWidth, y: Math.max(1, window.innerHeight - 44) });
        } catch (rollbackError) {
          setError(rollbackError instanceof Error ? `Desktop activation failed and rollback failed: ${rollbackError.message}` : "Desktop activation and rollback failed.");
          return false;
        }
      }
      setError(switchError instanceof Error ? switchError.message : "The desktop could not be opened.");
      return false;
    } finally { setLoading(false); }
  }
  function activateDesktop(desktopId: string) {
    return activationQueueRef.current.run((token) => performDesktopActivation(desktopId, token));
  }
  activateDesktopRef.current = activateDesktop;

  async function createDesktop(name: string) {
    const desktop = await createDesktopMutation(name);
    setDesktops((current) => [...current, desktop]);
    await activateDesktop(desktop.id);
  }

  async function renameDesktop(desktopId: string, name: string) {
    if (!desktopsRef.current.find((desktop) => desktop.id === desktopId)?.capabilities.manage) throw new Error("You do not have permission to rename this desktop.");
    const renamed = await renameDesktopMutation(desktopId, name);
    setDesktops((current) => current.map((desktop) => desktop.id === desktopId ? renamed : desktop));
  }

  async function deleteDesktop(desktopId: string) {
    const desktop = desktops.find((candidate) => candidate.id === desktopId);
    if (!desktop?.capabilities.delete || desktops.filter((candidate) => candidate.ownership === "owned").length === 1) return;
    if (!await requestConfirmation({ title: `Delete ${desktop.name}?`, message: `Delete “${desktop.name}” and every file, folder, and Trash item in it? This cannot be undone.`, confirmLabel: "Delete desktop", danger: true })) return;
    if (desktopId === activeDesktopIdRef.current) {
      const replacement = desktops.find((candidate) => candidate.id !== desktopId)!;
      if (!await activateDesktop(replacement.id)) return;
    }
    await deleteDesktopMutation(desktopId);
    setDesktops((current) => current.filter((candidate) => candidate.id !== desktopId));
    setNotice(`${desktop.name} deleted`);
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
      setError("The app update could not be applied.");
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
      const selected = new Set(ids);
      const rootIds = ids.filter((id) => !entryIndex.ancestors(id).some((ancestor) => selected.has(ancestor.id)));
      const deleted = await deleteEntries(ids);
      const deletedIds = new Set(deleted.map((entry) => entry.id));
      setEntries((current) => current.filter((entry) => !deletedIds.has(entry.id)));
      replaceSelection(selectionScope, selectedIdsRef.current.filter((id) => !deletedIds.has(id)));
      const label = ids.length === 1 ? dialogEntry.name : `${ids.length} items`;
      setNotice(syncStatus === "local" ? `${label} deleted permanently` : `${label} moved to Trash`);
      setUndoTrash(syncStatus === "online" ? { desktopId: activeDesktopIdRef.current, label, rootIds } : null);
    }
    setDialog(null);
  }

  async function handleImport(sources: File[], parentId: string | null, base?: EntryPosition) {
    if (!sources.length || !canMutate) return;
    setError("");
    setImportProgress({ count: sources.length, phase: "preparing" });
    try {
      const offset = childrenCount(parentId);
      const occupied = parentId === null
        ? activeDesktopSegment.entries.map((entry) => responsive.positions.get(entry.id) ?? projectLogicalPosition(entry.position, desktopSize).local)
        : [];
      const positions = sources.map((_, index) => {
        if (parentId !== null) return nextRootEntryPosition(offset + index, window.innerHeight, base, iconMetrics);
        const localPosition = base && index === 0
          ? layoutRef.current.snapToGrid ? snapPositionInView(base) : base
          : nextAvailableDesktopSlot(desktopSize, occupied, responsive.segments.length > 1, offset + index, iconMetrics);
        occupied.push(localPosition);
        return restoreLogicalPosition(localPosition, activeSegment, desktopSize);
      });
      setImportProgress({ count: sources.length, phase: syncStatus === "local" ? "saving" : "syncing" });
      const imported = await importFiles(sources, parentId, positions);
      setEntries((current) => {
        const existingIds = new Set(current.map((entry) => entry.id));
        return [...current, ...imported.filter((entry) => !existingIds.has(entry.id))];
      });
      replaceSelection(parentId === null ? "desktop" : `explorer:${parentId}`, imported.map((entry) => entry.id));
      setNotice(`${imported.length} ${imported.length === 1 ? "file" : "files"} added`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "The upload could not be completed.");
    } finally {
      setImportProgress(null);
    }
  }
  handleImportRef.current = handleImport;

  async function handleWallpaperUpload(file: File, nextLayout: DesktopLayout, desktopId: string) {
    if (!canMutate || desktopId !== activeDesktopIdRef.current) return;
    setError("");
    try {
      await validateWallpaperImage(file);
      const imported = await importFiles([file], null, [positionFor(null)]);
      const image = imported[0];
      setEntries((current) => current.some((entry) => entry.id === image.id) ? current : [...current, image]);
      replaceSelection("desktop", [image.id]);
      await persistLayout({ ...nextLayout, wallpaper: { ...nextLayout.wallpaper, source: `file:${image.id}` } }, desktopId);
      setNotice(`${image.name} added as wallpaper`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The wallpaper image could not be added.");
    }
  }

  async function handleWallpaperSelect(fileId: string, nextLayout: DesktopLayout, desktopId: string) {
    if (!canMutate || desktopId !== activeDesktopIdRef.current) return;
    setError("");
    try {
      const file = await readFile(fileId);
      await validateWallpaperImage(file);
      if (desktopId !== activeDesktopIdRef.current || !entriesRef.current.some((entry) => entry.id === fileId && entry.kind === "file")) return;
      await persistLayout({ ...nextLayout, wallpaper: { ...nextLayout.wallpaper, source: `file:${fileId}` } }, desktopId);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "The wallpaper image could not be selected.");
    }
  }

  async function handleDesktopMove(entry: DesktopEntry, position: EntryPosition, targetParentId: string | null) {
    if (!canMutate) return false;
    if (targetParentId) {
      return handleMoveTo(selectedIdSet.has(entry.id) ? selectedEntries : [entry], targetParentId, true);
    }
    const finalPosition = layoutRef.current.snapToGrid ? snapRootEntryPosition(position) : position;
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
      try { await updateRootEntryPositions(updates); return true; }
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
      replaceSelection(selectionScope, []);
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

  function openExplorerWindow(folderId: string | null, syncRoute = true, focus = true) {
    const id = builtinAppTargetId({ kind: "explorer", folderId });
    if (runningAppsRef.current.some((app) => app.id === id)) {
      if (focus) focusApp(id, syncRoute);
      return false;
    }
    const app: ExplorerApp = { ...createAppBase(id, "explorer"), kind: "explorer", folderId };
    updateRunningApps([...runningAppsRef.current, app]);
    if (focus) setFocusedApp(id);
    return true;
  }

  function navigateExplorerWindow(appId: string, folderId: string | null) {
    const nextId = builtinAppTargetId({ kind: "explorer", folderId });
    if (nextId === appId) return;
    const previousApps = runningAppTargets();
    const zIndex = ++nextWindowZRef.current;
    const existing = runningAppsRef.current.find((app) => app.id === nextId);
    if (existing) {
      delete fileDirtyRef.current[appId];
      delete fileLoadGenerationsRef.current[appId];
      updateRunningApps(runningAppsRef.current.filter((app) => app.id !== appId).map((app) => app.id === nextId ? { ...app, minimized: false, zIndex } : app));
    } else {
      updateRunningApps(runningAppsRef.current.map((app) => app.id === appId && app.kind === "explorer" ? { ...app, id: nextId, folderId, zIndex } : app));
    }
    setFocusedApp(nextId);
    const currentRoute = routeRef.current;
    if (currentRoute && existing) {
      const segment = segmentForApp(existing);
      navigateRoute({ ...segment, explorerFolderId: folderId }, "push", previousApps);
    } else if (currentRoute) navigateRoute({ column: currentRoute.column, row: currentRoute.row, explorerFolderId: folderId }, "push", previousApps);
  }

  function openSettingsWindow(syncRoute = true) {
    if (!activeDesktop?.capabilities.settings && !activeDesktop?.capabilities.activity) return false;
    const id = builtinAppTargetId({ kind: "settings" });
    if (runningAppsRef.current.some((app) => app.id === id)) {
      focusApp(id, syncRoute);
      return false;
    }
    const previousApps = runningAppTargets();
    const app: SettingsApp = { ...createAppBase(id, "settings"), kind: "settings" };
    updateRunningApps([...runningAppsRef.current, app]);
    setFocusedApp(id);
    const currentRoute = routeRef.current;
    if (syncRoute && currentRoute) navigateRoute({ column: currentRoute.column, row: currentRoute.row, settings: true }, "push", previousApps);
    return true;
  }

  function openPropertiesWindow(entryId: string, syncRoute = true) {
    const entry = entriesRef.current.find((candidate) => candidate.id === entryId);
    if (!entry) return false;
    const id = builtinAppTargetId({ kind: "properties", entryId });
    if (runningAppsRef.current.some((app) => app.id === id)) {
      focusApp(id, syncRoute);
      return false;
    }
    const previousApps = runningAppTargets();
    const app: PropertiesApp = { ...createAppBase(id, "properties"), kind: "properties", entryId };
    updateRunningApps([...runningAppsRef.current, app]);
    setFocusedApp(id);
    const currentRoute = routeRef.current;
    if (syncRoute && currentRoute) navigateRoute({ column: currentRoute.column, row: currentRoute.row, propertiesEntryId: entryId }, "push", previousApps);
    return true;
  }

  function openFileWindow(file: FileEntry, syncRoute = true, focus = true, editMode = false) {
    const id = builtinAppTargetId({ kind: "file", fileId: file.id });
    if (runningAppsRef.current.some((app) => app.id === id)) {
      if (editMode) updateRunningApps((current) => current.map((app) => app.id === id && app.kind === "file" ? { ...app, editMode: true } : app));
      if (focus) focusApp(id, syncRoute);
      return false;
    }
    const expectedRevision = contentRevisionsRef.current[file.id] ?? 0;
    const app: FileApp = {
      ...createAppBase(id, "file"),
      kind: "file",
      fileId: file.id,
      file,
      editMode,
      contentRevision: expectedRevision,
      remoteChanged: false,
    };
    updateRunningApps([...runningAppsRef.current, app]);
    if (focus) setFocusedApp(id);
    loadFileApp(id, file, expectedRevision);
    return true;
  }

  async function openAppPackage(file: FileEntry, launchFile?: FileEntry) {
    setError("");
    let pendingInstanceId: string | null = null;
    let pendingHost: { close(): void } | null = null;
    try {
      const blob = await readFile(file.id);
      const { inspectAppArchive } = await import("@hiraya/app-cli");
      const appPackage = await inspectAppArchive(new Uint8Array(await blob.arrayBuffer()));
      const existing = runningAppsRef.current.find((app): app is SandboxApp => app.kind === "sandbox" && app.package.manifest.id === appPackage.manifest.id);
      if (!launchFile && existing && existing.fileId === file.id && existing.package.digest === appPackage.digest && existing.package.manifest.version === appPackage.manifest.version) { focusApp(existing.id); return; }
      const approved = installedApps.find((item) => item.appId === appPackage.manifest.id);
      if (!packageMatchesInstall(approved, file.id, appPackage.digest, appPackage.manifest.version)) {
        const permissions = appPackage.manifest.permissions.length ? appPackage.manifest.permissions.join(", ") : "None";
        const confirmed = await requestConfirmation({ title: `${approved ? "Approve updated" : "Install"} ${appPackage.manifest.name}?`, message: `Requested permissions: ${permissions}. The package is isolated from Hiraya and the network except through approved host services.`, confirmLabel: approved ? "Approve update" : "Install and run" });
        if (!confirmed || !entriesRef.current.some((entry) => entry.id === file.id)) return;
        const next: InstalledApp = { appId: appPackage.manifest.id, packageEntryId: file.id, digest: appPackage.digest, version: appPackage.manifest.version, manifest: appPackage.manifest, approvedAt: Date.now() };
        await installApp(next);
        setInstalledApps((current) => [...current.filter((item) => item.appId !== next.appId), next]);
      }
      if (existing && !launchFile) closeApp(existing.id);
      const id = `sandbox:${file.id}:${crypto.randomUUID()}`;
      pendingInstanceId = id;
      const base = createAppBase(id, "sandbox");
      const launchHandles = launchFile && appPackage.manifest.permissions.includes("files:read")
        ? [appCapabilities.grantFile(id, launchFile.id, appPackage.manifest.permissions.includes("files:write") ? ["stat", "read", "write"] : ["stat", "read"])]
        : [];
      const host = appHostServices.openInstance({
        instanceId: id,
        launch: {
          protocolVersion: 1,
          appId: appPackage.manifest.id,
          launchId: crypto.randomUUID(),
          source: launchFile ? "file" : "launcher",
          files: launchHandles,
          folders: [],
          arguments: [],
          theme: mapThemeTokens(activeTheme),
        },
        window: { focused: true, maximized: false, fullscreen: false, width: Math.round(base.bounds.width), height: Math.round(base.bounds.height) },
        title: appPackage.manifest.name,
      });
      pendingHost = host;
      const runtimeHost = {
        ...host,
        dialogs: {
          openFile: host.dialogs.openFile,
          openFolder: host.dialogs.openFolder,
          saveFile: host.dialogs.saveFile,
          confirm: async (params: { title: string; message: string; confirmLabel?: string; destructive?: boolean }) => requestConfirmation({ title: params.title, message: params.message, confirmLabel: params.confirmLabel ?? "Confirm", danger: params.destructive }),
        },
      };
      const files = new FileService({
        appInstanceId: id,
        permissions: appPackage.manifest.permissions,
        capabilities: appCapabilities,
        getSnapshot: () => appSnapshotRef.current ?? (() => { throw new HostServiceError("The desktop is unavailable.", "UNAVAILABLE"); })(),
        sync: {
          readFile,
          saveFile: saveAppFile,
          createFile: createAppFile,
          createFolder,
          renameEntry,
          moveEntry: moveAppEntry,
          deleteEntry: deleteAppEntry,
        },
        createPosition: () => positionFor(null),
      });
      const dispatcher = new RpcDispatcher({
        permissions: appPackage.manifest.permissions,
        host: runtimeHost,
        files,
        commands: new RuntimeCommandContributions(commandService, appPackage.manifest.id, (commandId) => dispatcher.emit("commands.invoked", { id: commandId })),
      });
      const app: SandboxApp = { ...base, kind: "sandbox", fileId: file.id, title: appPackage.manifest.name, dirty: false, package: appPackage, dispatcher };
      updateRunningApps([...runningAppsRef.current, app]);
      setFocusedApp(id);
      pendingInstanceId = null;
      pendingHost = null;
    } catch (openError) {
      pendingHost?.close();
      if (pendingInstanceId) appCapabilities.revokeInstance(pendingInstanceId);
      setError(openError instanceof Error ? openError.message : "The app package could not be opened.");
    }
  }

  async function removeInstalledApp(app: InstalledApp) {
    if (!await requestConfirmation({ title: `Uninstall ${app.manifest.name}?`, message: "This removes its approval and device-local app data. The package and your files are not deleted.", confirmLabel: "Uninstall", danger: true })) return;
    for (const running of [...runningAppsRef.current]) if (running.kind === "sandbox" && running.package.manifest.id === app.appId) closeApp(running.id);
    await uninstallApp(app.appId);
    setInstalledApps((current) => current.filter((item) => item.appId !== app.appId));
    setNotice(`${app.manifest.name} uninstalled`);
  }

  async function openInternetShortcut(file: FileEntry, popup: Window | null) {
    if (!popup) {
      setError("The link was blocked by the browser. Allow pop-ups for Hiraya and try again.");
      return;
    }
    popup.opener = null;
    try {
      const shortcut = parseInternetShortcut(await (await readFile(file.id)).text());
      popup.location.replace(shortcut.url);
    } catch (openError) {
      popup.close();
      setError(openError instanceof Error ? openError.message : "The internet shortcut could not be opened.");
    }
  }

  function handleOpen(entry: DesktopEntry) {
    setContextMenu(null);
    if (entry.kind === "file" && isAppPackageName(entry.name)) {
      void openAppPackage(entry);
      return;
    }
    if (entry.kind === "file" && fileCapabilities(entry).preview === "url") {
      setError("");
      void openInternetShortcut(entry, window.open("about:blank", "_blank"));
      return;
    }
    const currentRoute = routeRef.current;
    if (!currentRoute) return;
    const existingId = entry.kind === "folder"
      ? builtinAppTargetId({ kind: "explorer", folderId: entry.id })
      : builtinAppTargetId({ kind: "file", fileId: entry.id });
    if (runningAppsRef.current.some((app) => app.id === existingId)) {
      focusApp(existingId);
      return;
    }
    const previousApps = runningAppTargets();
    if (entry.kind === "folder") {
      const created = openExplorerWindow(entry.id, false);
      navigateRoute({ column: currentRoute.column, row: currentRoute.row, explorerFolderId: entry.id }, created ? "push" : "replace", previousApps);
      return;
    }
    setError("");
    const created = openFileWindow(entry, false);
    navigateRoute({ column: currentRoute.column, row: currentRoute.row, fileId: entry.id }, created ? "push" : "replace", previousApps);
  }

  function handleEditFile(file: FileEntry) {
    setContextMenu(null);
    const currentRoute = routeRef.current;
    if (!currentRoute || !fileCapabilities(file).editable) return;
    const previousApps = runningAppTargets();
    const created = openFileWindow(file, false, true, true);
    navigateRoute({ column: currentRoute.column, row: currentRoute.row, fileId: file.id }, created ? "push" : "replace", previousApps);
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

  async function copyDeepLink(entry: DesktopEntry) {
    const segment = entry.parentId === null ? projectLogicalPosition(entry.position, desktopSizeRef.current).segment : activeSegment;
    const target = entry.kind === "folder"
      ? { desktopId: activeDesktopIdRef.current, ...segment, explorerFolderId: entry.id }
      : { desktopId: activeDesktopIdRef.current, ...segment, fileId: entry.id };
    const url = new URL(window.location.href);
    url.hash = formatDesktopRoute(target);
    try {
      await navigator.clipboard.writeText(url.href);
      setNotice(`Link to ${entry.name} copied`);
      setContextMenu(null);
    } catch {
      setError("The browser did not allow Hiraya to copy this link.");
    }
  }

  async function changeOfflineAvailability(file: FileEntry, available: boolean) {
    if (offlineBusyId) return;
    setOfflineBusyId(file.id);
    setError("");
    try {
      if (available) await makeFileAvailableOffline(file.id);
      else await removeFileFromOfflineCache(file.id);
      setOfflineAvailability((current) => ({ ...current, [file.id]: available }));
      setNotice(available ? `${file.name} is available offline` : `Offline copy of ${file.name} removed`);
      setContextMenu(null);
    } catch (availabilityError) {
      setError(availabilityError instanceof Error ? availabilityError.message : "Offline availability could not be changed.");
    } finally {
      setOfflineBusyId(null);
    }
  }

  async function undoMoveToTrash() {
    const pending = undoTrash;
    if (!pending) return;
    try {
      if (activeDesktopIdRef.current !== pending.desktopId && !await activateDesktop(pending.desktopId)) return;
      for (const id of pending.rootIds) await restoreTrash(pending.desktopId, id, "original");
      setUndoTrash(null);
      setNotice(`${pending.label} restored`);
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "The Trash move could not be undone.");
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
      roots.forEach((entry, index) => positions.set(entry.id, nextRootEntryPosition(childrenCount(parentId) + index, window.innerHeight, undefined, iconMetrics)));
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
      const archive = await exportSeededDesktop(readFile);
      const url = URL.createObjectURL(archive);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "hiraya-seeded.zip";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Desktop package exported");
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

  function goToSegment(segment: SurfaceSegment, mode: "push" | "replace" = "push", preferredApp?: RunningApp | null) {
    const currentRoute = routeRef.current;
    if (!currentRoute) return;
    if (canvasRef.current) {
      const nextMinColumn = Math.min(0, segment.column, ...occupiedSegments.map((candidate) => candidate.segment.column));
      const nextMinRow = Math.min(0, segment.row, ...occupiedSegments.map((candidate) => candidate.segment.row));
      canvasRef.current.style.transform = `translate3d(${-(segment.column - nextMinColumn) * desktopSize.width}px, ${-(segment.row - nextMinRow) * desktopSize.height}px, 0)`;
    }
    const nextApp = preferredApp && appIsInSegment(preferredApp, segment)
      ? preferredApp
      : topAppInSegment(runningAppsRef.current, segment);
    setFocusedApp(nextApp?.id ?? null);
    navigateRoute(routeForApp(nextApp, { ...currentRoute, ...segment }), mode);
  }

  function appIsMaximized(app: RunningApp) {
    const local = projectLogicalPosition(app.bounds, desktopSizeRef.current).local;
    return local.x === 0 && local.y === 0 && app.bounds.width === desktopSizeRef.current.width && app.bounds.height === desktopSizeRef.current.height;
  }

  function toggleMaximizeApp(id: string) {
    const app = runningAppsRef.current.find((candidate) => candidate.id === id);
    if (!app) return;
    const size = desktopSizeRef.current;
    const segment = projectLogicalPosition(app.bounds, size).segment;
    const restored = restoredWindowBoundsRef.current.get(id);
    const maximized = appIsMaximized(app);
    const fallback = initialWindowBounds(size, app.kind === "sandbox" ? { width: 820, height: 620, minWidth: 360, minHeight: 260 } : builtinAppMaximizeRestoreWindow(app.kind));
    const bounds = maximized
      ? restored ?? { ...fallback, ...restoreLogicalPosition(fallback, segment, size) }
      : { ...restoreLogicalPosition({ x: 0, y: 0 }, segment, size), width: size.width, height: size.height };
    if (!maximized) restoredWindowBoundsRef.current.set(id, app.bounds);
    else restoredWindowBoundsRef.current.delete(id);
    updateRunningApps((current) => current.map((candidate) => candidate.id === id ? { ...candidate, bounds } : candidate));
    if (app.kind === "sandbox") appLifecycle.setHostState({ appId: app.package.manifest.id, instanceId: app.id }, { maximized: !maximized, width: Math.round(bounds.width), height: Math.round(bounds.height) });
    focusApp(id);
  }

  function moveAppToArea(id: string, direction: "left" | "right" | "up" | "down") {
    const app = runningAppsRef.current.find((candidate) => candidate.id === id);
    if (!app) return;
    const size = desktopSizeRef.current;
    const projection = projectLogicalPosition(app.bounds, size);
    const segment = {
      column: projection.segment.column + (direction === "left" ? -1 : direction === "right" ? 1 : 0),
      row: projection.segment.row + (direction === "up" ? -1 : direction === "down" ? 1 : 0),
    };
    const moved = { ...app, bounds: { ...app.bounds, ...restoreLogicalPosition(projection.local, segment, size) } };
    updateRunningApps((current) => current.map((candidate) => candidate.id === id ? moved : candidate));
    goToSegment(segment, "push", moved);
  }

  windowCommandRef.current = { maximize: toggleMaximizeApp, move: moveAppToArea };

  function edgeAt(clientX: number, clientY: number) {
    const desktop = desktopRef.current;
    if (!desktop) return null;
    const bounds = desktop.getBoundingClientRect();
    const threshold = Math.min(36, Math.max(24, Math.min(bounds.width, bounds.height) * 0.06));
    return ([
      { direction: "left" as const, distance: clientX - bounds.left },
      { direction: "right" as const, distance: bounds.right - clientX },
      { direction: "up" as const, distance: clientY - bounds.top },
      { direction: "down" as const, distance: bounds.bottom - clientY },
    ]).filter((candidate) => candidate.distance <= threshold).sort((a, b) => a.distance - b.distance)[0] ?? null;
  }

  function handleDesktopPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".file-icon, .empty-state__actions, .app-window")) return;
    if (event.pointerType !== "touch") {
      event.preventDefault();
      const additive = event.metaKey || event.ctrlKey;
      const initial = additive && selectionScope === "desktop" ? [...selectedIdsRef.current] : [];
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
    const edge = edgeAt(clientX, clientY);
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
      edgeNavigationRef.current = { route: routeRef.current, historyState: window.history.state, draftEntryId: entry.id, focusedAppId: focusedAppIdRef.current };
    }
    const pending = edgeNavigationRef.current;
    if (!pending || pending.draftEntryId !== entry.id) return null;
    pending.targetSegment = targetSegment;
    const targetMinColumn = Math.min(responsive.minColumn, targetSegment.column);
    const targetMinRow = Math.min(responsive.minRow, targetSegment.row);
    const targetMaxColumn = Math.max(responsive.maxColumn, targetSegment.column);
    const targetMaxRow = Math.max(responsive.maxRow, targetSegment.row);
    const previousCanvasColumn = previousSegment.column - minColumn;
    const previousCanvasRow = previousSegment.row - minRow;
    const targetCanvasColumn = targetSegment.column - targetMinColumn;
    const targetCanvasRow = targetSegment.row - targetMinRow;
    edgeDragRef.current = { direction: edge.direction, time: now };
    goToSegment(targetSegment, "replace");
    return {
      deltaX: (targetCanvasColumn - previousCanvasColumn) * desktopSize.width,
      deltaY: (targetCanvasRow - previousCanvasRow) * desktopSize.height,
      maxX: Math.max(8, (targetMaxColumn - targetMinColumn + 1) * desktopSize.width - iconMetrics.width),
      maxY: Math.max(8, (targetMaxRow - targetMinRow + 1) * desktopSize.height - iconMetrics.height),
    };
  }

  function handleWindowDragAtEdge(appId: string, clientX: number, clientY: number, localBounds: WindowBounds) {
    const edge = edgeAt(clientX, clientY);
    if (!edge) {
      windowEdgeDragRef.current.direction = "";
      return null;
    }
    const now = performance.now();
    if (windowEdgeDragRef.current.direction === edge.direction && now - windowEdgeDragRef.current.time < 520) return null;
    const app = runningAppsRef.current.find((candidate) => candidate.id === appId);
    if (!app) return null;
    const previousSegment = windowEdgeNavigationRef.current?.targetSegment ?? segmentForApp(app);
    const targetSegment = {
      column: previousSegment.column + (edge.direction === "left" ? -1 : edge.direction === "right" ? 1 : 0),
      row: previousSegment.row + (edge.direction === "up" ? -1 : edge.direction === "down" ? 1 : 0),
    };
    if (!windowEdgeNavigationRef.current && routeRef.current) {
      windowEdgeNavigationRef.current = { appId, bounds: { ...app.bounds }, route: routeRef.current, historyState: window.history.state };
    }
    const pending = windowEdgeNavigationRef.current;
    if (!pending || pending.appId !== appId) return null;
    const logicalBounds = { ...localBounds, ...restoreLogicalPosition(localBounds, targetSegment, desktopSize) };
    const movedApp = { ...app, bounds: logicalBounds };
    pending.targetSegment = targetSegment;
    windowEdgeDragRef.current = { direction: edge.direction, time: now };
    updateRunningApps((current) => current.map((candidate) => candidate.id === appId ? movedApp : candidate));
    goToSegment(targetSegment, "replace", movedApp);
    return localBounds;
  }

  function finishWindowEdgeNavigation(appId: string, cancelled: boolean) {
    const pending = windowEdgeNavigationRef.current;
    windowEdgeNavigationRef.current = null;
    windowEdgeDragRef.current.direction = "";
    if (!pending || pending.appId !== appId) return;
    const finalRoute = routeRef.current;
    window.history.replaceState(pending.historyState, "", formatDesktopRoute(pending.route));
    if (cancelled || !finalRoute) {
      updateRunningApps((current) => current.map((app) => app.id === appId ? { ...app, bounds: pending.bounds } : app));
      setCurrentRoute(pending.route);
      setFocusedApp(appId);
      return;
    }
    writeRoute(finalRoute, "push");
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
      setFocusedApp(pending.focusedAppId ?? null);
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

  function previewSegmentMove(sourceSegmentKey: string, targetIndex: number) {
    const byKey = new Map(responsiveDesktop(entriesRef.current, desktopSize, iconMetrics).segments.map((candidate) => [candidate.key, candidate.segment]));
    for (const app of runningAppsRef.current) {
      const segment = segmentForApp(app);
      byKey.set(segmentKey(segment), segment);
    }
    const segments = [...byKey.values()].sort((a, b) => a.row - b.row || a.column - b.column);
    const moves = reorderSurfaceSegments(segments, sourceSegmentKey, targetIndex);
    if (!moves.length) return null;
    const targets = new Map(moves.map((move) => [segmentKey(move.source), move.target]));
    const targetSegment = targets.get(sourceSegmentKey);
    const next = entriesRef.current.map((entry) => {
      if (entry.parentId !== null) return entry;
      const projection = projectLogicalPosition(entry.position, desktopSize);
      const target = targets.get(segmentKey(projection.segment));
      return target ? { ...entry, position: restoreLogicalPosition(projection.local, target, desktopSize) } : entry;
    });
    entriesRef.current = next;
    setEntries(next);
    const nextApps = runningAppsRef.current.map((app) => {
      const projection = projectLogicalPosition(app.bounds, desktopSize);
      const target = targets.get(segmentKey(projection.segment));
      return target ? { ...app, bounds: { ...app.bounds, ...restoreLogicalPosition(projection.local, target, desktopSize) } } : app;
    });
    updateRunningApps(nextApps);
    const focused = nextApps.find((app) => app.id === focusedAppIdRef.current && !app.minimized && appIsInSegment(app, activeSegment));
    if (!focused) setFocusedApp(topAppInSegment(nextApps, activeSegment)?.id ?? null);
    return targetSegment ? segmentKey(targetSegment) : sourceSegmentKey;
  }

  function restoreArrangement(initialPositions: Array<{ entryId: string; position: EntryPosition }>, initialAppBounds: Array<{ appId: string; bounds: WindowBounds }>) {
    const initial = new Map(initialPositions.map((update) => [update.entryId, update.position]));
    const next = entriesRef.current.map((entry) => initial.has(entry.id) ? { ...entry, position: initial.get(entry.id)! } : entry);
    entriesRef.current = next;
    setEntries(next);
    const appBounds = new Map(initialAppBounds.map((app) => [app.appId, app.bounds]));
    updateRunningApps((current) => current.map((app) => appBounds.has(app.id) ? { ...app, bounds: appBounds.get(app.id)! } : app));
  }

  function persistArrangement(initialPositions: Array<{ entryId: string; position: EntryPosition }>, initialAppBounds: Array<{ appId: string; bounds: WindowBounds }>) {
    if (!canMutate) { restoreArrangement(initialPositions, initialAppBounds); return; }
    const updates = entriesRef.current
      .filter((entry) => entry.parentId === null)
      .map((entry) => ({ entryId: entry.id, position: entry.position }));
    const save = updates.length ? updateRootEntryPositions(updates) : Promise.resolve();
    void save.catch(() => {
      restoreArrangement(initialPositions, initialAppBounds);
      const currentRoute = routeRef.current;
      if (currentRoute) goToSegment(currentRoute, "replace");
      setError("The desktop area arrangement could not be saved.");
    });
  }

  function startMinimapPress(event: React.PointerEvent<HTMLButtonElement>, pressedSegmentKey: string) {
    if (event.button !== 0 || !canMutate) return;
    const press = {
      activated: editingAreas,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
      segmentKey: pressedSegmentKey,
      initialPositions: entriesRef.current
        .filter((entry) => entry.parentId === null)
        .map((entry) => ({ entryId: entry.id, position: { ...entry.position } })),
      initialAppBounds: runningAppsRef.current.map((app) => ({ appId: app.id, bounds: { ...app.bounds } })),
    };
    press.timer = window.setTimeout(() => {
      press.activated = true;
      setEditingAreas(true);
      setDraggedSegmentKey(pressedSegmentKey);
      suppressClickRef.current = true;
    }, editingAreas ? 0 : MINIMAP_LONG_PRESS_MS);
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
      .map((element) => element.closest<HTMLElement>("[data-segment-key]"))
      .find(Boolean);
    if (!target?.dataset.segmentKey) return;
    const targetIndex = occupiedSegments.findIndex((candidate) => candidate.key === target.dataset.segmentKey);
    const targetKey = previewSegmentMove(press.segmentKey, targetIndex);
    if (targetKey) {
      press.segmentKey = targetKey;
      setDraggedSegmentKey(targetKey);
    }
  }

  function finishMinimapPress(event: React.PointerEvent<HTMLButtonElement>, cancelled = false) {
    const press = minimapPointerRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    window.clearTimeout(press.timer);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    minimapPointerRef.current = null;
    if (press.activated && cancelled) {
      restoreArrangement(press.initialPositions, press.initialAppBounds);
      setDraggedSegmentKey(null);
      goToSegment(activeSegment, "replace");
    } else if (press.activated) {
      setDraggedSegmentKey(null);
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      persistArrangement(press.initialPositions, press.initialAppBounds);
      goToSegment(activeSegment, "replace");
    } else if (!cancelled) {
      const selectedSegment = occupiedSegments.find((candidate) => candidate.key === press.segmentKey);
      if (selectedSegment) goToSegment(selectedSegment.segment);
    }
  }

  function invalidMoveIds(items: readonly DesktopEntry[]) {
    return new Set(items.flatMap((entry) => [entry.id, ...entryIndex.descendants(entry.id).map((descendant) => descendant.id)]));
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

  function runningAppLabel(app: RunningApp) {
    const entry = app.kind === "file" ? entryIndex.byId.get(app.fileId) : app.kind === "properties" ? entryIndex.byId.get(app.entryId) : app.kind === "explorer" && app.folderId ? entryIndex.byId.get(app.folderId) : null;
    return app.kind === "sandbox" ? app.title : app.kind === "settings" ? "Settings" : app.kind === "properties" ? `${entry?.name ?? "Item"} properties` : app.kind === "explorer" ? entry?.name ?? activeDesktopName : entry?.name ?? app.file?.name ?? "File";
  }

  const windowItems: WindowListItem[] = runningApps.map((app) => {
    const area = segmentForApp(app);
    const areaIndex = visibleSegments.findIndex((candidate) => candidate.key === segmentKey(area));
    return { id: app.id, title: runningAppLabel(app), areaId: segmentKey(area), areaLabel: `Area ${areaIndex >= 0 ? areaIndex + 1 : `${area.column}, ${area.row}`}`, minimized: app.minimized };
  });
  const commandContext: AppCommandContext = {
    canMutate,
    canOpenTrash: activeDesktop?.capabilities.write ?? false,
    canOpenSettings: Boolean(activeDesktop?.capabilities.settings || activeDesktop?.capabilities.activity),
    createFile: () => setDialog({ type: "create-file", parentId: null }),
    createFolder: () => setDialog({ type: "create-folder", parentId: null }),
    uploadFiles: () => chooseUpload(null),
    openSettings: openSettingsWindow,
    openPanel: setActivePanel,
  };
  const searchCommands = commandService.list(commandContext);
  const keyboardShortcuts: KeyboardShortcut[] = [
    { id: "search", group: "Navigation", label: "Search files, windows, and commands", keys: ["Ctrl/⌘", "K"] },
    { id: "shortcuts", group: "Navigation", label: "Show keyboard shortcuts", keys: ["?"] },
    { id: "select-all", group: "Files", label: "Select all in the current view", keys: ["Ctrl/⌘", "A"] },
    { id: "copy", group: "Files", label: "Copy selected items", keys: ["Ctrl/⌘", "C"] },
    { id: "paste", group: "Files", label: "Paste items", keys: ["Ctrl/⌘", "V"] },
    { id: "trash", group: "Files", label: "Move selected items to Trash", keys: ["Delete"] },
    { id: "save", group: "Editor", label: "Save the open file", keys: ["Ctrl/⌘", "S"] },
    { id: "maximize", group: "Windows", label: "Maximize or restore focused window", keys: ["Alt", "Enter"] },
    { id: "move-window", group: "Windows", label: "Move focused window between areas", keys: ["Alt", "Arrow key"] },
    { id: "close", group: "Windows", label: "Close the top panel or focused window", keys: ["Escape"] },
  ];

  function runSearchCommand(commandId: CommandId) {
    void commandService.execute(commandId, commandContext);
  }

  return (
    <main className="desktop-shell" data-theme={isBuiltinThemeId(appearance.selectedThemeId) ? appearance.selectedThemeId : "custom"} style={themeStyle(activeTheme)}>
      <header className="menu-bar">
        {activeDesktopId && <DesktopSwitcher desktops={desktops} activeDesktopId={activeDesktopId} disabled={loading} quota={catalogQuota} quotaStale={syncStatus === "offline"} onSwitch={(id) => void activateDesktop(id)} onCreate={createDesktop} onRename={renameDesktop} onDelete={deleteDesktop} canManageDesktop={(desktop) => desktop.ownership === "owned" || syncStatus === "online"} />}
        <nav className="taskbar" aria-label="Open windows">
          {runningApps.map((app) => {
            const entry = app.kind === "file" ? entryIndex.byId.get(app.fileId) : app.kind === "properties" ? entryIndex.byId.get(app.entryId) : app.kind === "explorer" && app.folderId ? entryIndex.byId.get(app.folderId) : null;
            const label = runningAppLabel(app);
            return (
              <button
                className="taskbar__entry"
                data-active={focusedAppId === app.id && !app.minimized || undefined}
                data-minimized={app.minimized || undefined}
                data-dirty={dirtyAppIds.has(app.id) || undefined}
                type="button"
                key={app.id}
                title={label}
                aria-label={`${app.minimized ? "Restore" : focusedAppId === app.id && !isMobile ? "Minimize" : "Switch to"} ${label}`}
                aria-pressed={focusedAppId === app.id && !app.minimized}
                onClick={() => focusedAppId === app.id && !app.minimized && !isMobile ? minimizeApp(app.id) : focusApp(app.id)}
              >
                {app.kind === "file" ? entry?.kind === "file" && fileCapabilities(entry).icon === "url" ? <LinkSimple size={15} /> : <FileGlyph size={15} /> : app.kind === "explorer" ? <Folder size={15} /> : app.kind === "properties" ? <Info size={15} /> : <GearSix size={15} />}
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
        <div className="menu-bar__actions">
          {compactChrome ? (
            <MobileHeaderMenu label="Create or upload" icon={<Plus size={18} weight="bold" />}>
              {(dismiss) => <>
                <button type="button" disabled={!canMutate} onClick={() => { dismiss(); setDialog({ type: "create-file", parentId: null }); }}><FileGlyph size={17} /> New text file</button>
                <button type="button" disabled={!canMutate} onClick={() => { dismiss(); setDialog({ type: "create-folder", parentId: null }); }}><FolderPlus size={17} /> New folder</button>
                <button type="button" disabled={!canMutate} onClick={() => { dismiss(); chooseUpload(null); }}><UploadSimple size={17} /> Upload files</button>
              </>}
            </MobileHeaderMenu>
          ) : <>
            <button type="button" aria-label="New text file" disabled={!canMutate} onClick={() => setDialog({ type: "create-file", parentId: null })}><Plus size={15} weight="bold" /> <span>New text file</span></button>
            <button type="button" aria-label="New folder" disabled={!canMutate} onClick={() => setDialog({ type: "create-folder", parentId: null })}><FolderPlus size={16} /> <span>New folder</span></button>
            <button type="button" aria-label="Upload files" disabled={!canMutate} onClick={() => chooseUpload(null)}><UploadSimple size={16} /> <span>Upload files</span></button>
            <button type="button" aria-label="Search files, windows, and commands" title="Search (Ctrl/Command K)" onClick={() => setActivePanel("search")}><MagnifyingGlass size={16} /></button>
            <button type="button" aria-label="Show all windows" title="All windows" onClick={() => setActivePanel("windows")}><SquaresFour size={16} /></button>
            {canMutate && <button type="button" aria-label="Open Trash" title="Trash" onClick={() => setActivePanel("trash")}><Trash size={16} /></button>}
          </>}
          {compactChrome ? <MobileHeaderMenu label="Navigation and tools" icon={<GearSix size={18} />}>
            {(dismiss) => <>
              <button type="button" onClick={() => { dismiss(); setActivePanel("search"); }}><MagnifyingGlass size={17} /> Search</button>
              <button type="button" onClick={() => { dismiss(); setActivePanel("windows"); }}><SquaresFour size={17} /> All windows</button>
              {canMutate && <button type="button" onClick={() => { dismiss(); setActivePanel("trash"); }}><Trash size={17} /> Trash</button>}
              <button type="button" onClick={() => { dismiss(); setActivePanel("shortcuts"); }}><Keyboard size={17} /> Keyboard shortcuts</button>
              {(activeDesktop?.capabilities.settings || activeDesktop?.capabilities.activity) && <button type="button" onClick={() => { dismiss(); openSettingsWindow(); }}><GearSix size={17} /> Settings</button>}
              {session && activeDesktop?.capabilities.manage && <button type="button" disabled={!canManage} onClick={() => { dismiss(); setSharingOpen(true); }}><ShareNetwork size={17} /> Share desktop</button>}
            </>}
          </MobileHeaderMenu> : (activeDesktop?.capabilities.settings || activeDesktop?.capabilities.activity) && <button type="button" aria-label="Open settings" title="Settings" onClick={() => openSettingsWindow()}><GearSix size={16} /> <span>Settings</span></button>}
          {!compactChrome && session && activeDesktop?.capabilities.manage && <button type="button" aria-label="Share desktop" title="Share desktop" disabled={!canManage} onClick={() => setSharingOpen(true)}><ShareNetwork size={16} /> <span>Share</span></button>}
          {session && <AccountMenu session={session} />}
          <button className="menu-bar__sync" data-status={syncIndicatorStatus} type="button" aria-label="Open sync status" title={syncIndicatorStatus === "local" ? "Changes are saved only in this browser" : syncIndicatorStatus === "syncing" ? "Synchronizing saved changes" : syncIndicatorStatus === "online" ? "Changes are saved and synchronized" : syncIndicatorStatus === "connecting" ? "Connecting to the Hiraya server" : syncIndicatorStatus === "blocked" ? "A queued change needs attention before synchronization can continue" : "Offline changes are saved and will synchronize after reconnecting"} onClick={() => setActivePanel("sync")}>
            {syncIndicatorStatus === "local" ? <HardDrive size={15} /> : syncIndicatorStatus === "online" ? <CloudCheck size={15} /> : syncIndicatorStatus === "blocked" ? <WarningCircle size={15} weight="fill" /> : syncIndicatorStatus === "connecting" || syncIndicatorStatus === "syncing" ? <SpinnerGap size={15} /> : <CloudSlash size={15} />}
            <span>{syncIndicatorStatus === "local" ? "Saved locally" : syncIndicatorStatus === "syncing" ? "Syncing" : syncIndicatorStatus === "online" ? "Synced" : syncIndicatorStatus === "connecting" ? "Connecting" : syncIndicatorStatus === "blocked" ? "Sync blocked" : "Offline"}</span>
          </button>
          <span className="menu-bar__clock">{formatClock(clock)}</span>
        </div>
      </header>

      <section
        className="desktop"
        data-wallpaper={layout.wallpaper.source.startsWith("file:") ? wallpaperUrl ? "file" : "dusk" : layout.wallpaper.source}
        data-custom-loaded={wallpaperUrl ? true : undefined}
        style={{
          "--wallpaper-image": wallpaperUrl ? `url(${wallpaperUrl})` : "none",
          "--wallpaper-fit": layout.wallpaper.fit,
          "--wallpaper-position": `${layout.wallpaper.positionX}% ${layout.wallpaper.positionY}%`,
          "--wallpaper-blur": `${layout.wallpaper.blur}px`,
        } as React.CSSProperties}
        ref={desktopRef}
        aria-label={`${activeDesktopName} desktop`}
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
        <div className="wallpaper-image" aria-hidden="true" />
        <div className="wallpaper-dim" aria-hidden="true" style={{ backgroundColor: "#000000", opacity: layout.wallpaper.dim }} />
        <div className="wallpaper-color-overlay" aria-hidden="true" style={{ backgroundColor: layout.wallpaper.overlayColor, opacity: layout.wallpaper.overlayOpacity }} />
        <div className="wallpaper-grain" aria-hidden="true" />
        <div className="desktop-canvas" ref={canvasRef} style={{ width: segmentColumns * desktopSize.width, height: segmentRows * desktopSize.height, transform: `translate3d(${-canvasOffset.column * desktopSize.width}px, ${-canvasOffset.row * desktopSize.height}px, 0)` }}>
          {responsive.segments.flatMap((desktopSegment) => desktopSegment.entries.map((entry) => {
            const segmentColumn = desktopSegment.segment.column - minColumn;
            const segmentRow = desktopSegment.segment.row - minRow;
            const projectedPosition = responsive.positions.get(entry.id) ?? entry.position;
            const renderedEntry = {
              ...entry,
              position: {
                x: segmentColumn * desktopSize.width + projectedPosition.x,
                y: segmentRow * desktopSize.height + projectedPosition.y,
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
              getSnapPreview={layout.snapToGrid ? snapRootEntryPosition : undefined}
              onExternalDrop={(sources) => void handleImport(sources, entry.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!selectedIdSet.has(entry.id)) replaceSelection("desktop", [entry.id]);
                openEntryContextMenu(entry.id, event.clientX, event.clientY);
              }}
              onContextMenuAt={(x, y) => {
                if (!selectedIdSet.has(entry.id)) replaceSelection("desktop", [entry.id]);
                openEntryContextMenu(entry.id, x, y);
              }}
            />;
          }))}
        </div>
        {marquee && <div className="desktop-marquee" aria-hidden="true" style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }} />}

        {loading && <div className="desktop-state desktop-state--loading" role="status"><span className="loading-line" /><span className="loading-line loading-line--short" /><span className="visually-hidden">Loading desktop...</span></div>}
        {!loading && rootEntries.length === 0 && (
          <div className="desktop-state empty-state">
            <span className="empty-state__icon"><HardDrive size={28} weight="duotone" /></span>
            <h1>Your space is ready.</h1>
            <p>{offlineSharedNotice || (syncStatus === "local" ? "Create an item or drop files anywhere. Items are saved only in this browser." : canMutate ? "Create an item or drop files anywhere. Items are saved to this shared desktop and synchronized by the Hiraya server." : "This desktop is read only for your account.")}</p>
            <div className="empty-state__actions">
              <button className="button button--primary" type="button" disabled={!canMutate} onClick={() => setDialog({ type: "create-file", parentId: null })}><Plus size={17} /> New text file</button>
              <button className="button button--quiet" type="button" disabled={!canMutate} onClick={() => setDialog({ type: "create-folder", parentId: null })}><FolderPlus size={17} /> New folder</button>
              <button className="button button--quiet" type="button" disabled={!canMutate} onClick={() => chooseUpload(null)}><UploadSimple size={17} /> Upload files</button>
            </div>
          </div>
        )}
        <div className="drop-message" aria-hidden="true"><UploadSimple size={25} /> Drop files to add them</div>

        <div className="app-window-layer" aria-label="Open windows">
          {runningApps.map((app, index) => {
            const projection = projectLogicalPosition(app.bounds, desktopSize);
            const segmentActive = projection.segment.column === activeSegment.column && projection.segment.row === activeSegment.row;
            const localBounds = { ...app.bounds, ...projection.local };
            const titleId = `running-app-title-${index}`;
            const folderEntry = app.kind === "explorer" && app.folderId ? entryIndex.byId.get(app.folderId) : null;
            const folder = folderEntry?.kind === "folder" ? folderEntry : null;
            const fileEntry = app.kind === "file" ? app.file ?? entryIndex.byId.get(app.fileId) : null;
            const file = fileEntry?.kind === "file" ? fileEntry : null;
            const propertiesEntry = app.kind === "properties" ? entryIndex.byId.get(app.entryId) : null;
            const title = app.kind === "sandbox" ? app.title : app.kind === "settings" ? isMobile && settingsPage !== "main" ? settingsPage === "themes" ? "Themes" : settingsPage === "activity" ? "Activity" : "Apps" : "Settings" : app.kind === "properties" ? `${propertiesEntry?.name ?? "Item"} properties` : app.kind === "explorer" ? folder?.name ?? activeDesktopName : file?.name ?? "Opening file";
            const appWindow = app.kind === "sandbox" ? { minWidth: 360, minHeight: 260 } : builtinAppWindow(app.kind);
            return (
              <AppWindow
                key={app.id}
                id={app.id}
                title={title}
                titleId={titleId}
                bounds={localBounds}
                minWidth={appWindow.minWidth}
                minHeight={appWindow.minHeight}
                zIndex={app.zIndex}
                focused={focusedAppId === app.id}
                minimized={app.minimized}
                segmentActive={segmentActive}
                mobile={isMobile}
                onFocus={focusApp}
                onBoundsChange={updateAppBounds}
                onDragAtEdge={handleWindowDragAtEdge}
                onDragEnd={finishWindowEdgeNavigation}
                onMinimize={minimizeApp}
                onClose={requestCloseApp}
                maximized={appIsMaximized(app)}
                canMoveArea={!isMobile}
                onToggleMaximize={toggleMaximizeApp}
                onMoveArea={moveAppToArea}
                 titleArea={<div><span className="window-kicker">{app.kind === "sandbox" ? "Session app" : app.kind === "file" ? app.editMode || file && ["text", "url"].includes(fileCapabilities(file).preview) ? "Text editor" : file && fileCapabilities(file).preview === "markdown" ? "Markdown" : "Preview" : app.kind === "explorer" ? "Folder" : app.kind === "properties" ? "Properties" : "Hiraya desktop"}</span><h2 id={titleId}>{title}</h2></div>}
              >
                {(headerElements) => <>
                {app.kind === "file" && file && app.blob ? (
                  <FileWindow
                    file={file}
                    blob={app.blob}
                     editable={Boolean(app.editable)}
                     editMode={app.editMode}
                     readOnly={!canMutate}
                     canChangeSettings={canSettings}
                    remoteChanged={app.remoteChanged}
                    headerActionsTarget={headerElements.actions}
                    editorSettings={editorSettings}
                    externalEmbeddedPreviews={externalEmbeddedPreviews === true}
                    theme={activeTheme}
                    onSave={(content) => save(app.id, file.id, content)}
                    onDownload={() => void download(file)}
                    onEdit={() => updateRunningApps((current) => current.map((candidate) => candidate.id === app.id && candidate.kind === "file" ? { ...candidate, editMode: true } : candidate))}
                    onEditorSettingsChange={applyEditorSettings}
                    onResolveLink={(path) => readFileByRelativePath(file.id, path)}
                    onOpenLinkedFile={handleOpen}
                    onDirtyChange={(dirty) => {
                      fileDirtyRef.current[app.id] = dirty;
                      setDirtyAppIds((current) => {
                        if (current.has(app.id) === dirty) return current;
                        const next = new Set(current);
                        if (dirty) next.add(app.id); else next.delete(app.id);
                        return next;
                      });
                    }}
                  />
                ) : app.kind === "file" && file && app.loadError ? (
                  <div className="app-window__loading" role="alert">
                    <span>{app.loadError}</span>
                    <button className="button button--primary" type="button" onClick={() => loadFileApp(app.id, file, app.contentRevision)}>Retry</button>
                  </div>
                ) : app.kind === "file" ? <div className="app-window__loading" role="status"><SpinnerGap size={22} /> Opening {file?.name ?? "file"}...</div> : null}
                {app.kind === "sandbox" && <SandboxAppFrame package={app.package} dispatcher={app.dispatcher} title={app.title} />}
                {app.kind === "explorer" && (
                  <FolderExplorer
                    folder={folder}
                    rootLabel={activeDesktopName}
                    breadcrumbs={folder ? entryIndex.ancestors(folder.id) : []}
                    children={entryIndex.children.get(folder?.id ?? null) ?? []}
                    selectedIds={selectionScope === app.id ? selectedIdSet : new Set()}
                    onSelect={(entry, options) => selectEntry(app.id, entry, options)}
                    onNavigate={(nextFolder) => navigateExplorerWindow(app.id, nextFolder?.id ?? null)}
                    onOpen={handleOpen}
                    onCreateFolder={(parentId) => setDialog({ type: "create-folder", parentId })}
                    onCreateFile={(parentId) => setDialog({ type: "create-file", parentId })}
                    onUpload={chooseUpload}
                    onMove={(entry, parentId) => void handleMoveTo(selectionScope === app.id && selectedIdSet.has(entry.id) ? selectedEntries : [entry], parentId)}
                    onContextMenu={(entry, x, y) => {
                      if (selectionScope !== app.id || !selectedIdSet.has(entry.id)) replaceSelection(app.id, [entry.id]);
                      openEntryContextMenu(entry.id, x, y);
                    }}
                    onBlankContextMenu={(parentId, x, y) => {
                      window.getSelection()?.removeAllRanges();
                      replaceSelection(app.id, []);
                      setContextMenu({ type: "desktop", parentId, x, y, position: positionFor(parentId) });
                    }}
                    readOnly={!canMutate}
                    headerElements={headerElements}
                  />
                )}
                {app.kind === "properties" && propertiesEntry && (
                  <PropertiesWindow
                    entry={propertiesEntry}
                    rootLabel={activeDesktopName}
                    ancestors={entryIndex.ancestors(propertiesEntry.id)}
                    descendants={propertiesEntry.kind === "folder" ? entryIndex.descendants(propertiesEntry.id) : []}
                    offlineAvailable={propertiesEntry.kind === "file" ? offlineAvailability[propertiesEntry.id] ?? null : undefined}
                    offlineBusy={offlineBusyId === propertiesEntry.id}
                    onMakeAvailableOffline={propertiesEntry.kind === "file" && syncStatus !== "local" ? () => void changeOfflineAvailability(propertiesEntry, true) : undefined}
                    onRemoveOfflineCopy={propertiesEntry.kind === "file" && syncStatus !== "local" ? () => void changeOfflineAvailability(propertiesEntry, false) : undefined}
                  />
                )}
                {app.kind === "settings" && (
                  <SettingsWindow
                    page={settingsPage}
                    onPageChange={setSettingsPage}
                    mobileHeaderElements={isMobile ? headerElements : undefined}
                    layout={layout}
                    activeDesktopId={activeDesktopId}
                    entries={entries}
                    wallpaperUrl={wallpaperUrl}
                    appearance={appearance}
                    activeTheme={activeTheme}
                    canMutate={canSettings}
                    exportDisabled={loading}
                    exporting={exporting}
                    fullscreenEnabled={document.fullscreenEnabled}
                    isFullscreen={isFullscreen}
                    updateSupported={updateSupported}
                    updateReady={updateReady}
                    updateChecking={updateChecking}
                    autoUpdate={autoUpdate}
                    externalEmbeddedPreviews={externalEmbeddedPreviews === true}
                    localPreferencesLoaded={externalEmbeddedPreviews !== null}
                    serverBuildTimestamp={serverBuildTimestamp}
                    installedApps={installedApps}
                    onLaunchApp={(installed) => {
                      const entry = entriesRef.current.find((candidate): candidate is FileEntry => candidate.id === installed.packageEntryId && candidate.kind === "file");
                      if (entry) void openAppPackage(entry); else setError("That app package is unavailable.");
                    }}
                    onUninstallApp={(installed) => void removeInstalledApp(installed)}
                    onListActivity={canViewActivity ? listActivity : async () => { throw new Error("Activity is unavailable for your role."); }}
                    onSubscribeToActivity={canViewActivity ? subscribeToActivityChanges : () => () => undefined}
                    canOpenAffectedEntries={(activity) => canOpenActivity(activity, activeDesktopIdRef.current, entriesRef.current, desktops.map((desktop) => desktop.id))}
                    onOpenAffectedEntries={async (activity, ids) => {
                      if (!activity.desktopId) return;
                      if (activity.desktopId !== activeDesktopIdRef.current && !await activateDesktop(activity.desktopId)) return;
                       const affected = ids.map((id) => entriesRef.current.find((entry) => entry.id === id)).filter((entry): entry is DesktopEntry => Boolean(entry));
                       if (affected.length === 1) handleOpen(affected[0]);
                      else if (affected.length > 1) {
                        replaceSelection("desktop", affected.map((entry) => entry.id));
                         const root = affected.find((entry) => entry.parentId === null);
                         if (root) goToSegment(projectLogicalPosition(root.position, desktopSizeRef.current).segment);
                      } else setError("The entries affected by this activity no longer exist.");
                    }}
                    onConfirmThemeDelete={(theme) => requestConfirmation({ title: `Delete ${theme.name}?`, message: `Delete the custom theme “${theme.name}”?`, confirmLabel: "Delete theme", danger: true })}
                    onLayoutPreview={previewLayout}
                    onLayoutChange={persistLayout}
                    onWallpaperUpload={handleWallpaperUpload}
                    onWallpaperSelect={handleWallpaperSelect}
                    onThemeSelect={changeTheme}
                    onThemePreview={setThemePreview}
                    onThemeSave={persistCustomTheme}
                    onThemeDelete={removeCustomTheme}
                    onExport={() => void handleExport()}
                    onToggleFullscreen={() => void toggleFullscreen()}
                    onCheckForUpdate={() => void checkForUpdate()}
                    onAutoUpdateChange={(enabled) => void changeAutoUpdate(enabled)}
                    onExternalEmbeddedPreviewsChange={(enabled) => void changeExternalEmbeddedPreviews(enabled)}
                  />
                )}
                </>}
              </AppWindow>
            );
          })}
        </div>
      </section>

      {(segmentColumns > 1 || segmentRows > 1 || occupiedSegments.length > 1) && (
        <nav className="desktop-minimap" data-editing={editingAreas || undefined} data-obscured={minimapObscured || undefined} aria-label={`${activeDesktopName} desktop areas`}>
          {editingAreas && (
            <div className="desktop-minimap__toolbar">
              <span>Arrange desktop areas</span>
              <button type="button" onClick={() => { setEditingAreas(false); setDraggedSegmentKey(null); }}><Check size={12} /> Done</button>
            </div>
          )}
          <span className="desktop-minimap__summary">Area {Math.max(1, visibleSegments.findIndex((candidate) => candidate.key === activeSegmentKey) + 1)} of {visibleSegments.length}</span>
          <div className="desktop-minimap__grid" style={{ "--minimap-columns": segmentColumns, "--minimap-rows": segmentRows } as React.CSSProperties}>
            {visibleSegments.map((desktopSegment, visibleIndex) => {
              const column = desktopSegment.segment.column - minColumn;
              const row = desktopSegment.segment.row - minRow;
              const currentSegmentKey = desktopSegment.key;
              const actualIndex = occupiedSegments.findIndex((candidate) => candidate.key === currentSegmentKey);
              const isOccupiedSegment = actualIndex >= 0;
              return (
                <div className="desktop-minimap__slot" data-segment-key={isOccupiedSegment ? currentSegmentKey : undefined} data-dragging={draggedSegmentKey === currentSegmentKey || undefined} key={currentSegmentKey} style={{ gridColumn: column + 1, gridRow: row + 1 }}>
                  <button
                    className="desktop-minimap__area"
                    data-active={currentSegmentKey === activeSegmentKey || undefined}
                    type="button"
                    aria-label={`${activeDesktopName}, area ${visibleIndex + 1} of ${visibleSegments.length}${currentSegmentKey === activeSegmentKey ? ", current area" : ""}${editingAreas && isOccupiedSegment ? ", use arrow keys to move" : isOccupiedSegment ? ", long press to arrange" : ""}`}
                    aria-current={currentSegmentKey === activeSegmentKey ? "true" : undefined}
                    onClick={(event) => { if (event.detail === 0 && !editingAreas) goToSegment(desktopSegment.segment); }}
                    onContextMenu={isOccupiedSegment && canMutate ? (event) => { event.preventDefault(); setEditingAreas(true); } : undefined}
                    onPointerDown={isOccupiedSegment ? (event) => startMinimapPress(event, currentSegmentKey) : undefined}
                    onPointerMove={moveMinimapPress}
                    onPointerUp={(event) => finishMinimapPress(event)}
                    onPointerCancel={(event) => finishMinimapPress(event, true)}
                    onKeyDown={(event) => {
                      if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
                        event.preventDefault();
                        setEditingAreas(true);
                      } else if (editingAreas && isOccupiedSegment && (event.key === "ArrowLeft" || event.key === "ArrowUp")) {
                        event.preventDefault();
                        const initial = entriesRef.current.filter((entry) => entry.parentId === null).map((entry) => ({ entryId: entry.id, position: { ...entry.position } }));
                        const initialApps = runningAppsRef.current.map((app) => ({ appId: app.id, bounds: { ...app.bounds } }));
                        const targetKey = previewSegmentMove(currentSegmentKey, actualIndex - 1);
                        if (targetKey) { setDraggedSegmentKey(targetKey); persistArrangement(initial, initialApps); goToSegment(activeSegment, "replace"); }
                      } else if (editingAreas && isOccupiedSegment && (event.key === "ArrowRight" || event.key === "ArrowDown")) {
                        event.preventDefault();
                        const initial = entriesRef.current.filter((entry) => entry.parentId === null).map((entry) => ({ entryId: entry.id, position: { ...entry.position } }));
                        const initialApps = runningAppsRef.current.map((app) => ({ appId: app.id, bounds: { ...app.bounds } }));
                        const targetKey = previewSegmentMove(currentSegmentKey, actualIndex + 1);
                        if (targetKey) { setDraggedSegmentKey(targetKey); persistArrangement(initial, initialApps); goToSegment(activeSegment, "replace"); }
                      }
                    }}
                  >
                    {desktopSegment.entries.map((entry) => {
                      const position = responsive.positions.get(entry.id) ?? entry.position;
                      return <span className="desktop-minimap__file" key={entry.id} style={{ left: `${position.x / desktopSize.width * 100}%`, top: `${position.y / desktopSize.height * 100}%` }} />;
                    })}
                  </button>
                </div>
              );
            })}
          </div>
          <span className="visually-hidden" aria-live="polite">{activeDesktopName}, area {Math.max(1, visibleSegments.findIndex((candidate) => candidate.key === activeSegmentKey) + 1)} of {visibleSegments.length}</span>
        </nav>
      )}

      <input ref={uploadRef} className="visually-hidden" type="file" multiple onChange={(event) => {
        const position = uploadPositionRef.current;
        uploadPositionRef.current = undefined;
        void handleImport(Array.from(event.target.files ?? []), uploadParentRef.current, position);
        event.target.value = "";
      }} />

      {(error || notice || appNotifications.length > 0) && <div className="notification-stack">
        {error && <div className="error-banner" role="alert"><WarningCircle size={19} weight="fill" /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">Dismiss</button></div>}
        {notice && <div className="notice" role="status"><span>{notice}</span>{undoTrash && <button type="button" onClick={() => void undoMoveToTrash()}>Undo</button>}<button type="button" aria-label="Dismiss notice" onClick={() => { setNotice(""); setUndoTrash(null); }}><X size={14} /></button></div>}
        {appNotifications.map((notification) => <div className="notice" role="status" key={notification.id}><span>{[notification.title, notification.body].filter(Boolean).join(": ")}</span><button type="button" aria-label="Dismiss app notification" onClick={() => appHostServices.notifications.dismiss(notification.owner, notification.id)}><X size={14} /></button></div>)}
      </div>}
      {importProgress && <div className="import-progress" role="status" aria-live="polite"><SpinnerGap size={18} /><div><strong>{importProgress.phase === "preparing" ? "Preparing import" : importProgress.phase === "saving" ? "Saving files locally" : "Saving and synchronizing files"}</strong><span>{importProgress.count} {importProgress.count === 1 ? "file" : "files"}. This API does not support safe cancellation or byte-level progress.</span></div></div>}
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
          onEditFile={contextMenuEntry.kind === "file" && fileCapabilities(contextMenuEntry).editable ? () => handleEditFile(contextMenuEntry) : undefined}
          openWith={contextMenuEntry.kind === "file" ? installedApps.filter((app) => installedAppIsAvailable(app, entries) && app.manifest.permissions.includes("files:read") && installedAppAcceptsFile(app, contextMenuEntry)).map((app) => ({
            id: app.appId,
            label: app.manifest.name,
            onOpen: () => {
              const packageEntry = entriesRef.current.find((entry): entry is FileEntry => entry.kind === "file" && entry.id === app.packageEntryId);
              setContextMenu(null);
              if (packageEntry) void openAppPackage(packageEntry, contextMenuEntry);
            },
          })) : undefined}
          onRename={() => { setDialog({ type: "rename", entryId: contextMenuEntry.id }); setContextMenu(null); }}
          onDownload={contextMenuEntry.kind === "file" ? () => void download(contextMenuEntry) : undefined}
          onCopy={() => void copySelection()}
          onCopyLink={contextMenuEntries.length === 1 ? () => void copyDeepLink(contextMenuEntry) : undefined}
          offlineAvailable={contextMenuEntry.kind === "file" ? offlineAvailability[contextMenuEntry.id] ?? null : undefined}
          onMakeAvailableOffline={contextMenuEntry.kind === "file" && syncStatus !== "local" ? () => void changeOfflineAvailability(contextMenuEntry, true) : undefined}
          onRemoveOfflineCopy={contextMenuEntry.kind === "file" && syncStatus !== "local" ? () => void changeOfflineAvailability(contextMenuEntry, false) : undefined}
          onPasteInto={contextMenuEntry.kind === "folder" && clipboardRef.current ? () => void beginPaste(contextMenuEntry.id) : undefined}
          onMove={() => { setMoveDialogSubmitting(false); setMoveDialogEntryIds(contextMenuEntries.map((entry) => entry.id)); setContextMenu(null); }}
          onProperties={() => { openPropertiesWindow(contextMenuEntry.id); setContextMenu(null); }}
          onDelete={() => { setDialog({ type: "delete", entryIds: contextMenuEntries.map((entry) => entry.id) }); setContextMenu(null); }}
          selectionCount={contextMenuEntries.length}
          trashSupported={syncStatus !== "local"}
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
          onSettings={activeDesktop?.capabilities.settings || activeDesktop?.capabilities.activity ? () => {
            openSettingsWindow();
            setContextMenu(null);
          } : undefined}
          onPaste={clipboardRef.current ? () => void beginPaste(contextMenu.parentId, contextMenu.parentId === null ? contextMenu.position : undefined) : undefined}
          readOnly={!canMutate}
        />
      )}
      {dialog && (!(dialog.type === "rename" || dialog.type === "delete") || dialogEntry) && <FileDialog dialog={dialog} entry={dialogEntry} entryCount={dialog.type === "delete" ? dialog.entryIds.length : 1} trashSupported={syncStatus !== "local"} onClose={() => setDialog(null)} onSubmit={handleDialogSubmit} />}
      {appDialogRequests[0] && appDialogRequests[0].kind !== "confirm" && <AppPickerDialog
        request={appDialogRequests[0]}
        entries={entries}
        onCancel={() => appHostServices.dialogs.reject(appDialogRequests[0].id)}
        onOpenFiles={(files) => {
          const request = appDialogRequests[0];
          const running = runningAppsRef.current.find((app): app is SandboxApp => app.kind === "sandbox" && app.id === request.owner.instanceId);
          if (!running) { appHostServices.dialogs.reject(request.id); return; }
          appHostServices.dialogs.respond(request.id, grantPickedFiles(appCapabilities, request.owner.instanceId, running.package.manifest.permissions, files));
        }}
        onOpenFolder={(folder) => {
          const request = appDialogRequests[0];
          const running = runningAppsRef.current.find((app): app is SandboxApp => app.kind === "sandbox" && app.id === request.owner.instanceId);
          if (!running) { appHostServices.dialogs.reject(request.id); return; }
          appHostServices.dialogs.respond(request.id, grantPickedFolder(appCapabilities, request.owner.instanceId, running.package.manifest.permissions, folder));
        }}
        onSave={async (name, folder) => {
          const request = appDialogRequests[0];
          if (request.kind !== "saveFile") return;
          const running = runningAppsRef.current.find((app): app is SandboxApp => app.kind === "sandbox" && app.id === request.owner.instanceId);
          if (!running) { appHostServices.dialogs.reject(request.id); return; }
          if (!running.package.manifest.permissions.includes("files:write")) throw new HostServiceError("The app does not have permission to create files.", "PERMISSION_DENIED");
          const file = await createAppFile(name, folder?.id ?? null, positionFor(folder?.id ?? null), new Blob([], { type: request.params.mimeType ?? "application/octet-stream" }), request.params.mimeType);
          appHostServices.dialogs.respond(request.id, grantPickedFiles(appCapabilities, request.owner.instanceId, running.package.manifest.permissions, [file])[0]);
        }}
      />}
      {moveDialogEntries.length > 0 && (
        <MoveDialog
          desktops={desktops.filter((desktop) => desktop.capabilities.write && (desktop.ownership === "owned" || syncStatus === "online")).map((desktop) => ({ ...desktop, folders: (desktopMoveFolders[desktop.id] ?? []).filter((entry): entry is Extract<DesktopEntry, { kind: "folder" }> => entry.kind === "folder") }))}
          activeDesktopId={activeDesktopId}
          entries={moveDialogEntries}
          invalidIds={invalidMoveIds(moveDialogEntries)}
          loading={moveDestinationsLoading}
          onClose={() => { setMoveDialogSubmitting(false); setMoveDialogEntryIds([]); }}
          onMove={async (desktopId, parentId) => {
            const destination = desktops.find((desktop) => desktop.id === desktopId);
            if (!destination?.capabilities.write || destination.ownership === "shared" && syncStatus !== "online") throw new Error("You cannot write to that destination desktop right now.");
            if (desktopId === activeDesktopId) await handleMoveTo(moveDialogEntries, parentId, true);
            else {
              const next = await transferEntries(desktopId, moveDialogEntries.map((entry) => entry.id), parentId);
              entriesRef.current = next.entries;
              layoutRef.current = next.layout;
              setEntries(next.entries);
              setLayout(next.layout);
              replaceSelection(selectionScope, []);
              setNotice(`${moveDialogEntries.length === 1 ? moveDialogEntries[0].name : `${moveDialogEntries.length} items`} moved to ${desktops.find((desktop) => desktop.id === desktopId)?.name ?? "desktop"}`);
            }
            setMoveDialogSubmitting(false);
            setMoveDialogEntryIds([]);
          }}
          onSubmittingChange={setMoveDialogSubmitting}
        />
      )}
      {pendingPaste && <PasteConflictDialog roots={pendingPaste.snapshot.selectedRootIds.map((id) => pendingPaste.snapshot.entries.find((entry) => entry.id === id)!)} existingNames={entries.filter((entry) => entry.parentId === pendingPaste.parentId).map((entry) => entry.name)} onClose={() => setPendingPaste(null)} onPaste={(names) => commitPaste(pendingPaste.snapshot, pendingPaste.parentId, pendingPaste.position, names)} />}
      {activePanel === "search" && <SearchCommandPalette entries={entries} windows={windowItems.map((window) => ({ id: window.id, title: window.title, detail: window.areaLabel }))} commands={searchCommands} onOpenEntry={handleOpen} onFocusWindow={focusApp} onRunCommand={runSearchCommand} onClose={() => setActivePanel(null)} />}
      {activePanel === "sync" && <PanelDialog title="Sync status" onClose={() => setActivePanel(null)}><SyncIssuesPanel status={syncStatus} records={outboxRecords} lastSyncedAt={lastSyncedAt} affectedLabels={(record) => {
        const operation = record.operation;
        const ids = operation.kind === "delete" ? [operation.entryId]
          : operation.kind === "delete-entries" || operation.kind === "move-entries" || operation.kind === "entry-transfer" ? operation.entryIds
            : operation.kind === "update-entry" || operation.kind === "save-content" ? [operation.entry.id]
              : operation.kind === "create" ? operation.entries.map((entry) => entry.id) : [];
        return ids.map((id) => entriesRef.current.find((entry) => entry.id === id)?.name).filter((name): name is string => Boolean(name));
      }} onRetry={(record) => void retryBlockedOutboxRecord(record.operationId).catch((reason) => setError(reason instanceof Error ? reason.message : "The queued change could not be retried."))} onDiscard={(record) => void requestConfirmation({ title: "Discard queued change?", message: "Discard this blocked local change and restore the server version? This cannot be undone.", confirmLabel: "Discard change", danger: true }).then(async (confirmed) => {
        if (!confirmed) return;
        try { setOutboxRecords(await discardBlockedOutboxRecord(record.operationId)); }
        catch (reason) { setError(reason instanceof Error ? reason.message : "The queued change could not be discarded."); }
      })} /></PanelDialog>}
      {activePanel === "windows" && <PanelDialog title="All windows" onClose={() => setActivePanel(null)}><AllWindowsPanel windows={windowItems} activeAreaId={activeSegmentKey} focusedWindowId={focusedAppId ?? undefined} onFocusWindow={(id) => { focusApp(id); setActivePanel(null); }} onNavigateArea={(id) => { const [row, column] = id.split(":").map(Number); if (Number.isSafeInteger(row) && Number.isSafeInteger(column)) goToSegment({ row, column }); }} /></PanelDialog>}
      {activePanel === "shortcuts" && <PanelDialog title="Keyboard shortcuts" onClose={() => setActivePanel(null)}><KeyboardShortcutsPanel shortcuts={keyboardShortcuts} /></PanelDialog>}
      {activePanel === "trash" && canMutate && <PanelDialog title="Trash" onClose={() => setActivePanel(null)}><TrashWindow onListTrash={() => listTrash(activeDesktopId)} onRestore={async (item, destination) => { await restoreTrash(activeDesktopId, item.entry.id, destination); setNotice(`${item.entry.name} restored`); }} onPermanentlyDelete={async (item) => { await permanentlyDeleteTrash(activeDesktopId, item.entry.id); setNotice(`${item.entry.name} permanently deleted`); }} onRequestPermanentDelete={(item: TrashItem, confirmedDelete) => { void requestConfirmation({ title: `Delete ${item.entry.name} permanently?`, message: "This item and everything inside it will be permanently deleted. This cannot be undone.", confirmLabel: "Delete permanently", danger: true }).then((confirmed) => { if (confirmed) void confirmedDelete().catch(() => undefined); }); }} /></PanelDialog>}
      {sharingOpen && activeDesktop?.capabilities.manage && <SharingDialog desktop={activeDesktop} onClose={() => setSharingOpen(false)} />}
      {confirmation && <ConfirmationDialog {...confirmation} onClose={resolveConfirmation} />}
    </main>
  );
}

export default App;

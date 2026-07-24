import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowClockwise, ArrowLeft, ArrowsOut, BookOpenText, CaretRight, ClockCounterClockwise, CloudCheck, CornersIn, CornersOut, DownloadSimple, ExportIcon, GlobeSimple, GridFour, ImageSquare, Info, MagnifyingGlass, PaintBrush, Package, Play, Trash, UploadSimple } from "@phosphor-icons/react";
import { ActivityLog } from "./ActivityLog";
import type { ActivityPage, ActivityQuery } from "../lib/activity";
import type { ActivityRecord } from "../lib/activity";
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEMES,
  isBuiltinThemeId,
  type CustomTheme,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeState,
  themeContrastIssues,
  themeStyle,
} from "../lib/themes";
import { DEFAULT_WALLPAPER, WALLPAPERS, type DesktopEntry, type DesktopLayout, type FileEntry, type WallpaperPreset } from "../types";
import { WALLPAPER_IMAGE_ACCEPT } from "../lib/wallpaper-image";
import type { AppWindowHeaderElements } from "./AppWindow";
import { installedAppIsAvailable, type InstalledApp } from "../apps/installed-apps";
import type { PwaInstallState } from "../lib/pwa-install";
import { RoleBadge, StatusBadge } from "./VisualPrimitives";

const WALLPAPER_LABELS: Record<WallpaperPreset, { name: string; description: string }> = {
  dusk: { name: "Dusk", description: "Misty green with a warm horizon" },
  grove: { name: "Grove", description: "Deep forest layers in cool green" },
  ember: { name: "Ember", description: "Smoky earth with an amber glow" },
};

const COLOR_LABELS: Record<keyof ThemeColors, string> = {
  shell: "Shell",
  chrome: "Chrome",
  chromeText: "Chrome text",
  window: "Window",
  windowMuted: "Muted window",
  text: "Text",
  textMuted: "Muted text",
  accent: "Accent",
  accentText: "Accent text",
  border: "Border",
  danger: "Danger",
  dangerSurface: "Danger surface",
  desktopText: "Desktop text",
  selection: "Selection",
  editorBackground: "Editor background",
  editorText: "Editor text",
  editorGutter: "Editor gutter",
  editorKeyword: "Editor keyword",
  editorString: "Editor string",
  editorComment: "Editor comment",
};

const SETTINGS_CATEGORIES = [
  { id: "desktop", label: "Desktop", scope: "Shared with this desktop" },
  { id: "files", label: "Files & content", scope: "This desktop and this browser" },
  { id: "connection", label: "Connection & Offline", scope: "This desktop and browser storage" },
  { id: "apps", label: "Apps & permissions", scope: "This device" },
  { id: "device", label: "Device", scope: "This browser or installed app" },
  { id: "data", label: "Data & admin", scope: "This desktop and server operations" },
  { id: "help", label: "Help", scope: "Bundled on this device" },
] as const;
type SettingsCategory = typeof SETTINGS_CATEGORIES[number]["id"];

type Props = {
  page: "main" | "themes" | "activity" | "apps";
  onPageChange: (page: "main" | "themes" | "activity" | "apps") => void;
  mobileHeaderElements?: AppWindowHeaderElements;
  layout: DesktopLayout;
  activeDesktopId: string;
  entries: DesktopEntry[];
  wallpaperUrl: string | null;
  appearance: ThemeState;
  canMutate: boolean;
  canViewActivity: boolean;
  restrictionReason: string;
  exportDisabled: boolean;
  exporting: boolean;
  fullscreenEnabled: boolean;
  isFullscreen: boolean;
  updateSupported: boolean;
  updateReady: boolean;
  updateChecking: boolean;
  autoUpdate: boolean;
  externalEmbeddedPreviews: boolean;
  localPreferencesLoaded: boolean;
  searchAllDesktops: boolean;
  desktopSearchAvailable: boolean;
  installState: PwaInstallState;
  serverBuildTimestamp: string | null;
  installedApps: InstalledApp[];
  onLaunchApp: (app: InstalledApp) => void;
  onUninstallApp: (app: InstalledApp) => void;
  onListActivity: (query?: ActivityQuery) => Promise<ActivityPage>;
  onSubscribeToActivity: (listener: () => void) => () => void;
  onOpenAffectedEntries?: (activity: ActivityRecord, entryIds: readonly string[]) => void;
  canOpenAffectedEntries?: (activity: ActivityRecord, entryIds: readonly string[]) => boolean;
  onConfirmThemeDelete: (theme: CustomTheme) => Promise<boolean>;
  onLayoutPreview: (layout: DesktopLayout, desktopId: string) => void;
  onLayoutChange: (layout: DesktopLayout, desktopId: string) => Promise<void>;
  onWallpaperUpload: (file: File, layout: DesktopLayout, desktopId: string) => Promise<void>;
  onWallpaperSelect: (fileId: string, layout: DesktopLayout, desktopId: string) => Promise<void>;
  onThemeSelect: (themeId: string) => void | Promise<void>;
  onThemeSave: (theme: CustomTheme) => void | Promise<void>;
  onThemeDelete: (themeId: string) => void | Promise<void>;
  onExport: () => void;
  onToggleFullscreen: () => void;
  onCheckForUpdate: () => void;
  onAutoUpdateChange: (enabled: boolean) => void;
  onExternalEmbeddedPreviewsChange: (enabled: boolean) => void;
  onSearchAllDesktopsChange: (enabled: boolean) => void;
  onOpenGettingStarted: () => void;
  onInstall: () => void;
  onOpenOfflineStorage: () => void;
  onOpenHelp: (section?: "start-here" | "installation-and-updates" | "apps-and-permissions" | "export-backup-and-recovery") => void;
};

type NumberControlProps = {
  idPrefix?: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
  onCommit?: () => void;
};

function NumberControl({ idPrefix = "theme", label, value, min, max, step, disabled, onChange, onCommit }: NumberControlProps) {
  const id = `${idPrefix}-${label.toLowerCase().replaceAll(" ", "-")}`;
  const changeValue = (next: number) => {
    if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
  };
  return (
    <div className="theme-control">
      <label htmlFor={id}>{label} <output>{value}</output></label>
      <div className="theme-control__inputs">
        <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => changeValue(event.target.valueAsNumber)} onPointerUp={onCommit} onKeyUp={onCommit} onBlur={onCommit} />
        <input aria-label={`${label} value`} type="number" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => changeValue(event.target.valueAsNumber)} onBlur={onCommit} />
      </div>
    </div>
  );
}

function copyDefinition(definition: ThemeDefinition): ThemeDefinition {
  return {
    ...definition,
    colors: { ...definition.colors },
    shape: { ...definition.shape },
    effects: { ...definition.effects },
    typography: { ...definition.typography },
  };
}

function copyName(name: string) {
  const suffix = name.endsWith(" Copy") ? " 2" : " Copy";
  return `${name.slice(0, 60 - suffix.length)}${suffix}`;
}

export function SettingsWindow({
  page,
  onPageChange,
  mobileHeaderElements,
  layout,
  activeDesktopId,
  entries,
  wallpaperUrl,
  appearance,
  canMutate,
  canViewActivity,
  restrictionReason,
  exportDisabled,
  exporting,
  fullscreenEnabled,
  isFullscreen,
  updateSupported,
  updateReady,
  updateChecking,
  autoUpdate,
  externalEmbeddedPreviews,
  localPreferencesLoaded,
  searchAllDesktops,
  desktopSearchAvailable,
  installState,
  serverBuildTimestamp,
  installedApps,
  onLaunchApp,
  onUninstallApp,
  onListActivity,
  onSubscribeToActivity,
  onOpenAffectedEntries,
  canOpenAffectedEntries,
  onConfirmThemeDelete,
  onLayoutPreview,
  onLayoutChange,
  onWallpaperUpload,
  onWallpaperSelect,
  onThemeSelect,
  onThemeSave,
  onThemeDelete,
  onExport,
  onToggleFullscreen,
  onCheckForUpdate,
  onAutoUpdateChange,
  onExternalEmbeddedPreviewsChange,
  onSearchAllDesktopsChange,
  onOpenGettingStarted,
  onInstall,
  onOpenOfflineStorage,
  onOpenHelp,
}: Props) {
  const [draft, setDraft] = useState<CustomTheme | null>(null);
  const [saving, setSaving] = useState(false);
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("desktop");
  const [layoutDraft, setLayoutDraft] = useState(() => ({ desktopId: activeDesktopId, layout }));
  const contentRef = useRef<HTMLDivElement>(null);
  const wallpaperUploadRef = useRef<HTMLInputElement>(null);
  const wallpaperCommitTimerRef = useRef<number | null>(null);
  const draftSafeColorsRef = useRef<ThemeColors | null>(null);
  const pendingLayoutRef = useRef<{ desktopId: string; layout: DesktopLayout } | null>(null);
  const mainThemesButtonRef = useRef<HTMLButtonElement>(null);
  const mainActivityButtonRef = useRef<HTMLButtonElement>(null);
  const mainAppsButtonRef = useRef<HTMLButtonElement>(null);
  const themesHeadingRef = useRef<HTMLHeadingElement>(null);
  const activityHeadingRef = useRef<HTMLHeadingElement>(null);
  const appsHeadingRef = useRef<HTMLHeadingElement>(null);
  const mutationsDisabled = !canMutate || saving;
  const displayedLayout = layoutDraft.desktopId === activeDesktopId ? layoutDraft.layout : layout;
  const contrastIssues = draft ? themeContrastIssues(draft.definition) : [];
  const selectedThemeName = isBuiltinThemeId(appearance.selectedThemeId)
    ? BUILTIN_THEMES[appearance.selectedThemeId].name
    : appearance.customThemes.find((theme) => theme.id === appearance.selectedThemeId)?.name ?? "Custom theme";
  const wallpaperFileId = displayedLayout.wallpaper.source.startsWith("file:") ? displayedLayout.wallpaper.source.slice(5) : null;
  const wallpaperFile = wallpaperFileId ? entries.find((entry): entry is FileEntry => entry.id === wallpaperFileId && entry.kind === "file") : null;
  const wallpaperFiles = entries.filter((entry): entry is FileEntry => entry.kind === "file" && ["image/jpeg", "image/png", "image/webp"].includes(entry.mimeType.split(";", 1)[0].trim().toLowerCase()) && entry.size <= 20 * 1024 * 1024);
  const wallpaperName = displayedLayout.wallpaper.source in WALLPAPER_LABELS ? WALLPAPER_LABELS[displayedLayout.wallpaper.source as WallpaperPreset].name : wallpaperFile?.name ?? "Custom image";
  const activeSettingsCategory = SETTINGS_CATEGORIES.find((category) => category.id === settingsCategory)!;
  const formatBuildTimestamp = (timestamp: string | null) => {
    if (!timestamp) return "Unavailable";
    const date = new Date(timestamp);
    if (Number.isNaN(date.valueOf())) return "Unavailable";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(date);
  };

  useEffect(() => {
    if (pendingLayoutRef.current?.desktopId === activeDesktopId) return;
    if (wallpaperCommitTimerRef.current !== null) window.clearTimeout(wallpaperCommitTimerRef.current);
    wallpaperCommitTimerRef.current = null;
    pendingLayoutRef.current = null;
    setLayoutDraft({ desktopId: activeDesktopId, layout });
  }, [activeDesktopId, layout]);

  useEffect(() => () => {
    if (wallpaperCommitTimerRef.current !== null) window.clearTimeout(wallpaperCommitTimerRef.current);
  }, []);

  const commitWallpaperDraft = async () => {
    if (wallpaperCommitTimerRef.current !== null) window.clearTimeout(wallpaperCommitTimerRef.current);
    wallpaperCommitTimerRef.current = null;
    const pending = pendingLayoutRef.current;
    pendingLayoutRef.current = null;
    if (pending) await onLayoutChange(pending.layout, pending.desktopId);
  };

  const previewWallpaper = (wallpaper: DesktopLayout["wallpaper"]) => {
    const next = { ...displayedLayout, wallpaper };
    const pending = { desktopId: activeDesktopId, layout: next };
    pendingLayoutRef.current = pending;
    setLayoutDraft(pending);
    onLayoutPreview(next, activeDesktopId);
    if (wallpaperCommitTimerRef.current !== null) window.clearTimeout(wallpaperCommitTimerRef.current);
    wallpaperCommitTimerRef.current = window.setTimeout(() => { void commitWallpaperDraft(); }, 400);
  };

  const commitWallpaperChange = async (wallpaper: DesktopLayout["wallpaper"]) => {
    if (wallpaperCommitTimerRef.current !== null) window.clearTimeout(wallpaperCommitTimerRef.current);
    wallpaperCommitTimerRef.current = null;
    pendingLayoutRef.current = null;
    const next = { ...displayedLayout, wallpaper };
    setLayoutDraft({ desktopId: activeDesktopId, layout: next });
    onLayoutPreview(next, activeDesktopId);
    await onLayoutChange(next, activeDesktopId);
  };

  const startDraft = (name: string, definition: ThemeDefinition, id: string = crypto.randomUUID()) => {
    const next = { id, name, definition: copyDefinition(definition) };
    draftSafeColorsRef.current = { ...definition.colors };
    setDraft(next);
  };

  const updateDraft = (update: (current: CustomTheme) => CustomTheme) => {
    setDraft((current) => {
      if (!current) return current;
      return update(current);
    });
  };

  const selectTheme = async (themeId: string) => {
    if (mutationsDisabled) return;
    setSaving(true);
    try {
      await onThemeSelect(themeId);
      setDraft(null);
    } catch {
      // The app-level error banner reports synchronization failures.
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!draft || mutationsDisabled || !draft.name.trim() || contrastIssues.length) return;
    const saved = { ...draft, name: draft.name.trim() };
    setSaving(true);
    try {
      await onThemeSave(saved);
      setDraft(null);
    } catch {
      // Keep the draft and preview available for retry.
    } finally {
      setSaving(false);
    }
  };

  const deleteTheme = async (theme: CustomTheme) => {
    if (mutationsDisabled || !await onConfirmThemeDelete(theme)) return;
    setSaving(true);
    try {
      await onThemeDelete(theme.id);
      if (draft?.id === theme.id) {
        setDraft(null);
      }
    } catch {
      // Keep the draft available if deletion fails.
    } finally {
      setSaving(false);
    }
  };

  const cancelDraft = () => {
    setDraft(null);
  };

  const openThemes = () => {
    contentRef.current?.scrollTo({ top: 0 });
    onPageChange("themes");
    if (!mobileHeaderElements) requestAnimationFrame(() => themesHeadingRef.current?.focus());
  };

  const closeThemes = () => {
    void commitWallpaperDraft();
    cancelDraft();
    contentRef.current?.scrollTo({ top: 0 });
    onPageChange("main");
    requestAnimationFrame(() => mainThemesButtonRef.current?.focus());
  };

  const openActivity = () => {
    contentRef.current?.scrollTo({ top: 0 });
    onPageChange("activity");
    if (!mobileHeaderElements) requestAnimationFrame(() => activityHeadingRef.current?.focus());
  };

  const closeActivity = () => {
    contentRef.current?.scrollTo({ top: 0 });
    onPageChange("main");
    requestAnimationFrame(() => mainActivityButtonRef.current?.focus());
  };
  const openApps = () => { contentRef.current?.scrollTo({ top: 0 }); onPageChange("apps"); if (!mobileHeaderElements) requestAnimationFrame(() => appsHeadingRef.current?.focus()); };
  const closeApps = () => { contentRef.current?.scrollTo({ top: 0 }); onPageChange("main"); requestAnimationFrame(() => mainAppsButtonRef.current?.focus()); };

  return (
    <div className="settings-window settings-window--embedded">
      {page !== "main" && mobileHeaderElements?.leading && createPortal(
        <button className="app-window__control mobile-header-back" type="button" aria-label="Back to settings" disabled={page === "themes" && saving} onClick={page === "themes" ? closeThemes : page === "apps" ? closeApps : closeActivity}>
          <ArrowLeft size={18} />
        </button>,
        mobileHeaderElements.leading,
      )}
      <div className="settings-window__content" ref={contentRef}>
         {page === "main" ? (
           <>
             <header className="settings-ia-header"><div><h2>Settings</h2><span className="status-badge">This desktop + this device</span></div><p>Shared desktop choices and browser-local preferences are labeled at the point of use.</p>{!canMutate && <p className="settings-window__offline" role="status">Restricted: {restrictionReason}</p>}</header>
              <nav className="settings-ia-categories" aria-label="Settings categories">{SETTINGS_CATEGORIES.map((category) => <button type="button" aria-pressed={category.id === settingsCategory} key={category.id} onClick={() => { setSettingsCategory(category.id); contentRef.current?.scrollTo({ top: 0 }); }}>{category.label}</button>)}</nav>
              <div className="settings-scope-summary" role="status"><strong>{activeSettingsCategory.label}</strong><span>Scope: {activeSettingsCategory.scope}</span></div>
              <section className="settings-section" aria-labelledby="themes-link-heading" hidden={settingsCategory !== "desktop"}>
              <button className="settings-row settings-row--navigation" type="button" ref={mainThemesButtonRef} onClick={openThemes}>
                <span className="settings-row__icon"><PaintBrush size={17} /></span>
                <span className="settings-row__copy">
                  <strong id="themes-link-heading">Themes</strong>
                  <small>{selectedThemeName} theme with {wallpaperName.toLowerCase()} wallpaper.</small>
                </span>
                <CaretRight className="settings-row__chevron" size={17} aria-hidden="true" />
              </button>
            </section>

            {canViewActivity && <section className="settings-section" aria-labelledby="activity-link-heading" hidden={settingsCategory !== "data"}>
              <button className="settings-row settings-row--navigation" type="button" ref={mainActivityButtonRef} onClick={openActivity}>
                <span className="settings-row__icon"><ClockCounterClockwise size={17} /></span>
                <span className="settings-row__copy">
                  <strong id="activity-link-heading">Activity</strong>
                  <small>Review and search accepted desktop changes.</small>
                </span>
                <CaretRight className="settings-row__chevron" size={17} aria-hidden="true" />
              </button>
            </section>}

            <section className="settings-section" aria-labelledby="apps-link-heading" hidden={settingsCategory !== "apps"}>
              <button className="settings-row settings-row--navigation" type="button" ref={mainAppsButtonRef} onClick={openApps}>
                <span className="settings-row__icon"><Package size={17} /></span><span className="settings-row__copy"><strong id="apps-link-heading">Apps</strong><small>{installedApps.length ? `${installedApps.length} approved ${installedApps.length === 1 ? "app" : "apps"} on this device.` : "Manage approved app packages."}</small></span><CaretRight className="settings-row__chevron" size={17} aria-hidden="true" />
              </button>
            </section>

            <section className="settings-section" aria-labelledby="offline-storage-link-heading" hidden={settingsCategory !== "connection"}>
              <button className="settings-row settings-row--navigation" type="button" onClick={onOpenOfflineStorage}>
                <span className="settings-row__icon"><CloudCheck size={17} /></span><span className="settings-row__copy"><strong id="offline-storage-link-heading">Connection &amp; Offline</strong><small>Review sync, pending work, pins, downloaded bytes, and browser storage.</small></span><CaretRight className="settings-row__chevron" size={17} aria-hidden="true" />
              </button>
            </section>

            <section className="settings-section" aria-labelledby="desktop-heading" hidden={settingsCategory !== "desktop"}>
              <div className="settings-section__heading">
                <ArrowsOut size={18} />
                <div><h3 id="desktop-heading">Desktop</h3><p>Adjust icon placement and the viewing area.</p></div>
              </div>
              <div className="settings-list">
                <label className="settings-row">
                  <span className="settings-row__icon"><GridFour size={17} weight={layout.snapToGrid ? "fill" : "regular"} /></span>
                  <span className="settings-row__copy"><strong>Snap to grid</strong><small>Align icons when they are moved.</small></span>
                  <input type="checkbox" checked={layout.snapToGrid} disabled={!canMutate} onChange={(event) => void onLayoutChange({ ...layout, snapToGrid: event.target.checked }, activeDesktopId)} />
                </label>
                {fullscreenEnabled && (
                  <div className="settings-row">
                    <span className="settings-row__icon">{isFullscreen ? <CornersIn size={17} /> : <CornersOut size={17} />}</span>
                    <span className="settings-row__copy"><strong>{isFullscreen ? "Exit fullscreen" : "Fullscreen"}</strong><small>Use all available screen space.</small></span>
                    <button className="button button--quiet" type="button" onClick={onToggleFullscreen}>{isFullscreen ? "Exit" : "Enter"}</button>
                  </div>
                )}
              </div>
            </section>

            <section className="settings-section" aria-labelledby="external-content-heading" hidden={settingsCategory !== "files"}>
              <div className="settings-section__heading">
                <GlobeSimple size={18} />
                <div><h3 id="external-content-heading">External content</h3><p>Control network content shown inside text files.</p></div>
              </div>
              <div className="settings-list">
                <label className="settings-row">
                  <span className="settings-row__icon"><GlobeSimple size={17} weight={externalEmbeddedPreviews ? "fill" : "regular"} /></span>
                  <span className="settings-row__copy"><strong>External embedded previews</strong><small>Opening a document may contact third-party sites. This setting applies only to this browser.</small></span>
                  <input type="checkbox" checked={externalEmbeddedPreviews} disabled={!localPreferencesLoaded} onChange={(event) => onExternalEmbeddedPreviewsChange(event.target.checked)} />
                </label>
              </div>
            </section>

            <section className="settings-section" aria-labelledby="search-heading" hidden={settingsCategory !== "files"}>
              <div className="settings-section__heading"><MagnifyingGlass size={18} /><div><h3 id="search-heading">Search</h3><p>Choose how broadly file search runs.</p></div></div>
              <div className="settings-list"><label className="settings-row"><span className="settings-row__icon"><MagnifyingGlass size={17} /></span><span className="settings-row__copy"><strong>All accessible desktops</strong><small>{desktopSearchAvailable ? "Use authoritative server results online and cached browser results offline." : "This server does not advertise accessible-desktop search."}</small></span><input type="checkbox" checked={searchAllDesktops} disabled={!desktopSearchAvailable || !localPreferencesLoaded} onChange={(event) => onSearchAllDesktopsChange(event.target.checked)} /></label></div>
            </section>

            <section className="settings-section" aria-labelledby="getting-started-heading" hidden={settingsCategory !== "help"}>
              <div className="settings-section__heading"><Info size={18} /><div><h3 id="getting-started-heading">Help</h3><p>Bundled guidance for using and troubleshooting Hiraya.</p></div></div>
              <div className="settings-list">
                <div className="settings-row"><span className="settings-row__icon"><BookOpenText size={17} /></span><span className="settings-row__copy"><strong>User Guide</strong><small>Read about files, desktops, areas, sharing, offline use, apps, backup, and troubleshooting.</small></span><button className="button button--quiet" type="button" onClick={() => onOpenHelp("start-here")}>Open</button></div>
                <div className="settings-row"><span className="settings-row__icon"><Info size={17} /></span><span className="settings-row__copy"><strong>Getting Started</strong><small>Review storage, offline use, export, backup, and desktop areas.</small></span><button className="button button--quiet" type="button" onClick={onOpenGettingStarted}>Open</button></div>
              </div>
              <button className="inline-help-link" type="button" onClick={() => onOpenHelp("installation-and-updates")}>Installation requirements and alternatives</button>
            </section>

            <section className="settings-section" aria-labelledby="updates-heading" hidden={settingsCategory !== "device"}>
              <div className="settings-section__heading">
                <ArrowClockwise size={18} />
                <div><h3 id="updates-heading">Updates</h3><p>Keep this installed app current.</p></div>
              </div>
              <div className="settings-list">
                <div className="settings-row"><span className="settings-row__icon"><DownloadSimple size={17} /></span><span className="settings-row__copy"><strong>Install Hiraya</strong><small>{installState === "standalone" ? "Running as an installed app." : installState === "installed" ? "Installed on this device." : installState === "promptable" ? "Ready to install from Hiraya." : "Use your browser's Install app or Add to Home Screen menu."}</small></span>{installState === "promptable" && <button className="button button--quiet" type="button" onClick={onInstall}>Install</button>}</div>
                <div className="settings-row">
                  <span className="settings-row__icon"><ArrowClockwise size={17} weight={updateReady ? "bold" : "regular"} /></span>
                  <span className="settings-row__copy"><strong>Update to latest version</strong><small>{!updateSupported ? "Available in production PWA builds." : updateReady ? "A new version is ready to install." : "Check for a newer app release."}</small></span>
                  <button className="button button--quiet" type="button" disabled={!updateSupported || updateChecking} onClick={onCheckForUpdate}>{updateChecking ? "Checking" : updateReady ? "Review" : "Check now"}</button>
                </div>
                <label className="settings-row">
                  <span className="settings-row__icon"><ArrowClockwise size={17} /></span>
                  <span className="settings-row__copy"><strong>Automatic updates</strong><small>Check automatically, then ask before reloading.</small></span>
                  <input type="checkbox" checked={autoUpdate} disabled={!updateSupported} onChange={(event) => onAutoUpdateChange(event.target.checked)} />
                </label>
                <div className="settings-row">
                  <span className="settings-row__icon"><ClockCounterClockwise size={17} /></span>
                  <span className="settings-row__copy"><strong>App build</strong><small><time dateTime={import.meta.env.HIRAYA_BUILD_TIMESTAMP}>{formatBuildTimestamp(import.meta.env.HIRAYA_BUILD_TIMESTAMP)}</time></small></span>
                </div>
                <div className="settings-row">
                  <span className="settings-row__icon"><ClockCounterClockwise size={17} /></span>
                  <span className="settings-row__copy"><strong>Server build</strong><small>{serverBuildTimestamp ? <time dateTime={serverBuildTimestamp}>{formatBuildTimestamp(serverBuildTimestamp)}</time> : "Unavailable"}</small></span>
                </div>
              </div>
              <button className="inline-help-link" type="button" onClick={() => onOpenHelp("installation-and-updates")}>How Hiraya updates work</button>
            </section>

            <section className="settings-section" aria-labelledby="export-heading" hidden={settingsCategory !== "data"}>
              <div className="settings-section__heading">
                <ExportIcon size={18} />
                <div><h3 id="export-heading">Export</h3><p>Create a seeded ZIP for a fresh frontend-only deployment.</p></div>
              </div>
              <div className="settings-export">
                <span>No in-product restore. Unsaved editor changes are not included.</span>
                <button className="button button--quiet" type="button" disabled={exportDisabled || exporting} onClick={onExport}><ExportIcon size={16} /> {exporting ? "Exporting..." : "Export deployment seed"}</button>
              </div>
              <button className="inline-help-link" type="button" onClick={() => onOpenHelp("export-backup-and-recovery")}>Export versus server backup and recovery</button>
            </section>

          </>
        ) : page === "themes" ? (
          <div className="settings-page">
            <header className="settings-page__header">
              <button className="settings-page__back" type="button" aria-label="Back to settings" disabled={saving} onClick={closeThemes}><ArrowLeft size={17} /></button>
              <div>
                <h3 ref={themesHeadingRef} tabIndex={-1}>Themes</h3>
                <p>Change the desktop theme and wallpaper.</p>
              </div>
            </header>

        <section className="settings-section" aria-labelledby="appearance-heading">
          <div className="settings-section__heading">
            <PaintBrush size={18} />
            <div>
              <h3 id="appearance-heading">Appearance</h3>
              <p>Choose a shared theme or make one for this desktop.</p>
            </div>
          </div>

          <div className="theme-list" aria-label="Built-in themes">
            {BUILTIN_THEME_IDS.map((themeId) => {
              const theme = BUILTIN_THEMES[themeId];
              const selected = appearance.selectedThemeId === themeId;
              return (
                <div className="theme-item" data-selected={selected || undefined} key={themeId}>
                  <button className="theme-item__select" type="button" aria-pressed={selected} disabled={mutationsDisabled} onClick={() => void selectTheme(themeId)}>
                    <span className="theme-swatch" style={{ background: `linear-gradient(135deg, ${theme.definition.colors.chrome} 0 50%, ${theme.definition.colors.accent} 50%)` }} aria-hidden="true" />
                    <span className="theme-item__copy"><strong>{theme.name}</strong><small>{theme.description}</small></span>
                  </button>
                  <button className="button button--quiet theme-item__action" type="button" disabled={mutationsDisabled} onClick={() => startDraft(copyName(theme.name), theme.definition)}>Duplicate / edit</button>
                </div>
              );
            })}
          </div>

          <div className="theme-custom">
            <h4>Shared custom themes</h4>
            {appearance.customThemes.length === 0 ? (
              <p className="theme-custom__empty">No custom themes yet. Duplicate a preset to begin.</p>
            ) : (
              <div className="theme-list" aria-label="Custom themes">
                {appearance.customThemes.map((theme) => {
                  const selected = appearance.selectedThemeId === theme.id;
                  return (
                    <div className="theme-item" data-selected={selected || undefined} key={theme.id}>
                      <button className="theme-item__select" type="button" aria-pressed={selected} disabled={mutationsDisabled} onClick={() => void selectTheme(theme.id)}>
                        <span className="theme-swatch" style={{ background: `linear-gradient(135deg, ${theme.definition.colors.chrome} 0 50%, ${theme.definition.colors.accent} 50%)` }} aria-hidden="true" />
                        <span className="theme-item__copy"><strong>{theme.name}</strong><small>{selected ? "Selected" : "Custom theme"}</small></span>
                      </button>
                      <div className="theme-item__actions">
                        <button className="button button--quiet" type="button" disabled={mutationsDisabled} onClick={() => startDraft(theme.name, theme.definition, theme.id)}>Edit</button>
                        <button className="button button--quiet" type="button" disabled={mutationsDisabled} onClick={() => startDraft(copyName(theme.name), theme.definition)}>Duplicate</button>
                        <button className="button button--quiet" type="button" disabled={mutationsDisabled} onClick={() => void deleteTheme(theme)}>Delete</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {draft && (
            <form className="theme-editor" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
              <div className="theme-editor__heading">
                <h4>Theme editor</h4>
                <span className="theme-swatch" style={{ background: `linear-gradient(135deg, ${draft.definition.colors.chrome} 0 50%, ${draft.definition.colors.accent} 50%)` }} aria-hidden="true" />
              </div>
              <section className="theme-preview-canvas desktop-shell" style={themeStyle(draft.definition)} role="region" aria-label="Isolated custom theme component preview">
                <div className="theme-preview-canvas__illustration" inert>
                  <div className="theme-preview-canvas__chrome"><span>Hiraya</span><StatusBadge tone="success" surface="chrome">Synced</StatusBadge></div>
                  <div className="theme-preview-canvas__window">
                    <strong>Preview window</strong><small>Muted metadata remains readable.</small>
                    <div><button className="button button--primary" type="button" tabIndex={-1}>Primary</button><button className="button button--quiet" type="button" tabIndex={-1}>Secondary</button><RoleBadge>Reader</RoleBadge></div>
                  </div>
                </div>
              </section>
              <label className="theme-field">Name<input type="text" value={draft.name} maxLength={60} required disabled={mutationsDisabled} onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))} /></label>

              <fieldset className="theme-group">
                <legend>Colors</legend>
                <div className="theme-colors">
                  {(Object.keys(draft.definition.colors) as Array<keyof ThemeColors>).map((key) => (
                    <label className="theme-color" key={key}>
                      <span>{COLOR_LABELS[key]}</span>
                      <input type="color" value={draft.definition.colors[key]} disabled={mutationsDisabled} onChange={(event) => updateDraft((current) => ({ ...current, definition: { ...current.definition, colors: { ...current.definition.colors, [key]: event.target.value } } }))} />
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="theme-group">
                <legend>Shape &amp; effects</legend>
                <NumberControl label="Radius" value={draft.definition.shape.radius} min={0} max={24} step={1} disabled={mutationsDisabled} onChange={(radius) => updateDraft((current) => ({ ...current, definition: { ...current.definition, shape: { ...current.definition.shape, radius } } }))} />
                <NumberControl label="Border width" value={draft.definition.shape.borderWidth} min={0} max={2} step={0.25} disabled={mutationsDisabled} onChange={(borderWidth) => updateDraft((current) => ({ ...current, definition: { ...current.definition, shape: { ...current.definition.shape, borderWidth } } }))} />
                <NumberControl label="Blur" value={draft.definition.effects.blur} min={0} max={30} step={1} disabled={mutationsDisabled} onChange={(blur) => updateDraft((current) => ({ ...current, definition: { ...current.definition, effects: { ...current.definition.effects, blur } } }))} />
                <NumberControl label="Opacity" value={draft.definition.effects.opacity} min={0.65} max={1} step={0.01} disabled={mutationsDisabled} onChange={(opacity) => updateDraft((current) => ({ ...current, definition: { ...current.definition, effects: { ...current.definition.effects, opacity } } }))} />
                <NumberControl label="Shadow" value={draft.definition.effects.shadow} min={0} max={1} step={0.05} disabled={mutationsDisabled} onChange={(shadow) => updateDraft((current) => ({ ...current, definition: { ...current.definition, effects: { ...current.definition.effects, shadow } } }))} />
                <NumberControl label="Motion" value={draft.definition.motion} min={0} max={1.5} step={0.05} disabled={mutationsDisabled} onChange={(motion) => updateDraft((current) => ({ ...current, definition: { ...current.definition, motion } }))} />
              </fieldset>

              <fieldset className="theme-group">
                <legend>Typography &amp; scale</legend>
                <label className="theme-field">Font family
                  <select value={draft.definition.typography.family} disabled={mutationsDisabled} onChange={(event) => updateDraft((current) => ({ ...current, definition: { ...current.definition, typography: { ...current.definition.typography, family: event.target.value as ThemeDefinition["typography"]["family"] } } }))}>
                    <option value="humanist">Humanist</option><option value="system">System</option><option value="mono">Monospace</option>
                  </select>
                </label>
                <NumberControl label="Type scale" value={draft.definition.typography.scale} min={0.85} max={1.2} step={0.01} disabled={mutationsDisabled} onChange={(scale) => updateDraft((current) => ({ ...current, definition: { ...current.definition, typography: { ...current.definition.typography, scale } } }))} />
                <NumberControl label="Weight" value={draft.definition.typography.weight} min={400} max={700} step={50} disabled={mutationsDisabled} onChange={(weight) => updateDraft((current) => ({ ...current, definition: { ...current.definition, typography: { ...current.definition.typography, weight } } }))} />
                <NumberControl label="Density" value={draft.definition.density} min={0.8} max={1.2} step={0.01} disabled={mutationsDisabled} onChange={(density) => updateDraft((current) => ({ ...current, definition: { ...current.definition, density } }))} />
                <NumberControl label="Icon size" value={draft.definition.iconSize} min={48} max={72} step={1} disabled={mutationsDisabled} onChange={(iconSize) => updateDraft((current) => ({ ...current, definition: { ...current.definition, iconSize } }))} />
              </fieldset>

              {contrastIssues.length > 0 && <div className="theme-editor__warning" role="alert"><span>Increase contrast for {contrastIssues.join(", ")} before saving.</span><button className="button button--quiet" type="button" onClick={() => {
                const safeColors = draftSafeColorsRef.current;
                if (safeColors) updateDraft((current) => ({ ...current, definition: { ...current.definition, colors: { ...safeColors } } }));
              }}>Reset unsafe colors</button></div>}

              <div className="theme-editor__actions">
                <button className="button button--quiet" type="button" disabled={saving} onClick={cancelDraft}>Cancel</button>
                <button className="button" type="submit" disabled={mutationsDisabled || !draft.name.trim() || contrastIssues.length > 0}>{saving ? "Saving" : "Save theme"}</button>
              </div>
            </form>
          )}
        </section>

        <section className="settings-section" aria-labelledby="wallpaper-heading">
          <div className="settings-section__heading">
            <PaintBrush size={18} />
            <div>
              <h3 id="wallpaper-heading">Wallpaper</h3>
              <p>Choose the wallpaper shared by this desktop.</p>
            </div>
          </div>
          <div className="wallpaper-options">
            {WALLPAPERS.map((wallpaper) => (
              <button className="wallpaper-option" data-selected={displayedLayout.wallpaper.source === wallpaper || undefined} type="button" key={wallpaper} aria-pressed={displayedLayout.wallpaper.source === wallpaper} disabled={!canMutate || wallpaperBusy} onClick={() => void commitWallpaperChange({ ...displayedLayout.wallpaper, source: wallpaper })}>
                <span className="wallpaper-option__preview" data-wallpaper={wallpaper} aria-hidden="true"><span /></span>
                <span className="wallpaper-option__copy"><strong>{WALLPAPER_LABELS[wallpaper].name}</strong><small>{WALLPAPER_LABELS[wallpaper].description}</small></span>
              </button>
            ))}
          </div>
          <div className="wallpaper-custom">
            <div className="wallpaper-custom__current">
              <span className="wallpaper-custom__thumbnail" style={wallpaperUrl ? { backgroundImage: `url(${wallpaperUrl})` } : undefined}><ImageSquare size={22} aria-hidden="true" /></span>
              <span><strong>{wallpaperName}</strong><small>{wallpaperFile ? "Image stored on this desktop" : "Built-in wallpaper"}</small></span>
              <button className="button button--quiet" type="button" disabled={!canMutate || wallpaperBusy || displayedLayout.wallpaper.source === DEFAULT_WALLPAPER.source && JSON.stringify(displayedLayout.wallpaper) === JSON.stringify(DEFAULT_WALLPAPER)} onClick={() => void commitWallpaperChange({ ...DEFAULT_WALLPAPER })}>Reset</button>
            </div>
            <div className="wallpaper-custom__actions">
              <input ref={wallpaperUploadRef} className="visually-hidden" type="file" accept={WALLPAPER_IMAGE_ACCEPT} onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                if (wallpaperCommitTimerRef.current !== null) window.clearTimeout(wallpaperCommitTimerRef.current);
                wallpaperCommitTimerRef.current = null;
                pendingLayoutRef.current = null;
                setWallpaperBusy(true);
                void onWallpaperUpload(file, displayedLayout, activeDesktopId).finally(() => setWallpaperBusy(false));
              }} />
              <button className="button button--quiet" type="button" disabled={!canMutate || wallpaperBusy} onClick={() => wallpaperUploadRef.current?.click()}><UploadSimple size={15} /> {wallpaperBusy ? "Adding image..." : "Upload image"}</button>
              <label className="wallpaper-custom__select">Choose existing image
                <select value={wallpaperFileId ?? ""} disabled={!canMutate || wallpaperBusy || wallpaperFiles.length === 0} onChange={(event) => {
                  const fileId = event.target.value;
                  if (!fileId) return;
                  if (wallpaperCommitTimerRef.current !== null) window.clearTimeout(wallpaperCommitTimerRef.current);
                  wallpaperCommitTimerRef.current = null;
                  pendingLayoutRef.current = null;
                  setWallpaperBusy(true);
                  void onWallpaperSelect(fileId, displayedLayout, activeDesktopId).finally(() => setWallpaperBusy(false));
                }}>
                  <option value="">{wallpaperFiles.length ? "Select an image" : "No supported images"}</option>
                  {wallpaperFiles.map((file) => <option value={file.id} key={file.id}>{file.name}</option>)}
                </select>
              </label>
            </div>
            <fieldset className="wallpaper-controls" disabled={!canMutate || wallpaperBusy}>
              <legend>Image treatment</legend>
              <label className="theme-field">Fit<select value={displayedLayout.wallpaper.fit} onChange={(event) => void commitWallpaperChange({ ...displayedLayout.wallpaper, fit: event.target.value as "cover" | "contain" })}><option value="cover">Cover</option><option value="contain">Contain</option></select></label>
              <NumberControl idPrefix="wallpaper" label="Horizontal alignment" value={displayedLayout.wallpaper.positionX} min={0} max={100} step={1} disabled={!canMutate || wallpaperBusy} onChange={(positionX) => previewWallpaper({ ...displayedLayout.wallpaper, positionX })} onCommit={() => void commitWallpaperDraft()} />
              <NumberControl idPrefix="wallpaper" label="Vertical alignment" value={displayedLayout.wallpaper.positionY} min={0} max={100} step={1} disabled={!canMutate || wallpaperBusy} onChange={(positionY) => previewWallpaper({ ...displayedLayout.wallpaper, positionY })} onCommit={() => void commitWallpaperDraft()} />
              <NumberControl idPrefix="wallpaper" label="Blur" value={displayedLayout.wallpaper.blur} min={0} max={24} step={1} disabled={!canMutate || wallpaperBusy} onChange={(blur) => previewWallpaper({ ...displayedLayout.wallpaper, blur })} onCommit={() => void commitWallpaperDraft()} />
              <NumberControl idPrefix="wallpaper" label="Dim" value={displayedLayout.wallpaper.dim} min={0} max={0.8} step={0.05} disabled={!canMutate || wallpaperBusy} onChange={(dim) => previewWallpaper({ ...displayedLayout.wallpaper, dim })} onCommit={() => void commitWallpaperDraft()} />
              <label className="theme-color wallpaper-color"><span>Overlay color</span><input type="color" value={displayedLayout.wallpaper.overlayColor} onInput={(event) => previewWallpaper({ ...displayedLayout.wallpaper, overlayColor: event.currentTarget.value.toUpperCase() })} onBlur={() => void commitWallpaperDraft()} /></label>
              <NumberControl idPrefix="wallpaper" label="Overlay opacity" value={displayedLayout.wallpaper.overlayOpacity} min={0} max={0.8} step={0.05} disabled={!canMutate || wallpaperBusy} onChange={(overlayOpacity) => previewWallpaper({ ...displayedLayout.wallpaper, overlayOpacity })} onCommit={() => void commitWallpaperDraft()} />
            </fieldset>
          </div>
        </section>
            {!canMutate && <p className="settings-window__offline" role="status">{restrictionReason} Appearance remains visible for reference.</p>}
          </div>
        ) : page === "activity" ? (
          <div className="settings-page settings-page--activity">
            <header className="settings-page__header">
              <button className="settings-page__back" type="button" aria-label="Back to settings" onClick={closeActivity}><ArrowLeft size={17} /></button>
              <div>
                <h3 ref={activityHeadingRef} tabIndex={-1}>Activity</h3>
                <p>Accepted changes from this desktop, newest first.</p>
              </div>
            </header>
            <ActivityLog onListActivity={onListActivity} onSubscribe={onSubscribeToActivity} onOpenAffectedEntries={onOpenAffectedEntries} canOpenAffectedEntries={canOpenAffectedEntries} />
          </div>
        ) : (
          <div className="settings-page settings-page--apps">
            <header className="settings-page__header"><button className="settings-page__back" type="button" aria-label="Back to settings" onClick={closeApps}><ArrowLeft size={17} /></button><div><h3 ref={appsHeadingRef} tabIndex={-1}>Apps</h3><p>Approved packages and device-local data.</p></div></header>
            <div className="installed-app-list">
              {installedApps.map((app) => {
                const available = installedAppIsAvailable(app, entries);
                return <article className="installed-app" key={app.appId}><div className="installed-app__heading"><Package size={20} /><div><strong>{app.manifest.name}</strong><small>{app.appId}</small></div><span>{available ? `v${app.version}` : "Unavailable"}</span></div><p>{app.manifest.description ?? "No description provided."}</p><dl><div><dt>Permissions</dt><dd>{app.manifest.permissions.join(", ") || "None"}</dd></div><div><dt>Digest</dt><dd><code title={app.digest}>{app.digest.slice(0, 12)}...</code></dd></div></dl><div className="installed-app__actions"><button className="button button--quiet" type="button" disabled={!available} onClick={() => onLaunchApp(app)}><Play size={15} /> Launch</button><button className="button button--quiet" type="button" onClick={() => onUninstallApp(app)}><Trash size={15} /> Uninstall</button></div></article>;
              })}
              {!installedApps.length && <p className="theme-custom__empty">No apps are approved on this device. Open a <code>.hiraya.app</code> package to install one.</p>}
            </div>
            <button className="inline-help-link" type="button" onClick={() => onOpenHelp("apps-and-permissions")}>App packages, permissions, and updates</button>
          </div>
        )}
      </div>
    </div>
  );
}

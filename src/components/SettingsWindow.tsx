import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowClockwise, ArrowLeft, ArrowsOut, CaretRight, ClockCounterClockwise, CornersIn, CornersOut, ExportIcon, GlobeSimple, GridFour, PaintBrush } from "@phosphor-icons/react";
import { ActivityLog } from "./ActivityLog";
import type { ActivityPage, ActivityQuery } from "../lib/activity";
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEMES,
  isBuiltinThemeId,
  type CustomTheme,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeState,
  themeContrastIssues,
} from "../lib/themes";
import { WALLPAPERS, type DesktopLayout, type Wallpaper } from "../types";
import type { AppWindowHeaderElements } from "./AppWindow";

const WALLPAPER_LABELS: Record<Wallpaper, { name: string; description: string }> = {
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

type Props = {
  page: "main" | "themes" | "activity";
  onPageChange: (page: "main" | "themes" | "activity") => void;
  mobileHeaderElements?: AppWindowHeaderElements;
  layout: DesktopLayout;
  appearance: ThemeState;
  activeTheme: ThemeDefinition;
  canMutate: boolean;
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
  serverBuildTimestamp: string | null;
  onListActivity: (query?: ActivityQuery) => Promise<ActivityPage>;
  onSubscribeToActivity: (listener: () => void) => () => void;
  onLayoutChange: (layout: DesktopLayout) => void;
  onThemeSelect: (themeId: string) => void | Promise<void>;
  onThemePreview: (theme: ThemeDefinition | null) => void;
  onThemeSave: (theme: CustomTheme) => void | Promise<void>;
  onThemeDelete: (themeId: string) => void | Promise<void>;
  onExport: () => void;
  onToggleFullscreen: () => void;
  onCheckForUpdate: () => void;
  onAutoUpdateChange: (enabled: boolean) => void;
  onExternalEmbeddedPreviewsChange: (enabled: boolean) => void;
};

type NumberControlProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
};

function NumberControl({ label, value, min, max, step, disabled, onChange }: NumberControlProps) {
  const id = `theme-${label.toLowerCase().replaceAll(" ", "-")}`;
  const changeValue = (next: number) => {
    if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
  };
  return (
    <div className="theme-control">
      <label htmlFor={id}>{label} <output>{value}</output></label>
      <div className="theme-control__inputs">
        <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => changeValue(event.target.valueAsNumber)} />
        <input aria-label={`${label} value`} type="number" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => changeValue(event.target.valueAsNumber)} />
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
  appearance,
  activeTheme,
  canMutate,
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
  serverBuildTimestamp,
  onListActivity,
  onSubscribeToActivity,
  onLayoutChange,
  onThemeSelect,
  onThemePreview,
  onThemeSave,
  onThemeDelete,
  onExport,
  onToggleFullscreen,
  onCheckForUpdate,
  onAutoUpdateChange,
  onExternalEmbeddedPreviewsChange,
}: Props) {
  const [draft, setDraft] = useState<CustomTheme | null>(null);
  const [saving, setSaving] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const mainThemesButtonRef = useRef<HTMLButtonElement>(null);
  const mainActivityButtonRef = useRef<HTMLButtonElement>(null);
  const themesHeadingRef = useRef<HTMLHeadingElement>(null);
  const activityHeadingRef = useRef<HTMLHeadingElement>(null);
  const mutationsDisabled = !canMutate || saving;
  const contrastIssues = draft ? themeContrastIssues(draft.definition) : [];
  const selectedThemeName = isBuiltinThemeId(appearance.selectedThemeId)
    ? BUILTIN_THEMES[appearance.selectedThemeId].name
    : appearance.customThemes.find((theme) => theme.id === appearance.selectedThemeId)?.name ?? "Custom theme";
  const formatBuildTimestamp = (timestamp: string | null) => {
    if (!timestamp) return "Unavailable";
    const date = new Date(timestamp);
    if (Number.isNaN(date.valueOf())) return "Unavailable";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(date);
  };

  useEffect(() => () => onThemePreview(null), [onThemePreview]);

  const startDraft = (name: string, definition: ThemeDefinition, id: string = crypto.randomUUID()) => {
    const next = { id, name, definition: copyDefinition(definition) };
    setDraft(next);
    onThemePreview(next.definition);
  };

  const updateDraft = (update: (current: CustomTheme) => CustomTheme) => {
    setDraft((current) => {
      if (!current) return current;
      const next = update(current);
      onThemePreview(next.definition);
      return next;
    });
  };

  const selectTheme = async (themeId: string) => {
    if (mutationsDisabled) return;
    setSaving(true);
    try {
      await onThemeSelect(themeId);
      setDraft(null);
      onThemePreview(null);
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
      onThemePreview(null);
      setDraft(null);
    } catch {
      // Keep the draft and preview available for retry.
    } finally {
      setSaving(false);
    }
  };

  const deleteTheme = async (theme: CustomTheme) => {
    if (mutationsDisabled || !window.confirm(`Delete “${theme.name}”?`)) return;
    setSaving(true);
    try {
      await onThemeDelete(theme.id);
      if (draft?.id === theme.id) {
        setDraft(null);
        onThemePreview(null);
      }
    } catch {
      // Keep the draft available if deletion fails.
    } finally {
      setSaving(false);
    }
  };

  const cancelDraft = () => {
    setDraft(null);
    onThemePreview(null);
  };

  const openThemes = () => {
    contentRef.current?.scrollTo({ top: 0 });
    onPageChange("themes");
    if (!mobileHeaderElements) requestAnimationFrame(() => themesHeadingRef.current?.focus());
  };

  const closeThemes = () => {
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

  return (
    <div className="settings-window settings-window--embedded">
      {page !== "main" && mobileHeaderElements?.leading && createPortal(
        <button className="app-window__control mobile-header-back" type="button" aria-label="Back to settings" disabled={page === "themes" && saving} onClick={page === "themes" ? closeThemes : closeActivity}>
          <ArrowLeft size={18} />
        </button>,
        mobileHeaderElements.leading,
      )}
      <div className="settings-window__content" ref={contentRef}>
        {page === "main" ? (
          <>
            <section className="settings-section" aria-labelledby="themes-link-heading">
              <button className="settings-row settings-row--navigation" type="button" ref={mainThemesButtonRef} onClick={openThemes}>
                <span className="settings-row__icon"><PaintBrush size={17} /></span>
                <span className="settings-row__copy">
                  <strong id="themes-link-heading">Themes</strong>
                  <small>{selectedThemeName} theme with {WALLPAPER_LABELS[layout.wallpaper].name.toLowerCase()} wallpaper.</small>
                </span>
                <CaretRight className="settings-row__chevron" size={17} aria-hidden="true" />
              </button>
            </section>

            <section className="settings-section" aria-labelledby="activity-link-heading">
              <button className="settings-row settings-row--navigation" type="button" ref={mainActivityButtonRef} onClick={openActivity}>
                <span className="settings-row__icon"><ClockCounterClockwise size={17} /></span>
                <span className="settings-row__copy">
                  <strong id="activity-link-heading">Activity</strong>
                  <small>Review and search accepted desktop changes.</small>
                </span>
                <CaretRight className="settings-row__chevron" size={17} aria-hidden="true" />
              </button>
            </section>

            <section className="settings-section" aria-labelledby="desktop-heading">
              <div className="settings-section__heading">
                <ArrowsOut size={18} />
                <div><h3 id="desktop-heading">Desktop</h3><p>Adjust icon placement and the viewing area.</p></div>
              </div>
              <div className="settings-list">
                <label className="settings-row">
                  <span className="settings-row__icon"><GridFour size={17} weight={layout.snapToGrid ? "fill" : "regular"} /></span>
                  <span className="settings-row__copy"><strong>Snap to grid</strong><small>Align icons when they are moved.</small></span>
                  <input type="checkbox" checked={layout.snapToGrid} disabled={!canMutate} onChange={(event) => onLayoutChange({ ...layout, snapToGrid: event.target.checked })} />
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

            <section className="settings-section" aria-labelledby="external-content-heading">
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

            <section className="settings-section" aria-labelledby="updates-heading">
              <div className="settings-section__heading">
                <ArrowClockwise size={18} />
                <div><h3 id="updates-heading">Updates</h3><p>Keep this installed app current.</p></div>
              </div>
              <div className="settings-list">
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
            </section>

            <section className="settings-section" aria-labelledby="export-heading">
              <div className="settings-section__heading">
                <ExportIcon size={18} />
                <div><h3 id="export-heading">Export</h3><p>Package saved items and settings for another Hiraya app.</p></div>
              </div>
              <div className="settings-export">
                <span>Unsaved editor changes are not included.</span>
                <button className="button button--quiet" type="button" disabled={exportDisabled || exporting} onClick={onExport}><ExportIcon size={16} /> {exporting ? "Exporting..." : "Export desktop package"}</button>
              </div>
            </section>

            {!canMutate && <p className="settings-window__offline" role="status">Connecting to the shared desktop. Settings will be available shortly.</p>}
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
                <span className="theme-swatch" style={{ background: `linear-gradient(135deg, ${activeTheme.colors.chrome} 0 50%, ${activeTheme.colors.accent} 50%)` }} aria-hidden="true" />
              </div>
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

              {contrastIssues.length > 0 && <p className="theme-editor__warning" role="alert">Increase contrast for {contrastIssues.join(", ")} before saving.</p>}

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
              <button className="wallpaper-option" data-selected={layout.wallpaper === wallpaper || undefined} type="button" key={wallpaper} aria-pressed={layout.wallpaper === wallpaper} disabled={!canMutate} onClick={() => onLayoutChange({ ...layout, wallpaper })}>
                <span className="wallpaper-option__preview" data-wallpaper={wallpaper} aria-hidden="true"><span /></span>
                <span className="wallpaper-option__copy"><strong>{WALLPAPER_LABELS[wallpaper].name}</strong><small>{WALLPAPER_LABELS[wallpaper].description}</small></span>
              </button>
            ))}
          </div>
        </section>
            {!canMutate && <p className="settings-window__offline" role="status">Connecting to the shared desktop. Appearance controls will be available shortly.</p>}
          </div>
        ) : (
          <div className="settings-page settings-page--activity">
            <header className="settings-page__header">
              <button className="settings-page__back" type="button" aria-label="Back to settings" onClick={closeActivity}><ArrowLeft size={17} /></button>
              <div>
                <h3 ref={activityHeadingRef} tabIndex={-1}>Activity</h3>
                <p>Accepted changes from this desktop, newest first.</p>
              </div>
            </header>
            <ActivityLog onListActivity={onListActivity} onSubscribe={onSubscribeToActivity} />
          </div>
        )}
      </div>
    </div>
  );
}

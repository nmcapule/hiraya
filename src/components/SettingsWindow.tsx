import { ArrowClockwise, ArrowsOut, CornersIn, CornersOut, ExportIcon, GridFour, PaintBrush } from "@phosphor-icons/react";
import { WALLPAPERS, type DesktopLayout, type Wallpaper } from "../types";

const WALLPAPER_LABELS: Record<Wallpaper, { name: string; description: string }> = {
  dusk: { name: "Dusk", description: "Misty green with a warm horizon" },
  grove: { name: "Grove", description: "Deep forest layers in cool green" },
  ember: { name: "Ember", description: "Smoky earth with an amber glow" },
};

type Props = {
  layout: DesktopLayout;
  canMutate: boolean;
  exportDisabled: boolean;
  exporting: boolean;
  fullscreenEnabled: boolean;
  isFullscreen: boolean;
  updateSupported: boolean;
  updateReady: boolean;
  updateChecking: boolean;
  autoUpdate: boolean;
  onLayoutChange: (layout: DesktopLayout) => void;
  onExport: () => void;
  onToggleFullscreen: () => void;
  onCheckForUpdate: () => void;
  onAutoUpdateChange: (enabled: boolean) => void;
};

export function SettingsWindow({ layout, canMutate, exportDisabled, exporting, fullscreenEnabled, isFullscreen, updateSupported, updateReady, updateChecking, autoUpdate, onLayoutChange, onExport, onToggleFullscreen, onCheckForUpdate, onAutoUpdateChange }: Props) {
  return (
    <div className="settings-window settings-window--embedded">
        <div className="settings-window__content">
          <section className="settings-section" aria-labelledby="appearance-heading">
            <div className="settings-section__heading">
              <PaintBrush size={18} />
              <div>
                <h3 id="appearance-heading">Wallpaper</h3>
                <p>Choose the backdrop shared by this workspace.</p>
              </div>
            </div>
            <div className="wallpaper-options">
              {WALLPAPERS.map((wallpaper) => (
                <button
                  className="wallpaper-option"
                  data-selected={layout.wallpaper === wallpaper || undefined}
                  type="button"
                  key={wallpaper}
                  aria-pressed={layout.wallpaper === wallpaper}
                  disabled={!canMutate}
                  onClick={() => onLayoutChange({ ...layout, wallpaper })}
                >
                  <span className="wallpaper-option__preview" data-wallpaper={wallpaper} aria-hidden="true"><span /></span>
                  <span className="wallpaper-option__copy">
                    <strong>{WALLPAPER_LABELS[wallpaper].name}</strong>
                    <small>{WALLPAPER_LABELS[wallpaper].description}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section" aria-labelledby="desktop-heading">
            <div className="settings-section__heading">
              <ArrowsOut size={18} />
              <div>
                <h3 id="desktop-heading">Desktop</h3>
                <p>Adjust icon placement and the viewing area.</p>
              </div>
            </div>
            <div className="settings-list">
              <label className="settings-row">
                <span className="settings-row__icon"><GridFour size={17} weight={layout.snapToGrid ? "fill" : "regular"} /></span>
                <span className="settings-row__copy"><strong>Snap to grid</strong><small>Align icons when they are moved.</small></span>
                <input
                  type="checkbox"
                  checked={layout.snapToGrid}
                  disabled={!canMutate}
                  onChange={(event) => onLayoutChange({ ...layout, snapToGrid: event.target.checked })}
                />
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

          <section className="settings-section" aria-labelledby="updates-heading">
            <div className="settings-section__heading">
              <ArrowClockwise size={18} />
              <div>
                <h3 id="updates-heading">Updates</h3>
                <p>Keep this installed frontend current.</p>
              </div>
            </div>
            <div className="settings-list">
              <div className="settings-row">
                <span className="settings-row__icon"><ArrowClockwise size={17} weight={updateReady ? "bold" : "regular"} /></span>
                <span className="settings-row__copy"><strong>Update to latest version</strong><small>{!updateSupported ? "Available in production PWA builds." : updateReady ? "A new version is ready to install." : "Check for a newer frontend release."}</small></span>
                <button className="button button--quiet" type="button" disabled={!updateSupported || updateChecking} onClick={onCheckForUpdate}>{updateChecking ? "Checking" : updateReady ? "Review" : "Check now"}</button>
              </div>
              <label className="settings-row">
                <span className="settings-row__icon"><ArrowClockwise size={17} /></span>
                <span className="settings-row__copy"><strong>Auto-update to latest version</strong><small>Check automatically, then ask before reloading.</small></span>
                <input type="checkbox" checked={autoUpdate} disabled={!updateSupported} onChange={(event) => onAutoUpdateChange(event.target.checked)} />
              </label>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="data-heading">
            <div className="settings-section__heading">
              <ExportIcon size={18} />
              <div>
                <h3 id="data-heading">Saved desktop</h3>
                <p>Package saved files and settings for another Hiraya build.</p>
              </div>
            </div>
            <div className="settings-export">
              <span>Unsaved editor changes are not included.</span>
              <button className="button button--quiet" type="button" disabled={exportDisabled || exporting} onClick={onExport}>
                <ExportIcon size={16} /> {exporting ? "Exporting" : "Export desktop"}
              </button>
            </div>
          </section>

          {!canMutate && <p className="settings-window__offline" role="status">Shared appearance controls are unavailable until the sync server reconnects.</p>}
        </div>
    </div>
  );
}

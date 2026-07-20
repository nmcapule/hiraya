import { ArrowsOut, CornersIn, CornersOut, ExportIcon, GridFour, PaintBrush, X } from "@phosphor-icons/react";
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
  onClose: () => void;
  onLayoutChange: (layout: DesktopLayout) => void;
  onExport: () => void;
  onToggleFullscreen: () => void;
};

export function SettingsWindow({ layout, canMutate, exportDisabled, exporting, fullscreenEnabled, isFullscreen, onClose, onLayoutChange, onExport, onToggleFullscreen }: Props) {
  return (
    <div className="modal-backdrop modal-backdrop--window" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-window" role="dialog" aria-modal="true" aria-labelledby="settings-window-title">
        <header className="window-header">
          <div>
            <span className="window-kicker">Hiraya desktop</span>
            <h2 id="settings-window-title">Settings</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </header>

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
      </section>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, DownloadSimple, Folder, SignIn, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import { AppWindow } from "./components/AppWindow";
import { EntryTypeIcon } from "./components/FileIcon";
import { FileWindow } from "./components/FileWindow";
import { FolderExplorer } from "./components/FolderExplorer";
import { loginUrl } from "./lib/auth";
import { fetchPublicDesktop, fetchPublicFile, LargeDownloadAuthRequiredError } from "./lib/public-desktop";
import { DEFAULT_THEME_STATE, isBuiltinThemeId, resolveTheme, themeStyle } from "./lib/themes";
import { DEFAULT_EDITOR_SETTINGS } from "./lib/desktop-state";
import type { DesktopEntry, FileEntry, FolderEntry } from "./types";
import { createEntryIndex } from "./ui/entry-index";
import { fileCapabilities } from "./ui/file-capabilities";
import { useModalDialog } from "./ui/modal-dialog";
import { publicFolderBackTarget, publicWindowBounds } from "./ui/public-desktop-layout";
import { MOBILE_WINDOW_QUERY, TOUCH_PRIMARY_QUERY, useMediaQuery } from "./ui/responsive";
import { StatusBadge } from "./components/VisualPrimitives";

type OpenView = { kind: "folder"; folderId: string | null } | { kind: "file"; file: FileEntry; blob?: File; error?: string };

function LargeDownloadGate({ gate, onClose }: { gate: { loginUrl: string; fileName: string }; onClose: () => void }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useModalDialog(backdropRef, dialogRef, onClose);
  return <div ref={backdropRef} className="sharing-dialog__backdrop large-download-gate__backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="large-download-gate" role="dialog" aria-modal="true" aria-labelledby="download-gate-title" tabIndex={-1}>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      <span className="large-download-gate__icon"><DownloadSimple size={25} /></span>
      <h2 id="download-gate-title">Sign in for this download</h2>
      <p><strong>{gate.fileName}</strong> is large enough to require an authenticated download. The public desktop remains available.</p>
      <a className="button button--primary" href={new URL(gate.loginUrl, window.location.href).href}><SignIn size={16} /> Sign in and return</a>
    </section>
  </div>;
}

export default function PublicDesktop({ token }: { token: string }) {
  const [desktop, setDesktop] = useState<Awaited<ReturnType<typeof fetchPublicDesktop>> | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<OpenView | null>(null);
  const [gate, setGate] = useState<{ loginUrl: string; fileName: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [wallpaperUrl, setWallpaperUrl] = useState("");
  const [surfaceSize, setSurfaceSize] = useState(() => ({ width: window.innerWidth, height: Math.max(1, window.innerHeight - 44) }));
  const [bounds, setBounds] = useState(() => publicWindowBounds(surfaceSize));
  const surfaceRef = useRef<HTMLElement>(null);
  const index = useMemo(() => createEntryIndex(desktop?.entries ?? []), [desktop?.entries]);
  const appearance = desktop?.appearance ?? DEFAULT_THEME_STATE;
  const theme = resolveTheme(appearance);
  const mobile = useMediaQuery(MOBILE_WINDOW_QUERY);
  const touchPrimary = useMediaQuery(TOUCH_PRIMARY_QUERY);

  useEffect(() => { void fetchPublicDesktop(token).then(setDesktop).catch((reason) => setError(reason instanceof Error ? reason.message : "The public desktop could not be loaded.")); }, [token]);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const observer = new ResizeObserver(([entry]) => setSurfaceSize({ width: Math.max(1, Math.round(entry.contentRect.width)), height: Math.max(1, Math.round(entry.contentRect.height)) }));
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setBounds(publicWindowBounds(surfaceSize)), [surfaceSize]);
  useEffect(() => {
    setWallpaperUrl("");
    const source = desktop?.layout.wallpaper.source;
    if (!desktop || !source?.startsWith("file:")) return;
    const file = desktop.entries.find((entry) => entry.id === source.slice(5));
    if (!file || file.kind !== "file") return;
    let disposed = false;
    let objectUrl = "";
    const contentRevision = desktop.entries.find((entry) => entry.id === file.id)?.contentRevision ?? 0;
    void fetchPublicFile(token, file, contentRevision).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setWallpaperUrl(objectUrl);
    }).catch(() => undefined);
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [desktop, token]);

  async function loadFile(file: FileEntry, downloadOnly = false) {
    if (!downloadOnly && fileCapabilities(file).preview === "none") { setOpen({ kind: "file", file }); return; }
    setOpen(downloadOnly ? open : { kind: "file", file });
    try {
      const contentRevision = desktop?.entries.find((entry) => entry.id === file.id)?.contentRevision ?? 0;
      const blob = await fetchPublicFile(token, file, contentRevision);
      if (downloadOnly) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name; anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      } else setOpen({ kind: "file", file, blob });
    } catch (reason) {
      if (reason instanceof LargeDownloadAuthRequiredError) setGate({ loginUrl: reason.loginUrl, fileName: file.name });
      else if (!downloadOnly) setOpen({ kind: "file", file, error: reason instanceof Error ? reason.message : "The file could not be opened." });
      else setError(reason instanceof Error ? reason.message : "The file could not be downloaded.");
    }
  }

  function openEntry(entry: DesktopEntry) { if (entry.kind === "folder") setOpen({ kind: "folder", folderId: entry.id }); else void loadFile(entry); }
  async function resolveLinkedFile(from: FileEntry, relativePath: string) {
    if (!desktop) throw new Error("The public desktop is unavailable.");
    const path = relativePath.split(/[?#]/, 1)[0];
    if (!path || path.startsWith("/") || path.startsWith("\\") || /^[a-z][a-z\d+.-]*:/i.test(path)) throw new Error("That link is not a local relative file path.");
    let parentId = from.parentId;
    let resolved: DesktopEntry | undefined;
    for (const [position, encoded] of path.split("/").entries()) {
      let segment: string;
      try { segment = decodeURIComponent(encoded); } catch { throw new Error("That link contains invalid URL encoding."); }
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (parentId === null) throw new Error("That link points outside the desktop.");
        parentId = desktop.entries.find((entry) => entry.id === parentId)?.parentId ?? null;
        resolved = undefined;
        continue;
      }
      resolved = desktop.entries.find((entry) => entry.parentId === parentId && entry.name.localeCompare(segment, undefined, { sensitivity: "accent" }) === 0);
      if (!resolved || position < path.split("/").length - 1 && resolved.kind !== "folder") throw new Error(`No public file exists at “${relativePath}”.`);
      parentId = resolved.kind === "folder" ? resolved.id : resolved.parentId;
    }
    if (!resolved || resolved.kind !== "file") throw new Error(`No public file exists at “${relativePath}”.`);
    const contentRevision = desktop.entries.find((entry) => entry.id === resolved.id)?.contentRevision ?? 0;
    return { file: resolved, blob: await fetchPublicFile(token, resolved, contentRevision) };
  }
  const folder = open?.kind === "folder" && open.folderId ? index.byId.get(open.folderId) as FolderEntry | undefined : null;
  const roots = index.children.get(null) ?? [];
  const owner = desktop?.owner;
  const wallpaper = desktop?.layout.wallpaper;
  const closePublicView = () => setOpen(null);
  const backPublicView = () => {
    if (open?.kind !== "folder" || !open.folderId) { closePublicView(); return; }
    setOpen({ kind: "folder", folderId: publicFolderBackTarget(desktop?.entries ?? [], open.folderId) ?? null });
  };

  return <main className="desktop-shell public-desktop" data-theme={isBuiltinThemeId(appearance.selectedThemeId) ? appearance.selectedThemeId : "custom"} style={themeStyle(theme)}>
    <header className="menu-bar public-menu">{mobile && open ? <><button className="public-menu__back" type="button" onClick={backPublicView} aria-label={open.kind === "folder" && open.folderId ? "Back to parent folder" : "Back to public desktop"}><ArrowLeft /><span>Back</span></button><strong className="public-menu__context">{open.kind === "folder" ? folder?.name ?? desktop?.name ?? "Desktop" : open.file.name}</strong><button className="public-menu__close" type="button" onClick={closePublicView}><X /> <span>Close</span></button></> : <><div className="brand-mark"><span className="brand-mark__shape"><span /></span><strong>Hiraya</strong><span className="public-menu__desktop">{desktop?.name || "Public desktop"}</span></div><div className="public-menu__actions"><StatusBadge tone="readonly" surface="chrome">Read only</StatusBadge><a className="button button--quiet" href={loginUrl()}><SignIn size={16} /> Sign in</a></div></>}</header>
    <section ref={surfaceRef} className="desktop public-desktop__surface" data-wallpaper={wallpaper?.source.startsWith("file:") ? wallpaperUrl ? "file" : "dusk" : wallpaper?.source ?? "dusk"} data-custom-loaded={wallpaperUrl || undefined} style={{ "--wallpaper-image": wallpaperUrl ? `url(${wallpaperUrl})` : "none", "--wallpaper-fit": wallpaper?.fit ?? "cover", "--wallpaper-position": `${wallpaper?.positionX ?? 50}% ${wallpaper?.positionY ?? 50}%`, "--wallpaper-blur": `${wallpaper?.blur ?? 0}px` } as React.CSSProperties} aria-label={desktop ? `${desktop.name} public desktop` : "Public desktop"}>
      <div className="wallpaper-image" aria-hidden="true" /><div className="wallpaper-grain" aria-hidden="true" /><div className="wallpaper-dim" aria-hidden="true" style={{ backgroundColor: "#000000", opacity: wallpaper?.dim ?? 0 }} /><div className="wallpaper-color-overlay" aria-hidden="true" style={{ backgroundColor: wallpaper?.overlayColor, opacity: wallpaper?.overlayOpacity }} />
      {desktop && <div className="public-owner"><span className="sharing-avatar">{owner?.avatar && !owner.avatar.startsWith("identicon:") ? <img src={owner.avatar} alt="" /> : owner?.displayName.slice(0, 1).toUpperCase()}</span><div><span>Shared publicly by</span><strong>{owner?.displayName}</strong></div></div>}
      {!desktop && !error && <div className="desktop-state desktop-state--loading" role="status"><SpinnerGap size={24} /> Opening public desktop...</div>}
      {error && <div className="desktop-state public-error" role="alert"><WarningCircle size={30} /><h1>Desktop unavailable</h1><p>{error}</p></div>}
      {desktop && roots.length === 0 && <div className="desktop-state empty-state"><Folder size={30} weight="duotone" /><h1>This desktop is empty.</h1><p>There are no public files to browse yet.</p></div>}
      {desktop && <div className="public-icon-grid">{roots.map((entry) => <button className="public-icon" type="button" key={entry.id} aria-pressed={selectedIds.has(entry.id)} onClick={() => { setSelectedIds(new Set([entry.id])); if (touchPrimary) openEntry(entry); }} onDoubleClick={() => { if (!touchPrimary) openEntry(entry); }} onKeyDown={(event) => { if (event.key === "Enter") openEntry(entry); }}><EntryTypeIcon entry={entry} size={39} /><span>{entry.name}</span></button>)}</div>}
      {open && <div className="app-window-layer"><AppWindow id="public-view" title={open.kind === "folder" ? folder?.name ?? desktop?.name ?? "Desktop" : open.file.name} titleId="public-view-title" bounds={bounds} zIndex={1} focused minimized={false} segmentActive mobile={mobile} hideMobileHeader onFocus={() => undefined} onBoundsChange={(_, next) => setBounds(next)} onClose={closePublicView} onShowDesktop={backPublicView} mobileBackLabel={open.kind === "folder" && open.folderId ? "Back to parent" : "Back to desktop"} titleArea={<div><span className="window-kicker">Public · Read only</span><h2 id="public-view-title">{open.kind === "folder" ? folder?.name ?? desktop?.name : open.file.name}</h2></div>}>
        {(headerElements) => open.kind === "folder" ? <FolderExplorer folder={folder ?? null} rootLabel={desktop?.name ?? "Desktop"} breadcrumbs={folder ? index.ancestors(folder.id).filter((entry): entry is FolderEntry => entry.kind === "folder") : []} children={index.children.get(open.folderId) ?? []} selectedIds={selectedIds} onSelect={(entry) => setSelectedIds(new Set([entry.id]))} onNavigate={(next) => setOpen({ kind: "folder", folderId: next?.id ?? null })} onOpen={openEntry} onCreateFolder={() => undefined} onCreateFile={() => undefined} onUpload={() => undefined} onImportFolder={() => undefined} onExternalDrop={() => undefined} onMove={() => undefined} onContextMenu={() => undefined} onBlankContextMenu={() => undefined} readOnly headerElements={headerElements} /> : open.blob ? <FileWindow file={open.file} blob={open.blob} editable={fileCapabilities(open.file).editable} readOnly headerActionsTarget={headerElements.actions} editorSettings={desktop?.editorSettings ?? DEFAULT_EDITOR_SETTINGS} externalEmbeddedPreviews={false} theme={theme} onSave={async () => undefined} onDownload={() => void loadFile(open.file, true)} onEdit={() => undefined} onEditorSettingsChange={() => undefined} onResolveLink={(path) => resolveLinkedFile(open.file, path)} onOpenLinkedFile={(file) => void loadFile(file)} /> : open.error ? <div className="app-window__loading" role="alert"><span>{open.error}</span><button className="button button--primary" type="button" onClick={() => void loadFile(open.file)}>Retry</button></div> : fileCapabilities(open.file).preview === "none" ? <div className="no-preview"><p>No preview is available for this file type.</p><button className="button button--primary" type="button" onClick={() => void loadFile(open.file, true)}><DownloadSimple size={16} /> Download file</button></div> : <div className="app-window__loading" role="status"><SpinnerGap size={22} /> Opening {open.file.name}...</div>}
      </AppWindow></div>}
    </section>
    {gate && <LargeDownloadGate gate={gate} onClose={() => setGate(null)} />}
  </main>;
}

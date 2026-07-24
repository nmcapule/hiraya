import { useEffect, useRef, useState } from "react";
import { CaretDown, Check, Desktop, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import type { DesktopIdentity } from "../types";
import { desktopCreateProtection, desktopDeleteProtection, type CatalogQuota } from "../lib/desktop-catalog";
import { RoleBadge } from "./VisualPrimitives";

type Props = {
  desktops: readonly DesktopIdentity[];
  activeDesktopId: string;
  disabled?: boolean;
  quota?: CatalogQuota | null;
  quotaStale?: boolean;
  onSwitch: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  canManageDesktop?: (desktop: DesktopIdentity) => boolean;
};

function formatBytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} kB`;
  return `${value} bytes`;
}

function quotaPercent(used: number, limit: number) { return Math.min(100, used / limit * 100); }

export function DesktopSwitcher({ desktops, activeDesktopId, disabled, quota, quotaStale, onSwitch, onCreate, onRename, onDelete, canManageDesktop = () => true }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ mode: "create" | "rename"; id?: string; value: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const active = desktops.find((desktop) => desktop.id === activeDesktopId) ?? desktops[0];
  const owned = desktops.filter((desktop) => desktop.ownership === "owned");
  const shared = desktops.filter((desktop) => desktop.ownership === "shared");
  const createProtection = desktopCreateProtection(owned.length, quota);

  function close(returnFocus = true) {
    setOpen(false);
    setEditing(null);
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(false); };
    const onFocusIn = (event: FocusEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("pointerdown", onPointerDown); window.removeEventListener("focusin", onFocusIn); window.removeEventListener("keydown", onKeyDown); };
  }, [open]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
    else if (open) requestAnimationFrame(() => (
      rootRef.current?.querySelector<HTMLElement>("[data-desktop-switch-target][aria-current='true']")
      ?? rootRef.current?.querySelector<HTMLElement>("[data-desktop-switch-target]")
    )?.focus());
  }, [editing, open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !editing.value.trim() || editing.mode === "create" && createProtection) return;
    setSubmitting(true);
    setError("");
    try {
      if (editing.mode === "create") await onCreate(editing.value);
      else await onRename(editing.id!, editing.value);
      setEditing(null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The desktop could not be saved.");
    } finally { setSubmitting(false); }
  }

  return <div className="desktop-switcher" ref={rootRef}>
    <button
      ref={triggerRef}
      className="brand-mark desktop-switcher__trigger"
      type="button"
      disabled={disabled}
      aria-haspopup="dialog"
      aria-label={`Switch workspace, current workspace ${active?.name ?? "unavailable"}`}
      title={disabled ? "Workspaces are still loading." : `Switch workspace from ${active?.name ?? "the current workspace"}`}
      aria-expanded={open}
      aria-controls={open ? "desktop-switcher-dialog" : undefined}
      onClick={() => { if (open) close(false); else setOpen(true); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" && !open) {
          event.preventDefault();
          setOpen(true);
        }
      }}
    >
      <span className="brand-mark__shape"><span /></span><strong>Hiraya</strong><span className="desktop-switcher__name">{active?.name}</span><CaretDown size={13} />
    </button>
    {open && <section id="desktop-switcher-dialog" className="desktop-switcher__panel" role="dialog" aria-modal="false" aria-labelledby="desktop-switcher-title">
      <header><span id="desktop-switcher-title">Desktops</span><button type="button" className="icon-button" onClick={() => close()} aria-label="Close desktop switcher"><X size={16} /></button></header>
      <div className="desktop-switcher__list" role="list">
        {([{"label":"Your desktops","items":owned},{"label":"Shared with you","items":shared}] as const).map((group) => group.items.length > 0 && <div className="desktop-switcher__group" key={group.label}><h3>{group.label}</h3>{group.items.map((desktop) => <div className="desktop-switcher__row desktop-switcher__row--switch" role="listitem" key={desktop.id} data-active={desktop.id === activeDesktopId || undefined}>
             <button type="button" data-desktop-switch-target aria-current={desktop.id === activeDesktopId ? "true" : undefined} onClick={() => { onSwitch(desktop.id); close(); }}>
               <Desktop size={18} weight="duotone" /><span><strong>{desktop.name}</strong>{desktop.ownership === "shared" && <small>{desktop.owner.displayName} · <RoleBadge>{desktop.role}</RoleBadge></small>}</span>{desktop.id === activeDesktopId && <Check size={15} />}
            </button>
        </div>)}</div>)}
       </div>
       <details className="desktop-switcher__manage"><summary>Manage workspaces</summary><div>{owned.map((desktop) => {
         const protectedReason = desktop.capabilities.delete ? desktopDeleteProtection(owned.length) : "Only the owner can delete this desktop.";
         const renameReason = desktop.capabilities.manage && !canManageDesktop(desktop) ? "Connect to rename this workspace." : "";
         const reasonId = `desktop-manage-${desktop.id.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
         return <div className="desktop-switcher__manage-row" key={desktop.id}><span><strong>{desktop.name}</strong>{(renameReason || protectedReason) && <small id={reasonId}>{[renameReason, protectedReason].filter(Boolean).join(" ")}</small>}</span>{desktop.capabilities.manage && <button type="button" className="icon-button" disabled={Boolean(renameReason)} aria-describedby={renameReason ? reasonId : undefined} aria-label={`Rename ${desktop.name}`} onClick={() => setEditing({ mode: "rename", id: desktop.id, value: desktop.name })}><PencilSimple size={15} /></button>}{desktop.capabilities.delete && <button type="button" className="icon-button" disabled={Boolean(protectedReason)} aria-describedby={protectedReason ? reasonId : undefined} title={protectedReason || `Delete ${desktop.name}`} aria-label={`Delete ${desktop.name}`} onClick={() => { setError(""); void onDelete(desktop.id).catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : "The desktop could not be deleted.")); }}><Trash size={15} /></button>}</div>;
       })}</div>{quota && <section className="desktop-switcher__quota" aria-label="Account limits">
         <div className="desktop-switcher__quota-heading"><strong>Account limits</strong>{quotaStale && <span>Last synced</span>}</div>
        <div className="desktop-switcher__quota-row" data-limit={quota.storageBytes.used >= quota.storageBytes.limit || undefined}><span>Storage</span><strong>{formatBytes(quota.storageBytes.used)} / {formatBytes(quota.storageBytes.limit)}</strong><progress aria-label="Storage used" max="100" value={quotaPercent(quota.storageBytes.used, quota.storageBytes.limit)} /></div>
        <div className="desktop-switcher__quota-row" data-limit={owned.length >= quota.desktops.limit || undefined}><span>Desktops</span><strong>{owned.length.toLocaleString()} / {quota.desktops.limit.toLocaleString()}</strong><progress aria-label="Desktops used" max="100" value={quotaPercent(owned.length, quota.desktops.limit)} /></div>
        <div className="desktop-switcher__quota-row" data-limit={quota.entries.used >= quota.entries.limit || undefined}><span>Entries</span><strong>{quota.entries.used.toLocaleString()} / {quota.entries.limit.toLocaleString()}</strong><progress aria-label="Entries used" max="100" value={quotaPercent(quota.entries.used, quota.entries.limit)} /></div>
       </section>}</details>
      {editing ? <form className="desktop-switcher__form" onSubmit={submit}>
        <label>{editing.mode === "create" ? "New desktop name" : "Rename desktop"}<input ref={inputRef} value={editing.value} maxLength={180} onChange={(event) => setEditing({ ...editing, value: event.target.value })} /></label>
        <button className="button button--primary" type="submit" disabled={submitting || !editing.value.trim() || editing.mode === "create" && Boolean(createProtection)}>{submitting ? "Saving..." : "Save"}</button>
      </form> : <button className="desktop-switcher__create" type="button" aria-disabled={Boolean(createProtection)} aria-describedby={createProtection ? "desktop-create-protection" : undefined} onClick={() => { if (!createProtection) setEditing({ mode: "create", value: `Desktop ${owned.length + 1}` }); }}><Plus size={16} /> New desktop</button>}
      {createProtection && <p id="desktop-create-protection" className="desktop-switcher__limit-note">{createProtection}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>}
  </div>;
}

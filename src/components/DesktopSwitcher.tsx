import { useEffect, useRef, useState } from "react";
import { CaretDown, Check, Desktop, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import type { DesktopIdentity } from "../types";
import { desktopDeleteProtection } from "../lib/desktop-catalog";

type Props = {
  desktops: readonly DesktopIdentity[];
  activeDesktopId: string;
  disabled?: boolean;
  onSwitch: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

export function DesktopSwitcher({ desktops, activeDesktopId, disabled, onSwitch, onCreate, onRename, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ mode: "create" | "rename"; id?: string; value: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const active = desktops.find((desktop) => desktop.id === activeDesktopId) ?? desktops[0];

  function close(returnFocus = true) {
    setOpen(false);
    setEditing(null);
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("pointerdown", onPointerDown); window.removeEventListener("keydown", onKeyDown); };
  }, [open]);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !editing.value.trim()) return;
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
    <button ref={triggerRef} className="brand-mark desktop-switcher__trigger" type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls="desktop-switcher-dialog" onClick={() => setOpen((value) => !value)}>
      <span className="brand-mark__shape"><span /></span><strong>Hiraya</strong><span className="desktop-switcher__name">{active?.name}</span><CaretDown size={13} />
    </button>
    {open && <section id="desktop-switcher-dialog" className="desktop-switcher__panel" role="dialog" aria-modal="false" aria-labelledby="desktop-switcher-title">
      <header><span id="desktop-switcher-title">Your desktops</span><button type="button" className="icon-button" onClick={() => close()} aria-label="Close desktop switcher"><X size={16} /></button></header>
      <div className="desktop-switcher__list" role="list">
        {desktops.map((desktop) => {
          const protectedReason = desktopDeleteProtection(desktops.length);
          const descriptionId = `desktop-delete-${desktop.id.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
          return <div className="desktop-switcher__row" role="listitem" key={desktop.id} data-active={desktop.id === activeDesktopId || undefined}>
          <button type="button" aria-pressed={desktop.id === activeDesktopId} onClick={() => { onSwitch(desktop.id); close(); }}>
            <Desktop size={18} weight="duotone" /><span>{desktop.name}</span>{desktop.id === activeDesktopId && <Check size={15} />}
          </button>
          <button type="button" className="icon-button" aria-label={`Rename ${desktop.name}`} onClick={() => setEditing({ mode: "rename", id: desktop.id, value: desktop.name })}><PencilSimple size={15} /></button>
          <button type="button" className="icon-button" disabled={Boolean(protectedReason)} aria-describedby={protectedReason ? descriptionId : undefined} title={protectedReason || `Delete ${desktop.name}`} aria-label={`Delete ${desktop.name}`} onClick={() => { setError(""); void onDelete(desktop.id).catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : "The desktop could not be deleted.")); }}><Trash size={15} /></button>
          {protectedReason && <span className="visually-hidden" id={descriptionId}>{protectedReason}</span>}
        </div>})}
      </div>
      {editing ? <form className="desktop-switcher__form" onSubmit={submit}>
        <label>{editing.mode === "create" ? "New desktop name" : "Rename desktop"}<input ref={inputRef} value={editing.value} maxLength={180} onChange={(event) => setEditing({ ...editing, value: event.target.value })} /></label>
        <button className="button button--primary" type="submit" disabled={submitting || !editing.value.trim()}>{submitting ? "Saving..." : "Save"}</button>
      </form> : <button className="desktop-switcher__create" type="button" onClick={() => setEditing({ mode: "create", value: `Desktop ${desktops.length + 1}` })}><Plus size={16} /> New desktop</button>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>}
  </div>;
}

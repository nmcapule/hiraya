import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

type Props = {
  label: string;
  icon: ReactNode;
  children: (dismiss: () => void) => ReactNode;
};

export function MobileHeaderMenu({ label, icon, children }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const dismiss = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const positionPanel = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const edge = 10;
    const width = Math.min(280, window.innerWidth - edge * 2);
    const spaceBelow = window.innerHeight - rect.bottom - gap - edge;
    const spaceAbove = rect.top - gap - edge;
    const openAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
    setPanelStyle({
      left: Math.min(Math.max(edge, rect.right - width), window.innerWidth - width - edge),
      ...(openAbove ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
      maxHeight: Math.max(100, openAbove ? spaceAbove : spaceBelow),
    });
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (open && !menuRef.current?.contains(event.target as Node)) dismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        triggerRef.current?.focus();
      } else if (event.key === "Tab" && open && panelRef.current) {
        const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])"));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => positionPanel();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, positionPanel]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)")?.focus());
  }, [open]);

  return (
    <div className="mobile-header-menu" ref={menuRef}>
      <button ref={triggerRef} className="mobile-header-menu__trigger" type="button" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => {
        if (open) dismiss();
        else {
          positionPanel();
          setOpen(true);
        }
      }}>{icon}</button>
      {open && <div ref={panelRef} className="mobile-header-menu__panel" role="dialog" aria-label={label} style={panelStyle}>
        {children(dismiss)}
      </div>}
    </div>
  );
}

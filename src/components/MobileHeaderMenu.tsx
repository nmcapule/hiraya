import { useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  label: string;
  icon: ReactNode;
  children: (dismiss: () => void) => ReactNode;
};

export function MobileHeaderMenu({ label, icon, children }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const dismiss = () => setOpen(false);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (open && !menuRef.current?.contains(event.target as Node)) dismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        dismiss();
        menuRef.current?.querySelector<HTMLElement>("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="mobile-header-menu" ref={menuRef}>
      <button className="mobile-header-menu__trigger" type="button" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)}>{icon}</button>
      {open && <div className="mobile-header-menu__panel" role="dialog" aria-label={label}>
        {children(dismiss)}
      </div>}
    </div>
  );
}

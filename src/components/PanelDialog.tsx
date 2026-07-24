import { useRef, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { useModalDialog } from "../ui/modal-dialog";

type Props = { title: string; onClose: () => void; children: ReactNode };

export function PanelDialog({ title, onClose, children }: Props) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useModalDialog(backdropRef, dialogRef, onClose);
  return <div ref={backdropRef} className="modal-backdrop utility-panel-backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="file-window utility-panel-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <button className="icon-button utility-panel-dialog__close" type="button" aria-label={`Close ${title}`} onClick={onClose}><X size={18} /></button>
      {children}
    </section>
  </div>;
}

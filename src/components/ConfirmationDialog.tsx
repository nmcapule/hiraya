import { useRef, useState } from "react";
import { WarningCircle, X } from "@phosphor-icons/react";
import { useModalDialog } from "../ui/modal-dialog";

export type ConfirmationRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
};

type Props = ConfirmationRequest & {
  onClose: (confirmed: boolean) => void;
};

export function ConfirmationDialog({ title, message, confirmLabel, danger = false, onClose }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useModalDialog(backdropRef, dialogRef, () => onClose(false), submitting);

  return <div ref={backdropRef} className="modal-backdrop confirmation-dialog-backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && !submitting && onClose(false)}>
    <section ref={dialogRef} className="file-dialog confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-message" tabIndex={-1}>
      <header className="window-header">
        <div><span className="window-kicker">Confirm action</span><h2 id="confirmation-title">{title}</h2></div>
        <button className="icon-button" type="button" disabled={submitting} aria-label="Close confirmation" onClick={() => onClose(false)}><X size={18} /></button>
      </header>
      <div className="confirmation-dialog__body">
        {danger && <WarningCircle size={24} weight="duotone" aria-hidden="true" />}
        <p id="confirmation-message">{message}</p>
      </div>
      <div className="dialog-actions">
        <button className="button button--quiet" type="button" autoFocus disabled={submitting} onClick={() => onClose(false)}>Cancel</button>
        <button className={`button ${danger ? "button--danger" : "button--primary"}`} type="button" disabled={submitting} onClick={() => { setSubmitting(true); onClose(true); }}>{confirmLabel}</button>
      </div>
    </section>
  </div>;
}

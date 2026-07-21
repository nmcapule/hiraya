import { ArrowClockwise, WarningCircle, X } from "@phosphor-icons/react";

type Props = {
  applying: boolean;
  blocked: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
};

export function UpdateToast({ applying, blocked, onConfirm, onDismiss }: Props) {
  return (
    <aside className="update-toast" role="region" aria-live="polite" aria-label="Hiraya update available">
      <span className="update-toast__icon" aria-hidden="true">
        {blocked ? <WarningCircle size={19} weight="fill" /> : <ArrowClockwise size={19} weight="bold" />}
      </span>
      <div className="update-toast__copy">
        <strong>{blocked ? "Save changes before updating" : "A new Hiraya version is ready"}</strong>
        <span>{blocked ? "An editor has unsaved changes. Save or discard them, then try again." : "Confirm to apply it and reload the desktop."}</span>
        <div className="update-toast__actions">
          <button className="button" type="button" disabled={applying} onClick={onConfirm}>{applying ? "Updating" : blocked ? "Try again" : "Update now"}</button>
          <button className="button button--quiet" type="button" disabled={applying} onClick={onDismiss}>Later</button>
        </div>
      </div>
      <button className="update-toast__dismiss" type="button" disabled={applying} onClick={onDismiss} aria-label="Dismiss update"><X size={14} /></button>
    </aside>
  );
}

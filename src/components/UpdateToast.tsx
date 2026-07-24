import { useId } from "react";
import { ArrowClockwise, WarningCircle, X } from "@phosphor-icons/react";

type Props = {
  applying: boolean;
  blocked: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
};

export function UpdateToast({ applying, blocked, onConfirm, onDismiss }: Props) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <aside
      className="update-toast"
      role="region"
      aria-live="polite"
      aria-atomic="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !applying) {
          event.preventDefault();
          onDismiss();
        }
      }}
    >
      <span className="update-toast__icon" aria-hidden="true">
        {blocked ? <WarningCircle size={19} weight="fill" /> : <ArrowClockwise size={19} weight="bold" />}
      </span>
      <div className="update-toast__copy">
        <strong id={titleId}>{blocked ? "Save changes before updating" : "A new Hiraya version is ready"}</strong>
        <span id={descriptionId}>{blocked ? "An editor has unsaved changes. Save or discard them, then try again." : "Confirm to apply it and reload the desktop."}</span>
        <div className="update-toast__actions">
          <button className="button button--primary" type="button" disabled={applying} onClick={onConfirm}>{applying ? "Updating" : blocked ? "Try again" : "Update now"}</button>
          <button className="button button--quiet" type="button" disabled={applying} onClick={onDismiss}>Later</button>
        </div>
      </div>
      <button className="update-toast__dismiss" type="button" disabled={applying} onClick={onDismiss} aria-label="Dismiss update notification"><X size={14} /></button>
    </aside>
  );
}

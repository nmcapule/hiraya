import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

export function useModalDialog(
  backdropRef: RefObject<HTMLElement | null>,
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  dismissDisabled = false,
) {
  const onCloseRef = useRef(onClose);
  const dismissDisabledRef = useRef(dismissDisabled);
  onCloseRef.current = onClose;
  dismissDisabledRef.current = dismissDisabled;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;

    const siblings = Array.from(backdrop.parentElement?.children ?? []).filter((element) => element !== backdrop) as HTMLElement[];
    const previousInert = siblings.map((element) => element.inert);
    siblings.forEach((element) => { element.inert = true; });

    requestAnimationFrame(() => {
      if (!dialog.contains(document.activeElement)) {
        (dialog.querySelector<HTMLElement>("[autofocus]") ?? dialog).focus();
      }
    });

    function onKeyDown(event: KeyboardEvent) {
      const topDialog = Array.from(document.querySelectorAll<HTMLElement>("[aria-modal='true']")).at(-1);
      if (topDialog !== dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!dismissDisabledRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog!.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialog!.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      siblings.forEach((element, index) => { element.inert = previousInert[index]; });
      requestAnimationFrame(() => previousFocus?.focus());
    };
  }, [backdropRef, dialogRef]);
}

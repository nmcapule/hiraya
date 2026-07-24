import { useEffect, useRef, type RefObject } from "react";
import { linearNavigationIndex } from "./keyboard-navigation";

const FOCUSABLE = "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";
type ModalEntry = { backdrop: HTMLElement; dialog: HTMLElement; previousFocus: HTMLElement | null };
const modalStack: ModalEntry[] = [];
const originalInert = new Map<HTMLElement, boolean>();
let modalObserver: MutationObserver | null = null;

function refreshModalIsolation() {
  for (const [element, inert] of originalInert) element.inert = inert;
  originalInert.clear();
  const top = modalStack.at(-1);
  if (!top) return;
  const siblings = Array.from(top.backdrop.parentElement?.children ?? []).filter((element) => element !== top.backdrop) as HTMLElement[];
  for (const sibling of siblings) {
    originalInert.set(sibling, sibling.inert);
    sibling.inert = true;
  }
}

function observeModalSiblings() {
  if (modalObserver || !document.body) return;
  modalObserver = new MutationObserver(() => refreshModalIsolation());
  modalObserver.observe(document.body, { childList: true, subtree: true });
}

function stopObservingModalSiblings() {
  if (modalStack.length) return;
  modalObserver?.disconnect();
  modalObserver = null;
}

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
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;
    const entry: ModalEntry = { backdrop, dialog, previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    modalStack.push(entry);
    observeModalSiblings();
    refreshModalIsolation();

    requestAnimationFrame(() => {
      if (modalStack.at(-1) === entry && !dialog.contains(document.activeElement)) {
        (dialog.querySelector<HTMLElement>("[autofocus]") ?? dialog).focus();
      }
    });

    function onKeyDown(event: KeyboardEvent) {
      if (modalStack.at(-1) !== entry) return;
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
        focusable[linearNavigationIndex(0, focusable.length, "ArrowUp", "vertical")]?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        focusable[linearNavigationIndex(focusable.length - 1, focusable.length, "ArrowDown", "vertical")]?.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const wasTop = modalStack.at(-1) === entry;
      const index = modalStack.indexOf(entry);
      if (index >= 0) modalStack.splice(index, 1);
      refreshModalIsolation();
      stopObservingModalSiblings();
      if (wasTop) requestAnimationFrame(() => {
        const next = modalStack.at(-1);
        if (entry.previousFocus?.isConnected && (!next || next.dialog.contains(entry.previousFocus))) entry.previousFocus.focus();
        else next?.dialog.focus();
      });
    };
  }, [backdropRef, dialogRef]);
}

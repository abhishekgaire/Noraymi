import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import "./dialog.css";

/**
 * A modal dialog over a screen (V-09, D110): a centred card on a desktop, a
 * full-height bottom sheet on a phone. The screen stays visible behind its
 * scrim. Focus moves in and is trapped; Esc (or the sheet's own Cancel) closes
 * it with no change; focus returns to whatever opened it. It's labelled by the
 * sheet's own title: a sheet inside reads `useSheetDialog` for the title's id
 * and drops its own dialog role, so there is one dialog, not two.
 *
 * It renders in place (no portal) so the offline read-only wrapper still
 * reaches its controls.
 */
const TitleId = createContext<string | null>(null);

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The dialog itself takes focus, so its title is read first; Tab moves into its fields.
    panel.current?.focus({ preventScroll: true });
    return () => {
      // Back to the trigger, when it's still on the page (a finished check-in may re-render it).
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      close.current();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (x) => x.offsetParent !== null || x === document.activeElement,
    );
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const firstItem = items[0]!;
    const lastItem = items[items.length - 1]!;
    if (
      e.shiftKey &&
      (document.activeElement === firstItem || document.activeElement === panel.current)
    ) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      firstItem.focus();
    }
  };

  return (
    <div className="dialog-scrim" onKeyDown={onKeyDown}>
      <div
        ref={panel}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <span className="dialog-grip" aria-hidden="true" />
        <TitleId.Provider value={titleId}>{children}</TitleId.Provider>
      </div>
    </div>
  );
}

/**
 * What a sheet puts on its root and its title: inside a Dialog, the title's id
 * (the dialog is labelled by it); on its own, the sheet is the dialog.
 */
export function useSheetDialog(label: string): {
  readonly root: { role?: "dialog"; "aria-label"?: string };
  readonly title: { id?: string };
} {
  const id = useContext(TitleId);
  return id
    ? { root: {}, title: { id } }
    : { root: { role: "dialog", "aria-label": label }, title: {} };
}

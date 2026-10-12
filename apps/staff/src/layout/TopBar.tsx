import { createContext, useContext, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The top bar's slot for a screen's own header items (V-04): the bar POS puts its title, the
 * signed-in staff chip, "Song queue · N" and Wipe screen in the app's top bar, beside the venue
 * and the one clock, instead of a second header row under it.
 */
export interface TopBarSlot {
  readonly node: HTMLElement | null;
  /** The screen shows who is working it (the bar computer's badge or PIN identity). */
  readonly setOwnWho: (own: boolean) => void;
}

export const TopBarContext = createContext<TopBarSlot | null>(null);

/**
 * Renders its children in the top bar. Outside the frame (a screen rendered on its own) they stay
 * where they are.
 */
export function TopBarItems({
  children,
  className,
  ownWho = false,
}: {
  children: ReactNode;
  className?: string;
  ownWho?: boolean;
}) {
  const slot = useContext(TopBarContext);
  const setOwnWho = slot?.setOwnWho;
  useEffect(() => {
    if (!setOwnWho || !ownWho) return;
    setOwnWho(true);
    return () => setOwnWho(false);
  }, [setOwnWho, ownWho]);
  const items = (
    <div className={className ? `screen-top ${className}` : "screen-top"}>{children}</div>
  );
  if (!slot) return items;
  return slot.node ? createPortal(items, slot.node) : null;
}

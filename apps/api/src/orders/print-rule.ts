/**
 * Whether accepting an order prints its bar ticket (M6-29; D99; spec 10 · Ringing, spec 09 ·
 * Tickets). Room orders always print, because a runner carries them: a guest's order from a phone
 * or room tablet, and drinks staff add to a room's check from the room tab or with Open in the bar
 * POS. Drinks the bartender rings on a bar tab or a quick sale, who pours them too, print only
 * while the venue turns on "Print tickets for drinks rung at the bar" (`pos.printBarDrinkTickets`,
 * off by default; absent reads as off). A gift (M6-24) isn't a Send: it always prints, because its
 * ticket names the singer it's for and asks for their ID at hand-off (a cautious default; M6-29 Notes).
 */
export function printsBarTicket(order: {
  /** The order's source: "room" is a guest's own order. */
  readonly source: string;
  /** The kind of check it goes on: room, bar (a bar tab), quick (a quick sale) or fee. */
  readonly checkKind: string;
  /** The venue's `pos.printBarDrinkTickets` on the order's night. */
  readonly printBarDrinkTickets: boolean | undefined;
}): boolean {
  if (order.source === "room" || order.source === "gift") return true;
  if (order.checkKind === "room") return true;
  return order.printBarDrinkTickets === true;
}

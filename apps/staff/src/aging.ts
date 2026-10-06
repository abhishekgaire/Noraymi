/**
 * Order aging on the bar screens (M6-25; Staff screens and the bar POS ·
 * Admin → Bar POS): the times come with every orders list from the venue's
 * `pos` settings, so a change in Admin shows at the next refresh. West 4's
 * values stand in until the first list arrives.
 */
export interface Aging {
  readonly phones_sec: number;
  readonly amber_sec: number;
  readonly pink_sec: number;
  readonly call_sec: number;
  readonly chime: boolean;
  readonly mute_sec: number;
}

export const WEST4_AGING: Aging = {
  phones_sec: 30,
  amber_sec: 120,
  pink_sec: 240,
  call_sec: 360,
  chime: true,
  mute_sec: 60,
};

/** An order's color at this age: pink, amber, or neither yet. */
export function agingTone(ageSec: number, a: Aging): "pink" | "amber" | null {
  if (ageSec >= a.pink_sec) return "pink";
  if (ageSec >= a.amber_sec) return "amber";
  return null;
}

const minutes = (sec: number) => String(Math.round((sec / 60) * 10) / 10);

/** The escalation sentence's numbers (glossary · the escalation sentence), and which wording to use. */
export function agingSentence(a: {
  phonesSec: number;
  amberSec: number;
  pinkSec: number;
  callSec: number;
  chime: boolean;
}): { key: "barOrders.footer" | "barOrders.footerNoChime"; params: Record<string, string> } {
  return {
    key: a.chime ? "barOrders.footer" : "barOrders.footerNoChime",
    params: {
      amber: minutes(a.amberSec),
      pink: minutes(a.pinkSec),
      phones: String(a.phonesSec),
      call: minutes(a.callSec),
    },
  };
}

export const agingFromWire = (a: Aging) => ({
  phonesSec: a.phones_sec,
  amberSec: a.amber_sec,
  pinkSec: a.pink_sec,
  callSec: a.call_sec,
  chime: a.chime,
});

/**
 * The room-order state machine (M3-06; spec 04 · Room orders; Money rules 6).
 * ringing → held (optional) → accepted → ready → on_the_way → delivered, with
 * returned and cancelled as the side exits. Each step is checked against the
 * one before it, so a held order still needs Accept and can never be marked
 * ready or delivered first. Accept is the sale; delivered never charges.
 * `resolve` settles a returned order as a void (it stays returned); `remake`
 * sends it back to accepted with a new ticket.
 */
export const ORDER_STATUSES = [
  "ringing",
  "held",
  "accepted",
  "ready",
  "on_the_way",
  "delivered",
  "returned",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STEPS = [
  "hold",
  "accept",
  "decline",
  "cancel",
  "ready",
  "claim",
  "deliver",
  "return",
  "resolve",
  "remake",
] as const;
export type OrderStep = (typeof ORDER_STEPS)[number];

const MOVES: Record<
  OrderStep,
  { from: readonly OrderStatus[]; to: OrderStatus | "same"; needs: string }
> = {
  hold: { from: ["ringing"], to: "held", needs: "it can only be asked to wait while it's ringing" },
  accept: {
    from: ["ringing", "held"],
    to: "accepted",
    needs: "it can only be accepted while it's ringing or held",
  },
  decline: {
    from: ["ringing", "held"],
    to: "cancelled",
    needs: "it can only be declined while it's ringing or held",
  },
  cancel: {
    from: ["ringing", "held"],
    to: "cancelled",
    needs: "it can only be cancelled while it's ringing or held",
  },
  ready: {
    from: ["accepted"],
    to: "ready",
    needs: "it needs Accept before it can be marked ready",
  },
  claim: { from: ["ready"], to: "on_the_way", needs: "a runner can only take it once it's ready" },
  deliver: {
    from: ["ready", "on_the_way"],
    to: "delivered",
    needs: "it can only be delivered once it's ready",
  },
  return: {
    from: ["ready", "on_the_way"],
    to: "returned",
    needs: "only an order on its way can come back",
  },
  resolve: { from: ["returned"], to: "same", needs: "only a returned order can be resolved" },
  remake: { from: ["returned"], to: "accepted", needs: "only a returned order can be remade" },
};

export type StepResult =
  { readonly ok: true; readonly to: OrderStatus } | { readonly ok: false; readonly why: string };

export function orderStep(from: OrderStatus, step: OrderStep): StepResult {
  const move = MOVES[step];
  if (!move.from.includes(from)) return { ok: false, why: `the order is ${from}; ${move.needs}` };
  return { ok: true, to: move.to === "same" ? from : move.to };
}

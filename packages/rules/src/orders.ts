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

/**
 * Picked up (K-06; Kitchen and food · Runners and delivery): the runner's one tap at the kitchen
 * records Ready and I've got it together, so a food order goes from accepted to on its way. Only a
 * room's food has a run (bar-tab and quick-sale food is taken by name, with no run), and staff-rung
 * food has none until Send to kitchen prints it. Each refusal says why.
 */
export type PickUpResult =
  | { readonly ok: true; readonly to: "on_the_way" }
  | {
      readonly ok: false;
      readonly reason: "not_food" | "no_run" | "not_sent" | "status";
      readonly why: string;
    };

export function pickUpStep(order: {
  readonly status: OrderStatus;
  readonly station: string;
  /** The order is for a room (a session), so a runner carries it. */
  readonly hasRun: boolean;
  /** Its kitchen ticket has printed: at Accept for a guest's food, at Send to kitchen for staff's. */
  readonly sentToKitchen: boolean;
}): PickUpResult {
  if (order.station !== "kitchen")
    return { ok: false, reason: "not_food", why: "only food is picked up at the kitchen" };
  if (!order.hasRun)
    return {
      ok: false,
      reason: "no_run",
      why: "food for a bar tab or a quick sale has no run: a server takes it by the name on the ticket",
    };
  if (order.status !== "accepted")
    return {
      ok: false,
      reason: "status",
      why: `the order is ${order.status}; it can only be picked up once it's accepted and in the kitchen`,
    };
  if (!order.sentToKitchen)
    return {
      ok: false,
      reason: "not_sent",
      why: "this food isn't sent to the kitchen yet: Send to kitchen first",
    };
  return { ok: true, to: "on_the_way" };
}

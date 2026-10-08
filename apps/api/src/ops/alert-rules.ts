/**
 * Every alert rule (M8-17; spec 13 · Watching production; spec 09 · Heartbeats). A rule either
 * pages us (our on-call rota, escalating after 10 minutes) or tells the venue's manager; only a
 * target burning or money at risk pages us. Each rule names its runbook in docs/runbooks/, and a
 * test checks that every one exists.
 *
 * `clears` says when a page is over: `condition` when the check stops finding it (and it can fire
 * again later), `ack` when someone acknowledges it (one page per key, ever: a payout, a failover).
 * `source` says where it is raised: the alert sweep, a CloudWatch alarm or RDS event through the
 * alarm hook, the device watch (M1-16) for the manager's alerts, the synthetic check (M8-18), a
 * sign-in (M8-19), or a CI workflow publishing to the pages topic (M8-19: the payment page check).
 */
export type AlertAudience = "us" | "manager";
export type AlertSource = "sweep" | "cloudwatch" | "devices" | "synthetic" | "signin" | "ci";

export interface AlertRule {
  readonly id: string;
  readonly title: string;
  readonly audience: AlertAudience;
  readonly clears: "condition" | "ack";
  readonly sources: readonly AlertSource[];
  readonly runbook: string;
}

const rule = (r: Omit<AlertRule, "runbook"> & { runbook?: string }): AlertRule => ({
  ...r,
  runbook: r.runbook ?? `docs/runbooks/${r.id}.md`,
});

export const ALERT_RULES = [
  rule({
    id: "payment-failures",
    title: "Card payments failing on our side",
    audience: "us",
    clears: "condition",
    sources: ["sweep"],
  }),
  rule({
    id: "capture-sweep-failed",
    title: "The hold watch couldn't capture a tab",
    audience: "us",
    clears: "condition",
    sources: ["sweep"],
  }),
  rule({
    id: "money-dead-letters",
    title: "Money jobs in the dead-letter queue",
    audience: "us",
    clears: "condition",
    sources: ["sweep"],
  }),
  rule({
    id: "db-failover",
    title: "The database failed over",
    audience: "us",
    clears: "ack",
    sources: ["cloudwatch"],
  }),
  rule({
    id: "webhook-lag",
    title: "Stripe webhooks waiting over a minute",
    audience: "us",
    clears: "condition",
    sources: ["sweep"],
  }),
  rule({
    id: "payout-unreconciled",
    title: "A payout doesn't reconcile",
    audience: "us",
    clears: "ack",
    sources: ["sweep"],
  }),
  rule({
    id: "target-burn",
    title: "A published target is burning its error budget",
    audience: "us",
    clears: "condition",
    sources: ["sweep", "cloudwatch"],
  }),
  rule({
    id: "readers-offline",
    title: "Every card reader at a venue is offline during opening hours",
    audience: "us",
    clears: "condition",
    sources: ["sweep"],
  }),
  rule({
    id: "synthetic-check",
    title: "The synthetic order or reader payment failed (M8-18)",
    audience: "us",
    clears: "condition",
    sources: ["synthetic"],
  }),
  rule({
    id: "signin-new-country",
    title: "A sign-in from a country the person hasn't signed in from before (M8-19)",
    audience: "us",
    clears: "ack",
    sources: ["signin"],
  }),
  rule({
    id: "decline-rate",
    title: "A burst of declined cards on a venue's booking page (M8-19)",
    audience: "us",
    clears: "condition",
    sources: ["sweep"],
  }),
  rule({
    id: "refund-spike",
    title: "A spike of refunds at a venue (M8-19)",
    audience: "us",
    clears: "condition",
    sources: ["sweep"],
  }),
  rule({
    id: "pay-page-check",
    title: "The payment page's script and header check failed (M4-15, M8-19)",
    audience: "us",
    clears: "condition",
    sources: ["ci"],
  }),
  rule({
    id: "device-offline",
    title: "A device went quiet (device.offline)",
    audience: "manager",
    clears: "condition",
    sources: ["devices"],
  }),
  rule({
    id: "venue-offline",
    title: "The whole venue went quiet (venue.offline)",
    audience: "manager",
    clears: "condition",
    sources: ["devices"],
  }),
  rule({
    id: "test-page",
    title: "A test page",
    audience: "us",
    clears: "ack",
    sources: [],
    runbook: "docs/runbooks/on-call.md",
  }),
] as const satisfies readonly AlertRule[];

export type AlertRuleId = (typeof ALERT_RULES)[number]["id"];

export function alertRule(id: string): AlertRule | null {
  return ALERT_RULES.find((r) => r.id === id) ?? null;
}

/** A page nobody acknowledges within this many minutes goes to the second responder (spec 13). */
export const ESCALATE_AFTER_MINUTES = 10;

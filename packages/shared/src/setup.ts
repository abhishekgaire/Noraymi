/**
 * Set up your venue's checklist (O-02; spec 17 · The steps, What's required
 * before Ready to open). Pure: the API reads the facts from the rows each
 * step saves to and this works out every step's mark, so the wizard, Admin →
 * Setup and the Console's venue list always say the same thing.
 */
export const SETUP_STEPS = [
  "venue",
  "plan",
  "card",
  "rooms",
  "hours",
  "deposits",
  "money",
  "menu",
  "team",
  "licenses",
  "texts",
  "devices",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const isSetupStep = (s: unknown): s is SetupStep =>
  typeof s === "string" && (SETUP_STEPS as readonly string[]).includes(s);

export type SetupPlan = "bar" | "rooms" | "rooms_kitchen";

/**
 * done: everything the step needs is saved. attention: some of it is, or a
 * saved answer stopped holding (a contact deactivated). skipped: the owner
 * pressed Skip for now. not_used: the plan doesn't use the step (Bar has no
 * rooms). not_started: nothing saved yet.
 */
export type SetupMark = "done" | "attention" | "skipped" | "not_used" | "not_started";

/** What each step needs, as facts read from the rows. */
export interface SetupFacts {
  /** The started plan, or null before one is chosen. */
  readonly plan: SetupPlan | null;
  readonly venue: {
    readonly name: boolean;
    readonly legalName: boolean;
    readonly address: boolean;
    readonly guestPhone: boolean;
  };
  readonly planStarted: boolean;
  readonly card: { readonly connected: boolean; readonly cardPaymentsOn: boolean };
  readonly rooms: { readonly roomWithCapacity: boolean; readonly roomRate: boolean };
  readonly hours: { readonly hours: boolean; readonly agePolicy: boolean };
  readonly deposits: { readonly rule: boolean; readonly walkIn: boolean };
  readonly money: { readonly saved: boolean };
  readonly menu: { readonly pricedItem: boolean };
  readonly team: {
    readonly managerWithPin: boolean;
    readonly firstOnCall: boolean;
    readonly breachContact: boolean;
  };
  readonly licenses: { readonly liquor: boolean };
  readonly texts: { readonly answered: boolean };
  readonly devices: {
    readonly reader: boolean;
    readonly receiptPrinterWithDrawer: boolean;
    readonly merchantCategory: boolean;
  };
  /** Steps the owner pressed Skip for now on. */
  readonly skipped: readonly SetupStep[];
}

const ROOMS_ONLY: readonly SetupStep[] = ["rooms", "deposits"];
const OPTIONAL: readonly SetupStep[] = ["money", "texts"];

/**
 * The steps that must be done before Ready to open. Before a plan is chosen
 * the Rooms plans' list applies (the longer one): a step drops off only once
 * the owner's plan says it isn't used.
 */
export function requiredSteps(plan: SetupPlan | null): SetupStep[] {
  return SETUP_STEPS.filter(
    (s) => !OPTIONAL.includes(s) && !(plan === "bar" && ROOMS_ONLY.includes(s)),
  );
}

/** Steps the plan doesn't use: skipped by themselves, with the reason shown. */
export function unusedSteps(plan: SetupPlan | null): SetupStep[] {
  return plan === "bar" ? [...ROOMS_ONLY] : [];
}

/** What is still missing in a step, as message-key suffixes (setup.missing.<key>). */
function missingIn(step: SetupStep, f: SetupFacts): string[] {
  const out: string[] = [];
  const need = (ok: boolean, key: string) => {
    if (!ok) out.push(key);
  };
  switch (step) {
    case "venue":
      need(f.venue.name, "venueName");
      need(f.venue.legalName, "legalName");
      need(f.venue.address, "address");
      need(f.venue.guestPhone, "guestPhone");
      break;
    case "plan":
      need(f.planStarted, "plan");
      break;
    case "card":
      need(f.card.connected, "stripe");
      if (f.card.connected) need(f.card.cardPaymentsOn, "stripeMore");
      break;
    case "rooms":
      need(f.rooms.roomWithCapacity, "room");
      need(f.rooms.roomRate, "roomRate");
      break;
    case "hours":
      need(f.hours.hours, "hours");
      need(f.hours.agePolicy, "agePolicy");
      break;
    case "deposits":
      need(f.deposits.rule, "depositRule");
      need(f.deposits.walkIn, "walkIn");
      break;
    case "money":
      need(f.money.saved, "money");
      break;
    case "menu":
      need(f.menu.pricedItem, "menuItem");
      break;
    case "team":
      need(f.team.managerWithPin, "manager");
      need(f.team.firstOnCall, "onCall");
      need(f.team.breachContact, "breach");
      break;
    case "licenses":
      need(f.licenses.liquor, "liquor");
      break;
    case "texts":
      need(f.texts.answered, "texts");
      break;
    case "devices":
      need(f.devices.reader, "reader");
      need(f.devices.receiptPrinterWithDrawer, "receiptPrinter");
      need(f.devices.merchantCategory, "merchantCategory");
      break;
  }
  return out;
}

/** How many things a step asks for, to tell "some saved" (attention) from "nothing yet". */
const PARTS: Record<SetupStep, number> = {
  venue: 4,
  plan: 1,
  card: 2,
  rooms: 2,
  hours: 2,
  deposits: 2,
  money: 1,
  menu: 1,
  team: 3,
  licenses: 1,
  texts: 1,
  devices: 3,
};

export interface SetupStepState {
  readonly id: SetupStep;
  readonly number: number;
  readonly mark: SetupMark;
  readonly required: boolean;
  readonly missing: readonly string[];
}

export interface SetupChecklist {
  readonly steps: readonly SetupStepState[];
  /** Steps done, plus those the plan doesn't use: "N of 12 done". */
  readonly done: number;
  readonly total: number;
  /** Every required step done: Ready to open, and Finish setup can be pressed. */
  readonly ready: boolean;
  /** The required steps not done yet, in order: "Needed before you open". */
  readonly blocking: readonly SetupStep[];
  /** Where signing in opens the wizard: the first step not done, skipped or unused; null when none. */
  readonly next: SetupStep | null;
}

export function setupChecklist(f: SetupFacts): SetupChecklist {
  const required = requiredSteps(f.plan);
  const unused = unusedSteps(f.plan);
  const steps = SETUP_STEPS.map((id, i): SetupStepState => {
    const missing = missingIn(id, f);
    // The card step's two parts: connecting makes it attention until card payments are on.
    const partsMissing = id === "card" && !f.card.connected ? 2 : missing.length;
    let mark: SetupMark;
    if (unused.includes(id)) mark = "not_used";
    else if (missing.length === 0) mark = "done";
    else if (f.skipped.includes(id)) mark = "skipped";
    else if (partsMissing < PARTS[id]) mark = "attention";
    else mark = "not_started";
    return { id, number: i + 1, mark, required: required.includes(id), missing };
  });
  const blocking = steps.filter((s) => s.required && s.mark !== "done").map((s) => s.id);
  const next = steps.find((s) => s.mark === "not_started" || s.mark === "attention")?.id ?? null;
  return {
    steps,
    done: steps.filter((s) => s.mark === "done" || s.mark === "not_used").length,
    total: SETUP_STEPS.length,
    ready: blocking.length === 0,
    blocking,
    next,
  };
}

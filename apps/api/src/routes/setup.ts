import type { FastifyInstance, FastifyRequest } from "fastify";
import { stripeAccountOf, stripeIntegration, venueSubscription, type Queryable } from "@west4/db";
import {
  isSetupStep,
  setupChecklist,
  type SetupChecklist,
  type SetupFacts,
  type SetupPlan,
  type Clock,
} from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { merchantCategoryPasses } from "../payments/go-live.js";

/**
 * Set up your venue (O-02; spec 17 · How it behaves, What's required before
 * Ready to open). `GET /setup` reads every step's facts from the rows the
 * step saves to (never a copy of its own) and works out the marks with the
 * shared checklist, so the wizard, Admin → Setup and the Console agree.
 * Only the venue's owners run it: a manager reads it. Skip for now is kept
 * per step until the step's rows make it done; Finish setup stamps
 * `venues.setup_completed_at` once every required step is done. The modules
 * the owner ticks are turned on afterwards through `PATCH /modules/{id}`.
 */
interface VenueParams {
  venueId: string;
}

const ACTIVE_PLAN = ["active", "trialing", "past_due"];

/** A settings key has a saved version (the step's answer exists). */
const saved = async (c: Queryable, venueId: string, key: string) =>
  (
    await c.query("select 1 from venue_settings where venue_id = $1 and key = $2 limit 1", [
      venueId,
      key,
    ])
  ).rowCount! > 0;

/** The newest saved value of a settings key, whatever its schema (contacts arrives with O-03 and O-11). */
const latest = async (c: Queryable, venueId: string, key: string) =>
  (
    await c.query<{ value: Record<string, unknown> }>(
      "select value from venue_settings where venue_id = $1 and key = $2 order by version desc limit 1",
      [venueId, key],
    )
  ).rows[0]?.value ?? null;

export async function setupFacts(c: Queryable, venueId: string): Promise<SetupFacts> {
  const venue = (
    await c.query<{ name: string; address: unknown; legal_name: string | null }>(
      `select v.name, v.address, o.legal_name from venues v join organizations o on o.id = v.org_id
        where v.id = $1`,
      [venueId],
    )
  ).rows[0];
  const sub = await venueSubscription(c, venueId);
  const plan: SetupPlan | null =
    sub && ACTIVE_PLAN.includes(sub.status) ? (sub.plan as SetupPlan) : null;
  const account = await stripeAccountOf(c, venueId);
  const stripe = account ? await stripeIntegration(c, venueId) : null;
  const one = async (sql: string) => (await c.query(sql, [venueId])).rowCount! > 0;
  const deposit = await latest(c, venueId, "deposit");
  const contacts = (await latest(c, venueId, "contacts")) as {
    onCall?: { first?: { membershipId?: string } | null };
    breach?: { primary?: string | null };
  } | null;
  const activeLead = async (membershipId: string | null | undefined) =>
    !!membershipId &&
    (
      await c.query(
        `select 1 from memberships where venue_id = $1 and id::text = $2
            and role in ('owner', 'manager') and status = 'active'`,
        [venueId, membershipId],
      )
    ).rowCount! > 0;
  const skips = await c.query<{ step: string }>(
    "select step from venue_setup_skips where venue_id = $1",
    [venueId],
  );
  return {
    plan,
    venue: {
      name: !!venue?.name,
      legalName: !!venue?.legal_name,
      address: venue?.address !== null && venue?.address !== undefined,
      guestPhone: await saved(c, venueId, "phone"),
    },
    planStarted: plan !== null,
    card: { connected: !!account, cardPaymentsOn: stripe?.card_payments === "active" },
    rooms: {
      roomWithCapacity: await one(
        "select 1 from rooms where venue_id = $1 and archived_at is null and capacity_max >= 1",
      ),
      roomRate: await saved(c, venueId, "prices"),
    },
    hours: {
      hours: await saved(c, venueId, "hours"),
      agePolicy: await saved(c, venueId, "safety"),
    },
    deposits: {
      rule: deposit !== null,
      walkIn: deposit !== null && typeof deposit["walkIn"] === "string",
    },
    money: { saved: (await saved(c, venueId, "pay")) || (await saved(c, venueId, "drawer")) },
    menu: {
      pricedItem: await one(
        `select 1 from menu_items i join menu_variants v on v.venue_id = i.venue_id and v.item_id = i.id
          where i.venue_id = $1 and i.shown and v.price_cents > 0`,
      ),
    },
    team: {
      managerWithPin: await one(
        `select 1 from memberships where venue_id = $1 and role = 'manager' and status = 'active'
            and pin_verifier is not null`,
      ),
      firstOnCall: await activeLead(contacts?.onCall?.first?.membershipId),
      breachContact: await activeLead(contacts?.breach?.primary),
    },
    licenses: {
      liquor: await one("select 1 from licenses where venue_id = $1 and kind = 'liquor'"),
    },
    texts: {
      answered: await one("select 1 from integrations where venue_id = $1 and kind = 'twilio'"),
    },
    devices: {
      reader: await one(
        "select 1 from devices where venue_id = $1 and kind = 'reader' and revoked_at is null",
      ),
      receiptPrinterWithDrawer: await one(
        `select 1 from cash_drawers d join devices p on p.venue_id = d.venue_id and p.id = d.printer_device_id
          where d.venue_id = $1 and p.revoked_at is null`,
      ),
      merchantCategory: await merchantCategoryPasses(c, venueId),
    },
    skipped: skips.rows.map((r) => r.step).filter(isSetupStep),
  };
}

export interface SetupAnswer {
  readonly checklist: SetupChecklist;
  readonly plan: SetupPlan | null;
  /** Made through the Console's New venue (O-01); a seeded venue never needs the wizard. */
  readonly onboarded: boolean;
  readonly completed_at: string | null;
}

export async function setupAnswer(c: Queryable, venueId: string): Promise<SetupAnswer> {
  const facts = await setupFacts(c, venueId);
  const v = (
    await c.query<{ completed_at: string | null; onboarded: boolean }>(
      `select to_json(setup_completed_at) #>> '{}' as completed_at,
              exists (select 1 from venue_onboarding o where o.venue_id = v.id) as onboarded
         from venues v where v.id = $1`,
      [venueId],
    )
  ).rows[0]!;
  return {
    checklist: setupChecklist(facts),
    plan: facts.plan,
    onboarded: v.onboarded,
    completed_at: v.completed_at,
  };
}

/** Only the venue's owners run the wizard (spec 17 · Who runs it); a manager reads it. */
function ownerHere(request: FastifyRequest): { venueId: string; userId: string } {
  const venueId = request.venueId!;
  const p = request.principal;
  const here = p.kind === "user" ? p.memberships.find((m) => m.venueId === venueId) : undefined;
  if (p.kind !== "user" || here?.role !== "owner")
    throw new ApiError("forbidden", "only the venue's owner sets up the venue");
  return { venueId, userId: p.userId };
}

export function setupRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
  });
  const write = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
    idempotency: "optional",
  });

  app.get<{ Params: VenueParams }>("/v1/venues/:venueId/setup", { config: read }, async (request) =>
    request.inVenue((c) => setupAnswer(c, request.venueId!)),
  );

  app.post<{ Params: VenueParams; Body: { step?: unknown } }>(
    "/v1/venues/:venueId/setup/skip",
    { config: write },
    async (request) => {
      const { venueId, userId } = ownerHere(request);
      const step = request.body?.step;
      if (!isSetupStep(step)) throw new ApiError("invalid_request", "send { step }");
      return request.inVenue(async (c) => {
        await c.query(
          `insert into venue_setup_skips (venue_id, step, skipped_by) values ($1, $2, $3)
             on conflict (venue_id, step) do nothing`,
          [venueId, step, userId],
        );
        return setupAnswer(c, venueId);
      });
    },
  );

  app.post<{ Params: VenueParams }>(
    "/v1/venues/:venueId/setup/finish",
    { config: write },
    async (request) => {
      const { venueId } = ownerHere(request);
      return request.inVenue(async (c) => {
        const answer = await setupAnswer(c, venueId);
        if (!answer.checklist.ready)
          throw new ApiError("invalid_request", "some steps are needed before you open", {
            status: 409,
            details: { missing: answer.checklist.blocking },
          });
        await c.query(
          "update venues set setup_completed_at = coalesce(setup_completed_at, $2) where id = $1",
          [venueId, options.clock.now().toString()],
        );
        return setupAnswer(c, venueId);
      });
    },
  );
}

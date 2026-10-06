import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { reconcileNight } from "./night.js";
import { playNight, type NightClient } from "./runner.js";
import { loadConfig } from "../config.js";
import "../payments/webhooks.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * The night runner and the reconcile script in CI's one-night compressed mode (M7-19): the demo seed's
 * Friday played to its close through the API only, then reconciled to the cent. Runs with the integration
 * suite on every merge, so any money change that breaks a figure fails here, naming the night and rule.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;

type Role = "owner" | "manager" | "bartender" | "front_desk";
interface Who {
  slug: string;
  role: Role;
  session: SessionKind;
  device: string;
  deviceKind: "bar_computer" | "front_desk" | "staff_phone";
}
let who: Who;
const as = (slug: string, role: Role, session: SessionKind, device: string) => {
  who = {
    slug,
    role,
    session,
    device,
    deviceKind: device.startsWith("dev_phone")
      ? "staff_phone"
      : device === "dev_bar_computer"
        ? "bar_computer"
        : "front_desk",
  };
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  const memberships = Object.fromEntries(
    (
      await owner.query<{ user_id: string; id: string }>(
        "select user_id, id from memberships where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.user_id, r.id]),
  );
  as("andy", "manager", "passkey", "dev_phone_andy");
  api = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
    }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request: FastifyRequest): Promise<Principal> => {
        const userId = ids[who.slug]!;
        const deviceId = ids[who.device]!;
        Object.assign(request, {
          session: {
            assurance: who.session,
            membershipId: memberships[userId],
            deviceId,
          },
          signedDevice: { deviceId, venueId, kind: who.deviceKind },
        });
        return {
          kind: "user",
          userId,
          session: who.session,
          memberships: [{ venueId, membershipId: memberships[userId]!, role: who.role }],
        };
      },
    ],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

const client: NightClient = {
  async call(actor, method, path, body) {
    as(actor.who, actor.role, actor.session, actor.device);
    const r = await api.inject({
      method,
      url: `/v1/venues/${venueId}${path}`,
      headers: { "idempotency-key": `run-${++n}` },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: r.statusCode, json: r.body ? (r.json() as Record<string, unknown>) : {} };
  },
  async setClock(iso) {
    clock.set(Temporal.Instant.from(iso));
  },
};

describe("a night, played and reconciled", () => {
  it("plays the seed's Friday to its close through the API and reconciles it to the cent", async () => {
    const steps = await playNight(client, "2026-09-25");
    expect(steps.at(-1)).toEqual({ step: "close", status: 200 });
    const result = await withVenue(app, { venueId }, (c) =>
      reconcileNight(c, venueId, "2026-09-25", clock.now()),
    );
    expect(result.differences).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toEqual([
      "z_report",
      "drawers",
      "tip_ledger",
      "tip_pool",
      "payouts",
      "journals",
      "practice",
    ]);
  });

  it("names the night and the rule when a cent is off", async () => {
    // A drawer move written behind the count's back: its expected cash no longer matches.
    const s = (
      await owner.query<{ id: string }>(
        "select s.id from drawer_sessions s join cash_drawers d on d.id = s.drawer_id where d.name = 'Bar drawer' and s.business_date = '2026-09-25' limit 1",
      )
    ).rows[0]!.id;
    await owner.query(
      "insert into drawer_moves (venue_id, drawer_session_id, kind, amount_cents, taken_by, at) values ($1, $2, 'paid_out', 1, $3, now())",
      [venueId, s, ids["andy"]],
    );
    const result = await withVenue(app, { venueId }, (c) =>
      reconcileNight(c, venueId, "2026-09-25", clock.now()),
    );
    expect(result.ok).toBe(false);
    // Its stored expected cash and its count both disagree with the moves now: each named.
    expect(result.differences.length).toBeGreaterThan(0);
    for (const d of result.differences)
      expect(d).toMatchObject({ rule: "drawers", night: "2026-09-25" });
  });
});

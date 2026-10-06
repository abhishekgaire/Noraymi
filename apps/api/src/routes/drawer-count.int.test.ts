import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  managerOnDuty,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * Blind drawer counts and the house drawers' handover (M7-05; Money rules 15;
 * spec 08 · Drawer): who may count which drawer, the PIN again after a badge
 * tap, the note and the second counter, and the handover accepted only on the
 * incoming manager's own phone.
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
const post = (path: string, payload?: unknown) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": `drawer-${++n}` },
    ...(payload ? { payload } : {}),
  });
const get = (path: string) => api.inject({ method: "GET", url: `/v1/venues/${venueId}${path}` });

interface PanelSession {
  id: string;
  state: string;
  opened_with_cents: number;
  responsible: string | null;
  waiting_for: string | null;
  accepted: boolean;
  count: { counted_cents: number; expected_cents: number; over_short_cents: number } | null;
  expected_cents?: number;
  cash_taken_cents?: number;
}
interface Panel {
  handover: { waiting_for: { name: string } } | null;
  drawers: { id: string; name: string; can_count: boolean; sessions: PanelSession[] }[];
}
const panel = async () => (await get("/drawers")).json() as Panel;
const openSession = async (name: string) =>
  (await panel()).drawers.find((d) => d.name === name)!.sessions.find((s) => s.state === "open")!;

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

describe("drawer counts and the handover", () => {
  it("opens both drawers with $300.00 for Fri Sep 25, each answered for by Andy, blind", async () => {
    const p = await panel();
    expect(p.drawers.map((d) => d.name)).toEqual(["Bar drawer", "Front-desk drawer"]);
    for (const d of p.drawers) {
      expect(d.sessions).toHaveLength(1);
      expect(d.sessions[0]).toMatchObject({
        state: "open",
        opened_with_cents: 30000,
        responsible: "Andy C.",
        count: null,
      });
      expect(d.sessions[0]).not.toHaveProperty("expected_cents");
      expect(d.sessions[0]).not.toHaveProperty("cash_taken_cents");
    }
  });

  it("hands both drawers from Andy to Abhishek, counted blind, and waits on Abhishek's phone", async () => {
    as("andy", "manager", "passkey", "dev_phone_andy");
    const bar = (await panel()).drawers.find((d) => d.name === "Bar drawer")!;
    const front = (await panel()).drawers.find((d) => d.name === "Front-desk drawer")!;
    const r1 = await post(`/drawers/${bar.id}/handover`, {
      incoming: ids["abhishek"],
      counted_cents: 30000,
    });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({
      expected_cents: 30000,
      counted_cents: 30000,
      over_short_cents: 0,
      handover: { waiting_for: { name: "Abhishek G." } },
    });
    const r2 = await post(`/drawers/${front.id}/handover`, {
      incoming: ids["abhishek"],
      counted_cents: 30000,
    });
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json().handover.id).toBe(r1.json().handover.id);

    const p = await panel();
    expect(p.handover?.waiting_for.name).toBe("Abhishek G.");
    for (const d of p.drawers) {
      expect(d.sessions.map((s) => s.state)).toEqual(["open", "closed"]);
      expect(d.sessions[0]).toMatchObject({
        opened_with_cents: 30000,
        responsible: "Abhishek G.",
        waiting_for: "Abhishek G.",
        accepted: false,
      });
      expect(d.sessions[1]!.count).toMatchObject({ counted_cents: 30000, expected_cents: 30000 });
    }

    // Not on Andy's device, not by Andy: only Abhishek, on his own phone.
    const approvalId = r1.json().handover.approval_id as string;
    expect(
      (await post(`/approvals/${approvalId}/decide`, { decision: "approve" })).statusCode,
    ).toBe(403);
    as("abhishek", "owner", "passkey", "dev_phone_andy");
    expect(
      (await post(`/approvals/${approvalId}/decide`, { decision: "approve" })).statusCode,
    ).toBe(403);
    as("abhishek", "owner", "passkey", "dev_phone_abhishek");
    const ok = await post(`/approvals/${approvalId}/decide`, { decision: "approve" });
    expect(ok.statusCode, ok.body).toBe(200);

    const after = await panel();
    expect(after.handover).toBeNull();
    for (const d of after.drawers)
      expect(d.sessions[0]).toMatchObject({ accepted: true, waiting_for: null });
    expect(await withVenue(app, { venueId }, (c) => managerOnDuty(c, venueId))).toBe(
      ids["abhishek"],
    );
  });

  it("lets Maya count only the bar drawer, Diego only the front desk, and asks for the PIN again after a badge tap", async () => {
    const bar = await openSession("Bar drawer");
    const front = await openSession("Front-desk drawer");
    as("maya", "bartender", "badge", "dev_bar_computer");
    expect(
      (await post(`/drawer-sessions/${front.id}/count`, { counted_cents: 1 })).statusCode,
    ).toBe(403);
    const noPin = await post(`/drawer-sessions/${bar.id}/count`, { counted_cents: 30000 });
    expect(noPin.statusCode).toBe(400);
    expect(noPin.json().error.details.reason).toBe("pin");
    expect(
      (await post(`/drawer-sessions/${bar.id}/count`, { counted_cents: 30000, pin: "0000" }))
        .statusCode,
    ).toBe(401);
    // Blind: nothing about what it should hold until the count is in.
    expect(await openSession("Bar drawer")).toMatchObject({ count: null });
    const counted = await post(`/drawer-sessions/${bar.id}/count`, {
      counted_cents: 30000,
      pin: "4071",
    });
    expect(counted.statusCode, counted.body).toBe(200);
    expect(counted.json()).toMatchObject({
      drawer: "Bar drawer",
      opened_with_cents: 30000,
      expected_cents: 30000,
      counted_cents: 30000,
      over_short_cents: 0,
    });
    as("diego", "front_desk", "pin", "dev_front_computer");
    expect((await post(`/drawer-sessions/${bar.id}/count`, { counted_cents: 1 })).statusCode).toBe(
      403,
    );
  });

  it("refuses a count $25.00 short without a note, then without a second counter, and keeps the first number", async () => {
    const front = await openSession("Front-desk drawer");
    as("diego", "front_desk", "pin", "dev_front_computer");
    const short = { counted_cents: 27500, pin: "6358" };
    const r1 = await post(`/drawer-sessions/${front.id}/count`, short);
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.details).toMatchObject({
      reason: "note",
      answer: { expected_cents: 30000, over_short_cents: -2500 },
    });
    // The count stands: a different number now is refused.
    expect(
      (await post(`/drawer-sessions/${front.id}/count`, { ...short, counted_cents: 30000 }))
        .statusCode,
    ).toBe(409);
    const r2 = await post(`/drawer-sessions/${front.id}/count`, {
      ...short,
      note: "Twenty short in the till",
    });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.details.reason).toBe("witness");
    // The second counter signs in with their own PIN; a wrong one is refused.
    expect(
      (
        await post(`/drawer-sessions/${front.id}/count`, {
          ...short,
          note: "Twenty short in the till",
          witness: { user_id: ids["andy"], pin: "000000" },
        })
      ).statusCode,
    ).toBe(401);
    const ok = await post(`/drawer-sessions/${front.id}/count`, {
      ...short,
      note: "Twenty short in the till",
      witness: { user_id: ids["andy"], pin: "730915" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ over_short_cents: -2500, witness_id: ids["andy"] });
    const s = (await panel()).drawers.find((d) => d.name === "Front-desk drawer")!.sessions[0]!;
    expect(s).toMatchObject({
      state: "counted",
      count: { counted_cents: 27500, over_short_cents: -2500, note: "Twenty short in the till" },
    });
    expect(s.count).toMatchObject({ counted_by: "Diego R.", witness: "Andy C." });
  });

  it("starts a drawer per person on Sat Sep 26 and keeps tonight's house drawers", async () => {
    as("abhishek", "owner", "passkey", "dev_phone_abhishek");
    const current = (await get("/settings/drawer")).json() as { value: Record<string, unknown> };
    const r = await api.inject({
      method: "PUT",
      url: `/v1/venues/${venueId}/settings/drawer`,
      headers: { "idempotency-key": `drawer-${++n}` },
      payload: { value: { ...current.value, drawer: "perPerson" } },
    });
    expect(r.statusCode, r.body).toBe(200);
    const history = (await get("/settings/drawer?history=1")).json() as {
      versions: { startsOn: string; value: { drawer: string } }[];
    };
    expect(history.versions[0]).toMatchObject({
      startsOn: "2026-09-26",
      value: { drawer: "perPerson" },
    });
    expect((await get("/settings/drawer")).json().value.drawer).toBe("house");
    const models = await owner.query<{ model: string }>(
      "select distinct model from drawer_sessions where venue_id = $1",
      [venueId],
    );
    expect(models.rows.map((m) => m.model)).toEqual(["house"]);
  });
});

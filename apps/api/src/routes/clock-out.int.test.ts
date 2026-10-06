import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * The clock-out checklist and punch edits (M7-11; spec 10 · Shifts; spec 08 ·
 * Time clock, Bar tabs hand-over): open tabs go to someone still on, unsent
 * drinks go with their tab, a staff bank is dropped, cash tips are declared,
 * and a manager edits a punch with a reason in a passkey session.
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

interface Item {
  kind: string;
  name?: string;
  tab_name?: string | null;
  drinks?: number;
  cash_cents?: number;
}
const checklist = async () => (await get("/shifts/checklist")).json().items as Item[];
const tabOf = async (name: string) =>
  (
    await owner.query<{ id: string }>("select id from tabs where venue_id = $1 and name = $2", [
      venueId,
      name,
    ])
  ).rows[0]!.id;

describe("the clock-out checklist", () => {
  it("lists Diego's two tabs and his unsent 1 × Red Bull on Tariq A.'s tab", async () => {
    as("diego", "front_desk", "pin", "dev_front_computer");
    const items = await checklist();
    // In the order they were opened.
    expect(items.filter((i) => i.kind === "open_tab").map((i) => i.name)).toEqual([
      "Tariq A.",
      "Seat 6 · blue jacket",
    ]);
    expect(items.find((i) => i.kind === "unsent")).toMatchObject({
      tab_name: "Tariq A.",
      drinks: 1,
    });
    expect(items.some((i) => i.kind === "declare_tips")).toBe(true);
  });

  it("won't let Maya clock out until her 3 open tabs go to someone still on, her bank is dropped and her tips declared", async () => {
    as("maya", "bartender", "pin", "dev_bar_computer");
    await owner.query(
      `insert into staff_banks (venue_id, user_id, business_date, cash_cents) values ($1, $2, '2026-09-25', 2000)`,
      [venueId, ids["maya"]],
    );
    const refused = await post("/shifts/clock-out");
    expect(refused.statusCode).toBe(409);
    const items = refused.json().error.details.items as Item[];
    expect(items.filter((i) => i.kind === "open_tab").map((i) => i.name)).toEqual([
      "Hana K.",
      "Jess P.",
      "Luis M.",
    ]);
    expect(items.find((i) => i.kind === "staff_bank")).toMatchObject({ cash_cents: 2000 });
    expect(items.some((i) => i.kind === "declare_tips")).toBe(true);

    // Not to someone who's off the clock (Abhishek), and only to someone else.
    const hana = await tabOf("Hana K.");
    const off = await post(`/tabs/${hana}/hand-over`, { to: ids["abhishek"] });
    expect(off.statusCode).toBe(400);
    expect(off.json().error.details.reason).toBe("not_on_clock");
    for (const name of ["Hana K.", "Jess P.", "Luis M."]) {
      const r = await post(`/tabs/${await tabOf(name)}/hand-over`, { to: ids["diego"] });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().owner.name).toBe("Diego R.");
    }
    // The cash goes into the bar drawer at the bar computer.
    const bar = (
      await owner.query<{ id: string }>(
        "select s.id from drawer_sessions s join cash_drawers d on d.id = s.drawer_id where d.name = 'Bar drawer' and s.state = 'open'",
      )
    ).rows[0]!.id;
    expect((await post(`/drawer-sessions/${bar}/drop`)).statusCode).toBe(200);
    // $15.00 in cash tips: a cash_tip row on her shift.
    const declared = await post("/shifts/declare-tips", { cash_tips_cents: 1500 });
    expect(declared.statusCode, declared.body).toBe(200);
    const ledger = await owner.query<{ amount: number; shift: boolean }>(
      `select l.amount_cents::int as amount, s.membership_id = m.id as shift
         from tip_ledger l join shifts s on s.id = l.shift_id
         join memberships m on m.venue_id = l.venue_id and m.user_id = l.user_id
        where l.user_id = $1 and l.source = 'cash_tip'`,
      [ids["maya"]],
    );
    expect(ledger.rows).toEqual([{ amount: 1500, shift: true }]);
    expect(await checklist()).toEqual([]);
    const done = await post("/shifts/clock-out");
    expect(done.statusCode, done.body).toBe(200);
  });

  it("records Diego declaring $0.00, with no ledger row, and his checklist then holds only the tabs he took", async () => {
    as("diego", "front_desk", "pin", "dev_front_computer");
    const r = await post("/shifts/declare-tips", { cash_tips_cents: 0 });
    expect(r.statusCode, r.body).toBe(200);
    const shift = await owner.query<{ cents: number; at: boolean }>(
      `select s.cash_tips_declared_cents::int as cents, s.cash_tips_declared_at is not null as at
         from shifts s join memberships m on m.id = s.membership_id where m.user_id = $1 and s.ended_at is null`,
      [ids["diego"]],
    );
    expect(shift.rows[0]).toEqual({ cents: 0, at: true });
    expect(
      (await owner.query("select 1 from tip_ledger where user_id = $1", [ids["diego"]])).rowCount,
    ).toBe(0);
    expect((await checklist()).some((i) => i.kind === "declare_tips")).toBe(false);
  });
});

describe("editing a punch", () => {
  it("lets Andy move Diego's clock-in from 7:00 PM to 6:55 PM with a reason; the audit log keeps 7:00 PM", async () => {
    const punch = (
      await owner.query<{ id: string }>(
        `select p.id from time_punches p join memberships m on m.id = p.membership_id
          where m.user_id = $1 and p.kind = 'clock_in'`,
        [ids["diego"]],
      )
    ).rows[0]!.id;
    const edit = (body: unknown) =>
      api.inject({
        method: "PATCH",
        url: `/v1/venues/${venueId}/punches/${punch}`,
        headers: { "idempotency-key": `punch-${++n}` },
        payload: body as object,
      });
    as("andy", "manager", "pin", "dev_bar_computer");
    expect(
      (await edit({ at: "2026-09-25T18:55:00-04:00", reason: "Came in early" })).statusCode,
    ).toBe(403);
    as("andy", "manager", "passkey", "dev_phone_andy");
    expect((await edit({ at: "2026-09-25T18:55:00-04:00" })).statusCode).toBe(400);
    const ok = await edit({ at: "2026-09-25T18:55:00-04:00", reason: "Came in early to set up" });
    expect(ok.statusCode, ok.body).toBe(200);
    const shift = await owner.query<{ started: string }>(
      `select to_json(s.started_at) #>> '{}' as started from shifts s join memberships m on m.id = s.membership_id
        where m.user_id = $1`,
      [ids["diego"]],
    );
    expect(Temporal.Instant.from(shift.rows[0]!.started).toString()).toBe("2026-09-25T22:55:00Z");
    const audit = await owner.query<{ old: string }>(
      `select old_values ->> 'at' as old from audit_log
        where target = $1 and 'at' = any (changed_fields) order by id desc limit 1`,
      [`time_punches/${punch}`],
    );
    expect(Temporal.Instant.from(audit.rows[0]!.old).toString()).toBe("2026-09-25T23:00:00Z");
    // Nobody edits their own punches.
    const own = (
      await owner.query<{ id: string }>(
        `select p.id from time_punches p join memberships m on m.id = p.membership_id where m.user_id = $1 limit 1`,
        [ids["andy"]],
      )
    ).rows[0]!.id;
    const mine = await api.inject({
      method: "PATCH",
      url: `/v1/venues/${venueId}/punches/${own}`,
      headers: { "idempotency-key": `punch-${++n}` },
      payload: { at: "2026-09-25T17:55:00-04:00", reason: "Mine" },
    });
    expect(mine.statusCode).toBe(403);
  });
});

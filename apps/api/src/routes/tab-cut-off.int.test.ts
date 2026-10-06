import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  newYorkCounty,
  newYorkCountyTaxed,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Cutting off a bar tab (M6-14; screens N16; Money rules 5): Hana K.'s seeded cut-off reads "Andy at
 * 10:30 PM"; owners, managers, bartenders and the front desk can cut off and a runner can't; a cut-off
 * tab refuses alcohol sends (logged) but takes a Red Bull; and the alcohol window closes at 4:00:00 AM
 * on a normal night and on both daylight-saving nights.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
let n = 0;
const clock = new SimulatedClock(SEED_NOW);
const as = (slug: string, role: string) => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "POST", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
type TabView = {
  id: string;
  check_id: string;
  name: string;
  cut_off: { at: string; by: string | null; reason: string | null } | null;
};
const tabNamed = async (name: string) =>
  ((await call("GET", "/tabs")).json().tabs as TabView[]).find((x) => x.name === name)!;
const send = (checkId: string, variant: string) =>
  call("POST", `/checks/${checkId}/orders`, {
    client_order_id: `cut-off-round-${++n}`,
    lines: [{ variant_id: ids[`menu_${variant}_regular`]!, qty: 1 }],
  });
const refusals = async (checkId: string) =>
  (
    await owner.query<{ reason: string; item: string | null }>(
      "select reason, item from alcohol_refusals where check_id = $1 order by at, id",
      [checkId],
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
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
  // A runner: a staff member with no cut-off permission.
  const u = await owner.query<{ id: string }>(
    "insert into users (name, email) values ('Rae R.', 'rae-cut@example.test') returning id",
  );
  const m = await owner.query<{ id: string }>(
    "insert into memberships (venue_id, user_id, role, status) values ($1, $2, 'staff', 'active') returning id",
    [venueId, u.rows[0]!.id],
  );
  ids["rae"] = u.rows[0]!.id;
  ids["rae.membership"] = m.rows[0]!.id;
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("cutting off a tab", () => {
  it("Hana K.'s tab reads cut off by Andy at 10:30 PM, its menu greys alcohol, and a send is refused and logged", async () => {
    as("maya", "bartender");
    const hana = await tabNamed("Hana K.");
    expect(hana.cut_off?.by).toBe("Andy");
    expect(
      Temporal.Instant.from(hana.cut_off!.at)
        .toZonedDateTimeISO("America/New_York")
        .toPlainTime()
        .toString({ smallestUnit: "minute" }),
    ).toBe("22:30");
    const menu = (await call("GET", `/menu?check_id=${hana.check_id}`)).json();
    expect(menu.alcohol.blocked).toBe("cut_off");
    const before = (await refusals(hana.check_id)).length;
    const refused = await send(hana.check_id, "modelo");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("cut_off");
    expect((await refusals(hana.check_id)).length).toBe(before + 1);
    // No alcohol isn't refused: a Red Bull still goes on.
    expect((await send(hana.check_id, "redbull")).statusCode).toBe(201);
  });

  it("a runner's cut-off is refused", async () => {
    as("rae", "staff");
    const luis = await (async () => {
      as("maya", "bartender");
      const t = await tabNamed("Luis M.");
      as("rae", "staff");
      return t;
    })();
    const r = await call("POST", `/tabs/${luis.id}/cut-off`, { reason: "Too drunk" });
    expect(r.statusCode).toBe(403);
  });

  it("Maya cuts off Luis M.: who, when and why on the tab, a refusal logged, alcohol refused, and not twice", async () => {
    as("maya", "bartender");
    const luis = await tabNamed("Luis M.");
    expect(luis.cut_off).toBeNull();
    expect(
      (await call("GET", `/menu?check_id=${luis.check_id}`)).json().alcohol.blocked,
    ).toBeNull();
    expect((await call("POST", `/tabs/${luis.id}/cut-off`, {})).statusCode).toBe(400);
    const r = await call("POST", `/tabs/${luis.id}/cut-off`, { reason: "Too drunk" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().cut_off).toMatchObject({ by: "Maya", reason: "Too drunk" });
    expect((await tabNamed("Luis M.")).cut_off).toMatchObject({ by: "Maya", reason: "Too drunk" });
    expect(await refusals(luis.check_id)).toEqual([{ reason: "cut_off", item: null }]);
    expect((await send(luis.check_id, "bud")).json().error.code).toBe("cut_off");
    expect((await call("POST", `/tabs/${luis.id}/cut-off`, { reason: "Again" })).statusCode).toBe(
      409,
    );
  });

  it("owners, managers and the front desk can cut off too", async () => {
    as("maya", "bartender");
    const [jess, tariq, seat] = await Promise.all(
      ["Jess P.", "Tariq A.", "Seat 6 · blue jacket"].map(tabNamed),
    );
    as("abhishek", "owner");
    expect((await call("POST", `/tabs/${jess!.id}/cut-off`, { reason: "Asked" })).statusCode).toBe(
      200,
    );
    as("andy", "manager");
    expect((await call("POST", `/tabs/${tariq!.id}/cut-off`, { reason: "Loud" })).statusCode).toBe(
      200,
    );
    as("diego", "front_desk");
    expect(
      (await call("POST", `/tabs/${seat!.id}/cut-off`, { reason: "Slurring" })).statusCode,
    ).toBe(200);
  });
});

describe("the 4 AM stop on the bar POS", () => {
  // A normal night, the night the clocks fall back (Nov 1, 2026) and the night they spring forward
  // (Mar 14, 2027): alcohol stops at 4:00:00 AM local time, whatever the offset.
  for (const [night, offset] of [
    ["2026-09-26", "-04:00"],
    ["2026-11-01", "-05:00"],
    ["2027-03-14", "-04:00"],
  ] as const)
    it(`greys alcohol out from 4:00:00 AM on ${night}`, async () => {
      as("maya", "bartender");
      const before = Temporal.Instant.from(`${night}T03:59:59${offset}`);
      const at = Temporal.Instant.from(`${night}T04:00:00${offset}`);
      clock.set(before);
      expect((await call("GET", "/menu")).json().alcohol.state).not.toBe("closed");
      clock.set(at);
      const menu = (await call("GET", "/menu")).json();
      expect(menu.alcohol.state).toBe("closed");
      clock.set(SEED_NOW);
    });

  it("at 4:02 AM a send to an open tab answers alcohol_closed, and its menu says why", async () => {
    as("maya", "bartender");
    const hana = await tabNamed("Hana K.");
    clock.set(Temporal.Instant.from("2026-09-26T04:02:00-04:00"));
    expect((await call("GET", `/menu?check_id=${hana.check_id}`)).json().alcohol.blocked).toBe(
      "window_closed",
    );
    expect((await send(hana.check_id, "bud")).json().error.code).toBe("alcohol_closed");
    clock.set(SEED_NOW);
  });
});

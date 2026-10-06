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
import { ticketLines, type TicketPayload } from "../print/ticket.js";

/**
 * Send the singer a drink (M6-24; spec 11; D64): Tariq A. sends Jess P. a Modelo, which rings the bar,
 * goes on Tariq's tab and prints a ticket naming Jess with the ID check at hand-off; a gift of alcohol
 * to Hana K. (cut off by Andy at 10:30 PM) is refused and logged, a Red Bull isn't; and a gift after
 * 4:00 AM is refused with the 4 AM reason, on a normal night and on both daylight-saving nights.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
let n = 0;
const clock = new SimulatedClock(SEED_NOW);
const call = (method: "GET" | "POST", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const gift = (singer: string, variant: string, tab = "tab_t5") =>
  call("POST", `/tabs/${ids[tab]}/gift-order`, {
    client_order_id: `gift-order-${++n}`,
    singer_id: ids[singer],
    lines: [{ variant_id: ids[`menu_${variant}_regular`]!, qty: 1 }],
  });
const refusals = async (checkId: string) =>
  (
    await owner.query<{ reason: string; item: string | null }>(
      "select reason, item from alcohol_refusals where check_id = $1 order by at, id",
      [checkId],
    )
  ).rows;
const checkOfTab = async (tab: string) =>
  (await owner.query<{ check_id: string }>("select check_id from tabs where id = $1", [ids[tab]]))
    .rows[0]!.check_id;

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
  who = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" } as never],
  };
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

describe("send the singer a drink", () => {
  it("Tariq A. sends Jess P. a Modelo: it rings the bar, goes on Tariq's tab, and the ticket names Jess", async () => {
    const tariq = await checkOfTab("tab_t5");
    const jess = await checkOfTab("tab_t1");
    const r = await gift("sg_jess", "modelo");
    expect(r.statusCode, r.body).toBe(201);
    const order = r.json().order;
    expect(order.source).toBe("gift");
    expect(order.check_id).toBe(tariq);
    expect(order.gift_for_singer_id).toBe(ids["sg_jess"]);
    expect(order.gift_for_check_id).toBe(jess);
    expect(order.gift_for_name).toBe("Jess P.");
    expect(order.status).toBe("accepted");
    // On Tariq's tab, not Jess's.
    const lines = await owner.query<{ check_id: string }>(
      "select check_id from check_lines where kind = 'item' and source_id = any($1::uuid[])",
      [order.items.map((i: { id: string }) => i.id)],
    );
    expect(lines.rows.map((l) => l.check_id)).toEqual([tariq]);
    // The bar's ticket names Jess and asks for her ID at hand-off.
    const job = await owner.query<{ payload: TicketPayload }>(
      "select payload from print_jobs where order_id = $1 and kind = 'ticket'",
      [order.id],
    );
    expect(job.rows).toHaveLength(1);
    const text = ticketLines(job.rows[0]!.payload, { timeZone: "America/New_York", reprintN: 0 });
    expect(text).toContain("GIFT FOR JESS P.");
    expect(text).toContain("CHECK ID AT HAND-OFF");
    expect(text).toContain("1 x Modelo");
    // A retry with the same client_order_id answers the same order.
    const again = await call("POST", `/tabs/${ids["tab_t5"]}/gift-order`, {
      client_order_id: `gift-order-${n}`,
      singer_id: ids["sg_jess"],
      lines: [{ variant_id: ids["menu_modelo_regular"]!, qty: 1 }],
    });
    expect(again.json().order.id).toBe(order.id);
  });

  it("a gift of alcohol to Hana K. (cut off) is refused with who and when, and logged; a Red Bull isn't", async () => {
    const hana = await checkOfTab("tab_t4");
    const before = (await refusals(hana)).length;
    const r = await gift("sg_hana", "modelo");
    expect(r.statusCode).toBe(409);
    const err = r.json().error;
    expect(err.code).toBe("cut_off");
    expect(err.details.cut_off.by).toBe("Andy");
    expect(
      Temporal.Instant.from(err.details.cut_off.at)
        .toZonedDateTimeISO("America/New_York")
        .toPlainTime()
        .toString({ smallestUnit: "minute" }),
    ).toBe("22:30");
    const logged = await refusals(hana);
    expect(logged.length).toBe(before + 1);
    expect(logged.at(-1)).toMatchObject({ reason: "cut_off" });
    // Nothing went on Tariq's tab.
    const orders = await owner.query("select 1 from orders where gift_for_singer_id = $1", [
      ids["sg_hana"],
    ]);
    expect(orders.rowCount).toBe(0);
    expect((await gift("sg_hana", "redbull")).statusCode).toBe(201);
  });

  it("a singer with no tab (Ben T.) can be sent a drink; an unknown singer is 404", async () => {
    const r = await gift("sg_ben", "modelo");
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().order.gift_for_check_id).toBeNull();
    const none = await call("POST", `/tabs/${ids["tab_t5"]}/gift-order`, {
      singer_id: "00000000-0000-4000-8000-000000000000",
      lines: [{ variant_id: ids["menu_modelo_regular"]!, qty: 1 }],
    });
    expect(none.statusCode).toBe(404);
  });

  it("at 4:02 AM a gift is refused with the 4 AM reason, and logged", async () => {
    const jess = await checkOfTab("tab_t1");
    const before = (await refusals(jess)).length;
    clock.set(Temporal.Instant.from("2026-09-26T04:02:00-04:00"));
    const r = await gift("sg_jess", "modelo");
    clock.set(SEED_NOW);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("alcohol_closed");
    expect(r.json().error.details.reason).toBe("window_closed");
    const logged = await refusals(jess);
    expect(logged.length).toBe(before + 1);
    expect(logged.at(-1)).toMatchObject({ reason: "window_closed" });
  });

  for (const [night, offset] of [
    ["2026-09-26", "-04:00"],
    ["2026-11-01", "-05:00"],
    ["2027-03-14", "-04:00"],
  ] as const)
    it(`a gift at 4:00:00 AM on ${night} is refused, and one a second before isn't checked out by the window`, async () => {
      // Plenty of room on the hold: this test is about the clock, not the card.
      await owner.query("update tabs set hold_cents = 100000 where id = $1", [ids["tab_t5"]]);
      clock.set(Temporal.Instant.from(`${night}T03:59:59${offset}`));
      const ok = await gift("sg_jess", "modelo");
      clock.set(Temporal.Instant.from(`${night}T04:00:00${offset}`));
      const refused = await gift("sg_jess", "modelo");
      clock.set(SEED_NOW);
      expect(ok.statusCode, ok.body).toBe(201);
      expect(refused.json().error.code).toBe("alcohol_closed");
    });
});

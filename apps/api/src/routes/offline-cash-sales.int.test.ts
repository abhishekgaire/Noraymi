import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { offlineCashSalePrice, type TaxCategory } from "@west4/rules";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  makeDeviceKey,
  newYorkCounty,
  newYorkCountyTaxed,
  signDeviceRequest,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import type { OfflineCashTermsView } from "../orders/offline-cash.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/**
 * U-16 (D133; spec 09 · Cash quick sales while offline), on the demo seed (Fri Sep 25, 2026,
 * 10:41 PM). "Take cash quick sales while offline" is off by default: the terms and the drawer are
 * null, and a cash sale that reaches the replay anyway is refused, makes no check and shows under
 * Confirm replayed orders. On: the bar computer keeps tonight's terms, prices a cash Bud Light with
 * packages/rules, and the replay makes and pays it once, to the cent, into the bar drawer with no
 * second kick; a price that isn't the server's, or alcohol after 4:00 AM, is refused.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let venueId: string;
let ids: Record<string, string>;
let bud: { variant_id: string; price_cents: number };
let bar: { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
const clock = new SimulatedClock(SEED_NOW);

const as = (slug: string, role: string) => ({
  "x-test-principal": JSON.stringify({
    kind: "user",
    userId: ids[slug]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role }],
  } satisfies Principal),
});

async function signed(method: "GET" | "POST", path: string, body?: unknown) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = await signDeviceRequest({
    deviceId: bar.id,
    privateKey: bar.key.privateKey,
    method,
    path,
    body: payload,
  });
  return api.inject({
    method,
    url: path,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { payload }),
  });
}

async function replay(orders: unknown[]) {
  const res = await signed("POST", `/v1/venues/${venueId}/offline-orders/replay`, { orders });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { results: { order_id: string; outcome: string; reason: string | null }[] })
    .results;
}

async function terms(): Promise<OfflineCashTermsView | null> {
  const res = await signed("GET", `/v1/venues/${venueId}/pos/terminal`);
  expect(res.statusCode).toBe(200);
  return (res.json() as { offline_cash: OfflineCashTermsView | null }).offline_cash;
}

/** A cash Bud Light (or more), priced as the bar computer prices it from the kept terms. */
function sale(
  t: OfflineCashTermsView,
  opts: { qty?: number; queuedAt?: string; cash?: number } = {},
) {
  const qty = opts.qty ?? 1;
  const price = offlineCashSalePrice([{ qty, unitCents: bud.price_cents, taxCategory: "drink" }], {
    tax: {
      rate: t.tax.rate,
      taxedCategories: t.tax.taxed_categories as TaxCategory[],
      surchargeTaxable: t.tax.surcharge_taxable,
      jurisdictionCode: t.tax.jurisdiction_code,
    },
    gratuityPct: t.gratuity_pct,
    cashDiscount: t.cash_discount && {
      pct: t.cash_discount.pct,
      taxRatePct: t.cash_discount.tax_rate_pct,
      foodIncludesFee: t.cash_discount.food_includes_fee,
    },
  });
  return {
    kind: "cash_sale",
    order_id: randomUUID(),
    queued_at: opts.queuedAt ?? "2026-09-26T03:00:00Z",
    staff: { membership_id: ids["maya.membership"]!, name: "Maya S." },
    lines: [
      {
        variant_id: bud.variant_id,
        name: "Bud Light",
        qty,
        unit_cents: bud.price_cents,
        alcohol: true,
      },
    ],
    total_cents: price.totalCents,
    cash_cents: opts.cash ?? price.cashCents,
    tendered_cents: 2000 * qty,
  };
}

async function setSetting(key: string, path: string, value: unknown) {
  await owner.query(
    `insert into venue_settings (venue_id, key, version, value, starts_on)
     select venue_id, key, version + 1, jsonb_set(value, $3::text[], $4::jsonb), starts_on
       from venue_settings where venue_id = $1 and key = $2 order by version desc limit 1`,
    [venueId, key, `{${path}}`, JSON.stringify(value)],
  );
}

const quickChecks = async () =>
  Number(
    (
      await owner.query<{ n: string }>(
        "select count(*) as n from checks where venue_id = $1 and kind = 'quick'",
        [venueId],
      )
    ).rows[0]!.n,
  );

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
  bud = (
    await owner.query<{ variant_id: string; price_cents: number }>(
      `select v.id as variant_id, v.price_cents from menu_variants v join menu_items i on i.id = v.item_id
        where i.venue_id = $1 and i.name = 'Bud Light' limit 1`,
      [venueId],
    )
  ).rows[0]!;
  const k = await makeDeviceKey();
  // A bar computer on the bar drawer, which hangs on a USB printer this computer hosts.
  bar = {
    id: (
      await owner.query<{ id: string }>(
        `insert into devices (venue_id, kind, name, public_key, cash_drawer_id)
         values ($1, 'bar_computer', 'Bar test', $2,
                 (select id from cash_drawers where venue_id = $1 and name = 'Bar drawer'))
         returning id`,
        [venueId, JSON.stringify(k.publicJwk)],
      )
    ).rows[0]!.id,
    key: k,
  };
  const printer = (
    await owner.query<{ id: string }>(
      `insert into devices (venue_id, kind, name, host_device_id, serial, station)
       values ($1, 'printer', 'Virtual bar printer', $2, 'VIRTUAL-USB-1', 'bar') returning id`,
      [venueId, bar.id],
    )
  ).rows[0]!.id;
  await owner.query(
    "update cash_drawers set printer_device_id = $2 where venue_id = $1 and name = 'Bar drawer'",
    [venueId, printer],
  );
  fake = new FakeStripe();
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request) => {
        const raw = request.headers["x-test-principal"];
        return typeof raw === "string" ? (JSON.parse(raw) as Principal) : undefined;
      },
    ],
    stripe: new StripeClient(fakeStripeSettings(await fake.start())),
  });
  await api.ready();
});
afterAll(async () => {
  await api?.close();
  await fake?.stop();
  await owner?.end();
  await db?.drop();
});

describe("Take cash quick sales while offline: off (the default)", () => {
  it("keeps no terms and no drawer on the bar computer", async () => {
    expect(await terms()).toBeNull();
    const drawer = await signed("GET", `/v1/venues/${venueId}/offline-orders/drawer`);
    expect(drawer.statusCode).toBe(200);
    expect(drawer.json()).toMatchObject({ drawer: null });
  });

  it("refuses a cash sale that reaches the replay anyway: no check, shown under Confirm replayed orders until OK", async () => {
    const before = await quickChecks();
    const s = sale({
      tax: {
        rate: 0.08875,
        taxed_categories: ["drink"],
        surcharge_taxable: false,
        jurisdiction_code: null,
      },
      gratuity_pct: null,
      cash_discount: null,
    });
    expect(await replay([s])).toEqual([
      { order_id: s.order_id, outcome: "failed", reason: "switched_off" },
    ]);
    expect(await quickChecks()).toBe(before);
    const refused = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/offline-orders/refused`,
      headers: as("maya", "bartender"),
    });
    expect(refused.statusCode).toBe(200);
    const sales = (
      refused.json() as { sales: { id: string; order_id: string; cash_cents: number }[] }
    ).sales;
    expect(sales).toEqual([
      expect.objectContaining({ order_id: s.order_id, cash_cents: 871, reason: "switched_off" }),
    ]);
    // The banner counts it with the rounds asked to wait, until someone taps OK.
    const waiting = async () =>
      (
        (
          await api.inject({
            method: "GET",
            url: `/v1/venues/${venueId}/connection`,
            headers: as("maya", "bartender"),
          })
        ).json() as { replayed_waiting: number }
      ).replayed_waiting;
    expect(await waiting()).toBe(1);
    const ok = await api.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/offline-orders/${sales[0]!.id}/seen`,
      headers: as("maya", "bartender"),
    });
    expect(ok.statusCode).toBe(200);
    const after = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/offline-orders/refused`,
      headers: as("maya", "bartender"),
    });
    expect((after.json() as { sales: unknown[] }).sales).toEqual([]);
    expect(await waiting()).toBe(0);
    // A manager still sees it on Review after outage.
    const review = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/offline-orders?business_date=2026-09-25`,
      headers: as("andy", "manager"),
    });
    expect((review.json() as { orders: { order_id: string; kind: string }[] }).orders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ order_id: s.order_id, kind: "cash_sale", outcome: "failed" }),
      ]),
    );
  });
});

describe("Take cash quick sales while offline: on", () => {
  beforeAll(async () => {
    await setSetting("pos", "offlineCashSales", true);
  });

  it("keeps tonight's terms and the bar drawer's kick on its USB printer", async () => {
    expect(await terms()).toEqual({
      tax: expect.objectContaining({ rate: 0.08875 }),
      gratuity_pct: null,
      cash_discount: null,
    });
    const drawer = (await signed("GET", `/v1/venues/${venueId}/offline-orders/drawer`)).json() as {
      drawer: { printer: unknown; kick: string };
    };
    expect(drawer.drawer.printer).toEqual({ kind: "usb", serial: "VIRTUAL-USB-1" });
    // ESC @, then ESC p 0 25 250: the kick on pin 2.
    expect(Buffer.from(drawer.drawer.kick, "base64").toString("hex")).toBe("1b401b700019fa");
  });

  it("a cash Bud Light replays once, to the cent, into the bar drawer with no second kick", async () => {
    const t = (await terms())!;
    const s = sale(t);
    expect(s).toMatchObject({ total_cents: 871, cash_cents: 871 });
    const kicks = async () =>
      Number(
        (
          await owner.query<{ n: string }>(
            "select count(*) as n from print_jobs where venue_id = $1 and kind = 'drawer'",
            [venueId],
          )
        ).rows[0]!.n,
      );
    const kicksBefore = await kicks();
    expect(await replay([s])).toEqual([{ order_id: s.order_id, outcome: "sold", reason: null }]);
    // The same upload again (a lost answer): the same answer, nothing made twice.
    expect(await replay([s])).toEqual([{ order_id: s.order_id, outcome: "sold", reason: null }]);
    const made = await owner.query<{
      status: string;
      kind: string;
      amount_cents: number;
      tendered_cents: number;
      change_cents: number;
      drawer: string | null;
    }>(
      `select k.status, k.kind, p.amount_cents::int, p.tendered_cents::int, p.change_cents::int,
              (select d.name from drawer_sessions ds join cash_drawers d on d.id = ds.drawer_id
                where ds.id = p.drawer_session_id) as drawer
         from offline_replays r
         join payments p on p.id = r.cash_payment_id
         join orders o on o.id = r.order_id
         join checks k on k.id = o.check_id
        where r.client_order_id = $1`,
      [s.order_id],
    );
    expect(made.rows).toEqual([
      {
        status: "paid",
        kind: "quick",
        amount_cents: 871,
        tendered_cents: 2000,
        change_cents: 1129,
        drawer: "Bar drawer",
      },
    ]);
    const moves = await owner.query<{ amount_cents: number }>(
      `select m.amount_cents::int from drawer_moves m join offline_replays r on r.cash_payment_id = m.payment_id
        where r.client_order_id = $1`,
      [s.order_id],
    );
    expect(moves.rows).toEqual([{ amount_cents: 871 }]);
    expect(await kicks()).toBe(kicksBefore);
  });

  it("with the cash discount on, cash pays the discounted price and the replay agrees", async () => {
    await setSetting("pay", "cardFee", { mode: "discount", pct: 3.38 });
    try {
      const t = (await terms())!;
      expect(t.cash_discount).toMatchObject({ pct: 3.38, food_includes_fee: true });
      const s = sale(t);
      expect(s).toMatchObject({ total_cents: 871, cash_cents: 839 });
      expect(await replay([s])).toEqual([{ order_id: s.order_id, outcome: "sold", reason: null }]);
      const paid = await owner.query<{ amount_cents: number }>(
        `select p.amount_cents::int from offline_replays r join payments p on p.id = r.cash_payment_id
          where r.client_order_id = $1`,
        [s.order_id],
      );
      expect(paid.rows).toEqual([{ amount_cents: 839 }]);
    } finally {
      await setSetting("pay", "cardFee", { mode: "off" });
    }
  });

  it("a price that isn't the server's is refused and nothing is made", async () => {
    const before = await quickChecks();
    const s = sale((await terms())!, { cash: 800 });
    expect(await replay([s])).toEqual([
      { order_id: s.order_id, outcome: "failed", reason: "price_changed" },
    ]);
    expect(await quickChecks()).toBe(before);
  });

  it("after 4:00 AM the replay refuses the beer, as online", async () => {
    const s = sale((await terms())!, { queuedAt: "2026-09-26T07:50:00Z" });
    clock.set(Temporal.Instant.from("2026-09-26T08:05:00Z"));
    try {
      expect(await replay([s])).toEqual([
        { order_id: s.order_id, outcome: "failed", reason: "alcohol_closed" },
      ]);
    } finally {
      clock.set(SEED_NOW);
    }
  });

  it("someone not on the team is refused", async () => {
    const s = { ...sale((await terms())!), staff: { membership_id: randomUUID(), name: "Nobody" } };
    expect(await replay([s])).toEqual([
      { order_id: s.order_id, outcome: "failed", reason: "no_staff" },
    ]);
  });

  it("a person can't replay, and another computer's drawer isn't this one's", async () => {
    const res = await api.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/offline-orders/replay`,
      headers: as("maya", "bartender"),
      payload: { orders: [sale((await terms())!)] },
    });
    expect(res.statusCode).toBe(403);
    const drawer = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/offline-orders/drawer`,
      headers: as("andy", "manager"),
    });
    expect(drawer.statusCode).toBe(403);
  });
});

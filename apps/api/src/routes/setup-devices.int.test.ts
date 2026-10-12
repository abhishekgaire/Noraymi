import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  generateSigningKey,
  publishRulePack,
  saveStripeIntegration,
  setModuleAllowed,
} from "@west4/db";
import { createTestDatabase, seedTwoVenues, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/**
 * Set up your venue's step 12 (O-13; spec 17 · Step details 12) on a venue with nothing paired:
 * a simulated reader registered on the fake Stripe, a receipt printer with its drawer added in
 * Admin → Printers & devices, and the merchant category checked against Stripe make the step
 * done; Finish setup then stamps the venue and turns on only the modules the owner ticked.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance;
let fake: FakeStripe;
let account: string;
let venueId: string;
let venueB: string;
let as: Principal;

type Step = { id: string; mark: string; missing: string[] };
type Answer = {
  checklist: { steps: Step[]; ready: boolean; blocking: string[] };
  completed_at: string | null;
};
const call = (method: "GET" | "POST" | "PUT" | "PATCH", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const devicesStep = async () =>
  ((await call("GET", "/setup")).json() as Answer).checklist.steps.find((s) => s.id === "devices")!;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  const v = await seedTwoVenues(db.url);
  venueId = v.venueA;
  venueB = v.venueB;
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  fake = new FakeStripe();
  const stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "setup-devices-acct",
      params: { display_name: "Venue A" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1 where id = $2", [
    account,
    v.orgId,
  ]);
  const membership = (
    await owner.query<{ id: string }>(
      "select id from memberships where venue_id = $1 and user_id = $2",
      [venueId, v.ownerA],
    )
  ).rows[0]!.id;
  as = {
    kind: "user",
    userId: v.ownerA,
    session: "passkey",
    memberships: [{ venueId, membershipId: membership, role: "owner" } as never],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock: new FrozenClock(SEED_NOW),
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => as],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await owner.end();
  await db.drop();
});

describe("Set up your venue · step 12, devices and checks (O-13)", () => {
  it("starts needing a reader, a receipt printer with a drawer and the merchant category", async () => {
    const step = await devicesStep();
    expect(step.mark).not.toBe("done");
    expect(step.missing).toEqual(["reader", "receiptPrinter", "merchantCategory"]);
  });

  it("a simulated reader, a receipt printer with a drawer and the merchant category make it done", async () => {
    // The reader's tip screen is the venue's own choice: none saved, the registration says so.
    const early = await call("POST", "/readers", {
      registration_code: "simulated-s710",
      label: "Bar S710",
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().error.details).toEqual({ reason: "tip_screen" });
    await owner.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on, saved_by)
         values ($1, 'pay', 1, $2, '2026-09-01', null)`,
      [
        venueId,
        JSON.stringify({
          tipScreen: { on: false, pcts: [0, 0, 0], fixedCents: [0, 0, 0], smartThresholdCents: 0 },
        }),
      ],
    );
    const reader = await call("POST", "/readers", {
      registration_code: "simulated-s710",
      label: "Bar S710",
    });
    expect(reader.statusCode, reader.body).toBe(201);
    expect((await devicesStep()).missing).not.toContain("reader");

    const printer = await call("POST", "/printers", {
      name: "Bar printer",
      station: "bar",
      protocol: "cloudprnt",
    });
    expect(printer.statusCode, printer.body).toBe(201);
    const printerId = (printer.json() as { device_id: string }).device_id;
    // A printer alone isn't enough: the drawer goes on its kick port.
    expect((await devicesStep()).missing).toContain("receiptPrinter");
    const drawer = await call("POST", "/drawers", {
      name: "Bar drawer",
      printer_device_id: printerId,
    });
    expect(drawer.statusCode, drawer.body).toBe(201);
    // One drawer per printer.
    const again = await call("POST", "/drawers", { name: "Second", printer_device_id: printerId });
    expect(again.statusCode).toBe(409);
    expect((await devicesStep()).missing).not.toContain("receiptPrinter");

    const acct = fake.objects.get(account)!;
    (acct["configuration"] as { merchant: Record<string, unknown> }).merchant["mcc"] = "5813";
    const mcc = await call("PUT", "/go-live/merchant-category", { expected: "5813" });
    expect(mcc.statusCode, mcc.body).toBe(200);
    await call("GET", "/go-live");

    const step = await devicesStep();
    expect(step.missing).toEqual([]);
    expect(step.mark).toBe("done");
  });

  it("a drawer goes only on a live bar or front-desk printer of this venue", async () => {
    const kitchen = await call("POST", "/printers", {
      name: "Kitchen printer",
      station: "kitchen",
      protocol: "cloudprnt",
    });
    const kitchenId = (kitchen.json() as { device_id: string }).device_id;
    expect(
      (await call("POST", "/drawers", { name: "K", printer_device_id: kitchenId })).statusCode,
    ).toBe(400);
    const theirs = await owner.query<{ id: string }>(
      "insert into devices (venue_id, kind, name, station) values ($1, 'printer', 'B bar', 'bar') returning id",
      [venueB],
    );
    expect(
      (await call("POST", "/drawers", { name: "X", printer_device_id: theirs.rows[0]!.id }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await owner.query("select 1 from cash_drawers where printer_device_id = $1", [
          theirs.rows[0]!.id,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it("Finish setup with every required step done stamps the venue and turns on only the ticked modules", async () => {
    // Every other required step, as the earlier steps' own routes leave the rows.
    await owner.query(
      `insert into venue_subscriptions (venue_id, plan, stripe_subscription_id, status)
         values ($1, 'bar', 'sub_devices_test', 'active')`,
      [venueId],
    );
    for (const m of ["online_booking", "guest_texts", "website"] as const)
      await setModuleAllowed(owner, venueId, m, true, undefined);
    await owner.query(
      `update venues set address = '{"line1":"1 Test St","city":"New York","region":"NY","postal_code":"10001","country":"US"}'
        where id = $1`,
      [venueId],
    );
    await saveStripeIntegration(owner, venueId, {
      accountId: account,
      cardPayments: "active",
      needs: [],
      at: SEED_NOW.toString(),
    });
    const maya = await owner.query<{ id: string }>(
      "insert into users (name) values ('Maya') returning id",
    );
    const manager = await owner.query<{ id: string }>(
      `insert into memberships (venue_id, user_id, role, status, pin_verifier)
         values ($1, $2, 'manager', 'active', 'x') returning id`,
      [venueId, maya.rows[0]!.id],
    );
    const managerId = manager.rows[0]!.id;
    for (const [key, value] of [
      ["phone", { guestNumber: "+12125550100" }],
      ["hours", {}],
      ["safety", {}],
      [
        "contacts",
        {
          bookingEmails: [],
          onCall: {
            first: { membershipId: managerId, days: [5, 6], from: "18:00", to: "04:00" },
            second: null,
          },
          breach: { primary: managerId, backup: null },
        },
      ],
    ] as const)
      await owner.query(
        `insert into venue_settings (venue_id, key, version, value, starts_on, saved_by)
           values ($1, $2, 1, $3, '2026-09-01', null)`,
        [venueId, key, JSON.stringify(value)],
      );
    const cat = await owner.query<{ id: string }>(
      "insert into menu_categories (venue_id, name) values ($1, 'Beer') returning id",
      [venueId],
    );
    const item = await owner.query<{ id: string }>(
      "insert into menu_items (venue_id, category_id, name) values ($1, $2, 'Lager') returning id",
      [venueId, cat.rows[0]!.id],
    );
    await owner.query(
      "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Pint', 800)",
      [venueId, item.rows[0]!.id],
    );
    await owner.query(
      "insert into licenses (venue_id, kind, created_at, updated_at) values ($1, 'liquor', now(), now())",
      [venueId],
    );

    const ready = (await call("GET", "/setup")).json() as Answer;
    expect(ready.checklist.blocking).toEqual([]);
    expect(ready.checklist.ready).toBe(true);

    const states = async () =>
      Object.fromEntries(
        (
          (await call("GET", "/modules")).json() as { modules: { id: string; state: string }[] }
        ).modules
          .filter((m) => ["online_booking", "guest_texts", "website"].includes(m.id))
          .map((m) => [m.id, m.state]),
      );
    const before = await states();
    const finish = await call("POST", "/setup/finish", {});
    expect(finish.statusCode, finish.body).toBe(200);
    expect(Date.parse((finish.json() as Answer).completed_at!)).toBe(SEED_NOW.epochMilliseconds);
    // Finish setup itself turns nothing on; the screen sends the ticked ones (only the website here).
    expect(await states()).toEqual(before);
    const on = await call("PATCH", "/modules/website", { state: "on" });
    expect(on.statusCode, on.body).toBe(200);
    expect(await states()).toEqual({ ...before, website: "on" });
    expect(before["online_booking"]).not.toBe("on");
    expect(before["guest_texts"]).not.toBe("on");
  });
});

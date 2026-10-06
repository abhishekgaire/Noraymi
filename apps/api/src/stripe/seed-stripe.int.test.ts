import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { StripeClient } from "./client.js";
import { FakeStripe } from "./fake/index.js";
import { seedStripe } from "./seed-stripe.js";
import { fakeStripeSettings } from "./settings.js";

let db: TestDatabase;
let owner: pg.Pool;
let fake: FakeStripe;
let stripe: StripeClient;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } });
  owner = new pg.Pool({ connectionString: db.url });
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
});

afterAll(async () => {
  await fake.stop();
  await owner.end();
  await db.drop();
});

describe("stripe:seed", () => {
  it("backs every deposit with a succeeded PaymentIntent and attaches both readers by label", async () => {
    const done = await seedStripe(owner, stripe, () => undefined);
    // The three paper slips' holds and the five open bar tabs' (M6-16).
    expect(done).toMatchObject({ readers: 2, deposits: 11, holds: 8 });
    const marcus = (
      await owner.query<{ pi: string; brand: string; last4: string }>(
        `select p.stripe_pi_id as pi, p.card_brand as brand, p.card_last4 as last4 from payments p
          where p.booking_id = (select row_id from seed_ids where slug = 'bk_marcus')`,
      )
    ).rows[0]!;
    const pi = fake.objects.get(marcus.pi)!;
    expect(pi).toMatchObject({
      status: "succeeded",
      amount: 12000,
      amount_received: 12000,
      setup_future_usage: "off_session",
    });
    // Stripe's test Amex underneath; the brief's Amex ··1005 stays on our row for display.
    expect(fake.objects.get(String(pi["latest_charge"]))).toMatchObject({
      payment_method_details: { card: { brand: "amex", last4: "0005" } },
    });
    expect(marcus).toMatchObject({ brand: "amex", last4: "1005" });
    const readers = await owner.query(
      "select name, stripe_reader_id is not null as registered from devices where kind = 'reader' order by name",
    );
    expect(readers.rows).toEqual([
      { name: "Bar S710", registered: true },
      { name: "Front desk S710", registered: true },
    ]);
    // The paper slips' holds (M6-09): tapped on the bar reader, held for the opening $50.00, able to grow.
    const ana = (
      await owner.query<{ pi: string; over: boolean }>(
        `select p.stripe_pi_id as pi, p.overcapture_supported as over from payments p
          where p.id = (select row_id from seed_ids where slug = 'pay_slip_3')`,
      )
    ).rows[0]!;
    expect(fake.objects.get(ana.pi)).toMatchObject({
      status: "requires_capture",
      amount_capturable: 5000,
      capture_method: "manual",
    });
    expect(ana.over).toBe(true);
    // The bar tabs' holds (M6-16): Luis M.'s grown $80.00, and able to grow once Stripe says so.
    const luis = (
      await owner.query<{ pi: string; grows: boolean }>(
        `select p.stripe_pi_id as pi, p.incremental_supported as grows from payments p
          where p.id = (select row_id from seed_ids where slug = 'pay_tab_t2')`,
      )
    ).rows[0]!;
    expect(fake.objects.get(luis.pi)).toMatchObject({
      status: "requires_capture",
      amount_capturable: 8000,
    });
    expect(luis.grows).toBe(true);
  });

  it("does nothing new on a second run: no new PaymentIntents, the same readers", async () => {
    const before = fake.list("payment_intent", null).length;
    const again = await seedStripe(owner, stripe, () => undefined);
    expect(again).toMatchObject({ readers: 2, deposits: 0, holds: 0 });
    expect(fake.list("payment_intent", null)).toHaveLength(before);
    expect(fake.list("terminal.reader", null)).toHaveLength(2);
  });
});

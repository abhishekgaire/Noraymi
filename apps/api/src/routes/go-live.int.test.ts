import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/** The go-live checklist for West 4 (M4-29) against the fake Stripe. */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let venueId: string;
let account: string;
let ids: Record<string, string>;
let who: Principal | undefined;
const as = (slug: string, role: string) => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "PUT" | "POST" | "PATCH", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  fake = new FakeStripe();
  const stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "golive-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock: new FrozenClock(SEED_NOW),
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await fake.stop();
  await owner.end();
  await db.drop();
});

describe("the go-live checklist", () => {
  it("with the merchant category not yet checked, turning on Bar tabs & quick sale is refused with the reason", async () => {
    as("abhishek", "owner");
    expect(
      (await call("PATCH", "/modules/bar_tabs", { state: "off", confirm: true })).statusCode,
    ).toBe(200);
    const on = await call("PATCH", "/modules/bar_tabs", { state: "on" });
    expect(on.statusCode).toBe(400);
    expect(on.json().error).toMatchObject({ details: { reason: "merchant_category" } });
    expect(on.json().error.message).toMatch(/merchant category/);
  });

  it("passes once the category matches Stripe's and Andy and Abhishek are confirmed; then Bar tabs turns on", async () => {
    as("abhishek", "owner");
    // Stripe's account has its category once onboarding is done.
    const acct = fake.objects.get(account)!;
    (acct["configuration"] as { merchant: Record<string, unknown> }).merchant["mcc"] = "5813";
    expect((await call("PUT", "/go-live/merchant-category", { expected: "5813" })).statusCode).toBe(
      200,
    );
    let list = (await call("GET", "/go-live")).json();
    expect(list.merchant_category).toEqual({ expected: "5813", found: "5813", status: "passed" });
    expect(list.people.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Abhishek/), expect.stringMatching(/^Andy/)]),
    );
    expect(list.passes).toBe(false);
    for (const person of ["abhishek", "andy"])
      for (const check of ["dashboard_login", "tap_to_pay"])
        list = (
          await call("POST", `/go-live/people/${ids[person]}`, { check, confirmed: true })
        ).json();
    expect(list.passes).toBe(true);
    const andy = list.people.find((p: { name: string }) => p.name.startsWith("Andy"));
    expect(andy.dashboard_login).toMatchObject({
      confirmed: true,
      by: expect.stringMatching(/^Abhishek/),
    });
    expect((await call("PATCH", "/modules/bar_tabs", { state: "on" })).statusCode).toBe(200);
  });

  it("is the owner's: Andy (a manager) can't read or change it", async () => {
    as("andy", "manager");
    expect((await call("GET", "/go-live")).statusCode).toBe(403);
    expect(
      (
        await call("POST", `/go-live/people/${ids["andy"]}`, {
          check: "tap_to_pay",
          confirmed: false,
        })
      ).statusCode,
    ).toBe(403);
  });
});

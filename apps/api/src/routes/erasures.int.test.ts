import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import {
  encryptSecret,
  loadDemoSeed,
  optedOut,
  saveTwilioIntegration,
  withVenue,
  Worker,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { StripeClient } from "../stripe/client.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { FakeVenueClient } from "../texts/venue.js";
import { guardSend } from "../texts/queue.js";
import { ERASE_KIND, makeEraseHandler } from "../jobs/erase.js";

/**
 * M8-13 on the demo seed: owners and managers erase a guest on request. The
 * guest's name, phone and email go; their saved cards are detached (on the
 * fake Stripe, standing in for the sandbox); their message bodies are blanked
 * here and redacted at Twilio, except under a legal hold; the opt-out stays
 * as a keyed hash; checks, payments and the audit log stay, with no contact
 * details. A singer is erased the same way once their tab owes nothing.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let owner: pg.Pool;
let app: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const people: Record<string, Principal> = {};
const texts = new FakeVenueClient();
const secretKey = Buffer.from("e".repeat(64), "hex");
const account = "acct_erase";

const post = (who: string, path: string) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { "x-test-as": who },
  });
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await raw.query(sql, params)).rows[0] as T;

/** The erase job's turn: the normal pool with only its handler. */
async function runJobs() {
  const worker = new Worker(owner, {
    pool: "normal",
    handlers: { [ERASE_KIND]: makeEraseHandler({ stripe, texts: { client: texts, secretKey } }) },
    clock,
    random: () => 0.5,
  });
  while ((await worker.tick()) > 0);
}

let gina = "";
let ginaBooking = "";
let ginaMessage = "";
let hal = "";
let halMessage = "";
let marcus = "";

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  const roles = { abhishek: "owner", andy: "manager", maya: "bartender", diego: "front_desk" };
  for (const [who, role] of Object.entries(roles))
    people[who] = {
      kind: "user",
      userId: ids[who]!,
      session: role === "owner" || role === "manager" ? "passkey" : "pin",
      memberships: [{ venueId, membershipId: ids[`${who}.membership`]!, role }],
    } as Principal;
  people["andyPin"] = { ...people["andy"]!, session: "pin" } as Principal;
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [
      async (request) => {
        const who = request.headers["x-test-as"];
        return typeof who === "string" ? people[who] : undefined;
      },
    ],
    moduleCacheMs: 0,
  });
  await app.ready();

  await raw.query(
    "update organizations set stripe_account_id = $2 where id = (select org_id from venues where id = $1)",
    [venueId, account],
  );
  await withVenue(pool, { venueId }, (c) =>
    saveTwilioIntegration(c, venueId, {
      accountSid: "ACerase",
      phoneE164: "+12125550100",
      secretEnc: encryptSecret(secretKey, "token"),
      at: SEED_NOW.toString(),
    }),
  );
  marcus = (
    await one<{ guest_id: string }>("select guest_id from bookings where id = $1", [
      ids["bk_marcus"],
    ])
  ).guest_id;

  // Gina S. booked last Friday with a saved card, then texted STOP.
  const guest = (name: string, phone: string) =>
    one<{ id: string }>(
      `insert into guests (venue_id, name, phone_e164, email, last_seen_at)
       values ($1, $2, $3, $4, now()) returning id`,
      [venueId, name, phone, `${name.split(" ")[0]!.toLowerCase()}@example.com`],
    ).then((r) => r.id);
  gina = await guest("Gina S.", "+12125550911");
  hal = await guest("Hal D.", "+12125550912");
  ginaBooking = (
    await one<{ id: string }>(
      `insert into bookings (venue_id, guest_id, room_id, size_tier, party_size, starts_at, ends_at,
                             business_date, status, source, payment_method_id)
       select venue_id, $2::uuid, room_id, size_tier, 2, starts_at - interval '7 days', ends_at - interval '7 days',
              business_date - 7, 'completed', source, 'pm_erase_gina'
         from bookings where id = $3 and venue_id = $1 returning id`,
      [venueId, gina, ids["bk_marcus"]],
    )
  ).id;
  fake.put({
    id: "pm_erase_gina",
    object: "payment_method",
    _account: account,
    customer: "cus_gina",
    card: { brand: "visa", last4: "4242" },
  });
  await raw.query(
    `insert into consents (venue_id, guest_id, channel, kind, given_at, source, revoked_at, revoked_via)
     values ($1, $2, 'sms', 'texts', now() - interval '8 days', 'form', now() - interval '1 day', 'keyword')`,
    [venueId, gina],
  );
  const conversation = async (g: string, phone: string, kind: string, ctx: string) =>
    (
      await one<{ id: string }>(
        `insert into conversations (venue_id, guest_id, phone_e164, context_kind, context_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [venueId, g, phone, kind, ctx],
      )
    ).id;
  const message = async (conv: string, body: string, sid: string, direction = "outbound") =>
    (
      await one<{ id: string }>(
        `insert into messages (venue_id, conversation_id, direction, category, body, provider_sid, status)
         values ($1, $2, $3, 'service', $4, $5, $6) returning id`,
        [venueId, conv, direction, body, sid, direction === "outbound" ? "delivered" : "received"],
      )
    ).id;
  const ginaConv = await conversation(gina, "+12125550911", "booking", ginaBooking);
  ginaMessage = await message(ginaConv, "Your room is ready, Gina", "SMgina1");
  await message(ginaConv, "STOP", "SMgina2", "inbound");

  // Hal D.'s texts are about a booking whose check has an open dispute: under a legal hold.
  const disputed = await one<{ id: string; booking_id: string }>(
    "select id, booking_id from checks where venue_id = $1 and booking_id is not null and booking_id <> $2 limit 1",
    [venueId, ids["bk_marcus"]],
  );
  await raw.query(
    `insert into disputes (venue_id, check_id, stripe_dispute_id, reason, amount_cents, status, opened_at)
     values ($1, $2, 'dp_erase_hold', 'fraudulent', 1000, 'needs_response', now())`,
    [venueId, disputed.id],
  );
  const halConv = await conversation(hal, "+12125550912", "booking", disputed.booking_id);
  halMessage = await message(halConv, "See you at 9, Hal", "SMhal1");
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
  await raw?.end();
  await fake?.stop();
  await db?.drop();
});

describe("POST /guests/{g}/erase", () => {
  it("is for owners and managers in a passkey session", async () => {
    for (const who of ["maya", "diego", "andyPin"])
      expect((await post(who, `/guests/${gina}/erase`)).statusCode, who).toBe(403);
    expect(
      (await post("andy", `/guests/00000000-0000-4000-8000-000000000099/erase`)).statusCode,
    ).toBe(404);
  });

  it("erasing a guest who texted STOP blanks their details, detaches their card, purges their bodies here and at Twilio, and keeps the opt-out as a hash", async () => {
    const auditBefore = (
      await one<{ id: string }>("select coalesce(max(id), 0) as id from audit_log")
    ).id;
    const r = await post("andy", `/guests/${gina}/erase`);
    expect(r.statusCode).toBe(200);
    expect(r.json().erasure).toMatchObject({
      subject: "guest",
      state: "pending",
      pending_cards: 1,
      pending_messages: 2,
    });

    expect(
      await one(
        "select name, phone_e164, email, erased_at is not null as erased from guests where id = $1",
        [gina],
      ),
    ).toEqual({ name: "", phone_e164: null, email: null, erased: true });
    const bodies = await raw.query(
      "select m.body, cv.phone_e164 from messages m join conversations cv on cv.id = m.conversation_id where cv.guest_id = $1",
      [gina],
    );
    expect(bodies.rows).toEqual([
      { body: "", phone_e164: "" },
      { body: "", phone_e164: "" },
    ]);
    expect(
      (
        await raw.query("select 1 from consents where guest_id = $1 and phone_e164 is not null", [
          gina,
        ])
      ).rowCount,
    ).toBe(0);

    await runJobs();
    expect(fake.objects.get("pm_erase_gina")?.["customer"]).toBeNull();
    expect(texts.redacted.map((x) => x.sid).sort()).toEqual(["SMgina1", "SMgina2"]);
    expect(texts.redacted.every((x) => x.key.startsWith("erase:redact:"))).toBe(true);
    expect(
      await one(
        "select state, pending, (removed->>'cards_detached')::int as cards from erasures where subject_id = $1",
        [gina],
      ),
    ).toEqual({ state: "done", pending: {}, cards: 1 });
    expect(
      await one(
        "select provider_body_purged_at is not null as purged from messages where id = $1",
        [ginaMessage],
      ),
    ).toEqual({ purged: true });
    expect(
      await one("select outcome from card_detaches where source = 'booking' and source_id = $1", [
        ginaBooking,
      ]),
    ).toEqual({ outcome: "detached" });

    // The audit rows the erase wrote name the fields, never the values.
    const audit = await raw.query<{
      old_values: unknown;
      new_values: unknown;
      changed_fields: string[];
    }>(
      "select old_values, new_values, changed_fields from audit_log where id > $1 and target = $2",
      [auditBefore, `guests/${gina}`],
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]!.changed_fields).toEqual(
      expect.arrayContaining(["name", "phone_e164", "email"]),
    );
    const written = JSON.stringify(
      (await raw.query("select old_values, new_values from audit_log where id > $1", [auditBefore]))
        .rows,
    );
    for (const value of ["Gina", "+12125550911", "gina@example.com", "Your room is ready"])
      expect(written).not.toContain(value);

    // A second call answers with the same erasure and changes nothing.
    const again = await post("abhishek", `/guests/${gina}/erase`);
    expect(again.statusCode).toBe(200);
    expect(again.json().erasure.id).toBe(r.json().erasure.id);
  });

  it("a later booking with that number sends no text, because the opt-out hash matches", async () => {
    expect(
      (
        await raw.query(
          "select 1 from consents where venue_id = $1 and phone_e164 = '+12125550911'",
          [venueId],
        )
      ).rowCount,
    ).toBe(0);
    await raw.query(
      "insert into guests (venue_id, name, phone_e164) values ($1, 'Gina S.', '+12125550911')",
      [venueId],
    );
    await withVenue(pool, { venueId }, async (c) => {
      expect(await optedOut(c, venueId, "+12125550911")).toBe(true);
      await expect(
        guardSend(c, venueId, "+12125550911", clock.now(), { allowList: null }),
      ).rejects.toMatchObject({
        details: { reason: "opted_out" },
      });
    });
  });

  it("keeps a message under a legal hold whole and counts it", async () => {
    const r = await post("abhishek", `/guests/${hal}/erase`);
    expect(r.statusCode).toBe(200);
    expect(r.json().erasure).toMatchObject({ held_messages: 1, pending_messages: 0 });
    expect(await one("select body from messages where id = $1", [halMessage])).toEqual({
      body: "See you at 9, Hal",
    });
    expect(await one("select name from guests where id = $1", [hal])).toEqual({ name: "" });
    await runJobs();
    expect(texts.redacted.some((x) => x.sid === "SMhal1")).toBe(false);
  });

  it("after Marcus T.'s check is paid, erasing him keeps check #1042, its payments and its audit rows, with no contact details", async () => {
    const check = await one<{ id: string }>(
      "select id from checks where venue_id = $1 and number = 1042",
      [venueId],
    );
    await raw.query("update checks set status = 'paid', paid_at = now() where id = $1", [check.id]);
    // Marcus's deposit, backed by a PaymentIntent that saved his Amex (as stripe:seed does).
    await raw.query(
      `update payments set stripe_pi_id = 'pi_erase_marcus', card_last4 = coalesce(card_last4, '1005')
        where booking_id = $1 and method = 'card_online'`,
      [ids["bk_marcus"]],
    );
    const deposit = { stripe_pi_id: "pi_erase_marcus" };
    fake.put({
      id: deposit.stripe_pi_id,
      object: "payment_intent",
      _account: account,
      customer: "cus_marcus",
      payment_method: "pm_erase_marcus",
    });
    fake.put({
      id: "pm_erase_marcus",
      object: "payment_method",
      _account: account,
      customer: "cus_marcus",
      card: { brand: "amex", last4: "1005" },
    });
    const contact = await one<{ phone_e164: string; email: string | null }>(
      "select phone_e164, email from guests where id = $1",
      [marcus],
    );
    const snapshot = async () => ({
      check: (await raw.query("select * from checks where id = $1", [check.id])).rows,
      payments: (
        await raw.query(
          `select p.* from payments p where p.booking_id = $1 or p.id in
             (select payment_id from payment_allocations where check_id = $2) order by p.id`,
          [ids["bk_marcus"], check.id],
        )
      ).rows,
      audit: (
        await raw.query(
          "select id, old_values, new_values from audit_log where target = $1 order by id",
          [`checks/${check.id}`],
        )
      ).rows,
    });
    const before = await snapshot();
    expect(before.check.length).toBe(1);
    expect(before.audit.length).toBeGreaterThan(0);

    expect((await post("abhishek", `/guests/${marcus}/erase`)).statusCode).toBe(200);
    await runJobs();
    const after = await snapshot();
    expect(after).toEqual(before);
    const text = JSON.stringify(after);
    expect(text).not.toContain(contact.phone_e164);
    if (contact.email) expect(text).not.toContain(contact.email);
    expect(fake.objects.get("pm_erase_marcus")?.["customer"]).toBeNull();
  });
});

describe("POST /singers/{s}/erase", () => {
  it("a singer who still owes money can't be erased until their tab owes nothing", async () => {
    const hana = await one<{ id: string; check_id: string }>(
      "select id, check_id from singers where venue_id = $1 and display_name = 'Hana K.'",
      [venueId],
    );
    const refused = await post("andy", `/singers/${hana.id}/erase`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("balance_owed");
    expect(await one("select display_name from singers where id = $1", [hana.id])).toEqual({
      display_name: "Hana K.",
    });

    await raw.query("update checks set status = 'paid', paid_at = now() where id = $1", [
      hana.check_id,
    ]);
    const r = await post("andy", `/singers/${hana.id}/erase`);
    expect(r.statusCode).toBe(200);
    expect(
      await one(
        "select display_name, phone_e164, erased_at is not null as erased from singers where id = $1",
        [hana.id],
      ),
    ).toEqual({ display_name: "—", phone_e164: null, erased: true });
    await runJobs();
    expect(await one("select state from erasures where subject_id = $1", [hana.id])).toEqual({
      state: "done",
    });
  });
});

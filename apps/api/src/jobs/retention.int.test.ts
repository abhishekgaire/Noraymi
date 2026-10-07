import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  encryptSecret,
  loadDemoSeed,
  optedOut,
  saveTwilioIntegration,
  withVenue,
  type JobRow,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { FakeStripe } from "../stripe/fake/index.js";
import { StripeClient } from "../stripe/client.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { FakeVenueClient } from "../texts/venue.js";
import { runRetention, type RetentionDeps } from "./retention.js";

/**
 * M8-12 on the demo seed's clock (Fri Sep 25, 2026, 10:41 PM): the nightly
 * retention job pseudonymizes, deletes and purges what's past its time,
 * detaches saved cards on the fake Stripe, redacts bodies at Twilio, keeps
 * opt-outs as hashes, logs counts per kind, and a rerun removes nothing new.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let fake: FakeStripe;
let venueId = "";
let otherVenue = "";
let account = "";
const clock = new SimulatedClock(SEED_NOW);
const secretKey = Buffer.from("e".repeat(64), "hex");
const texts = new FakeVenueClient();
let deps: RetentionDeps;

const local = SEED_NOW.toZonedDateTimeISO("America/New_York");
const ago = (d: { months?: number; days?: number; years?: number }) =>
  local.subtract(d).toInstant().toString();

const run = (venue = venueId) =>
  runRetention(
    {
      job: { id: "test", venue_id: venue } as JobRow,
      clock,
      step: (work) => withVenue(pool, { venueId: venue, requestId: "job:retention-test" }, work),
    },
    deps,
  );
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await raw.query(sql, params)).rows[0] as T;
const insertGuest = async (venue: string, name: string, phone: string, lastSeen: string) =>
  (
    await one<{ id: string }>(
      `insert into guests (venue_id, name, phone_e164, email, last_seen_at, created_at)
       values ($1, $2, $3, $4, $5, $5) returning id`,
      [venue, name, phone, `${name.split(" ")[0]!.toLowerCase()}@example.com`, lastSeen],
    )
  ).id;

let oldGuest = "";
let recentGuest = "";
let otherGuest = "";
let oldPrint = "";
let newPrint = "";
let oldMessage = "";

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  fake = new FakeStripe();
  const base = await fake.start();
  deps = {
    stripe: new StripeClient(fakeStripeSettings(base)),
    texts: { client: texts, secretKey },
  };
  account = "acct_retention";
  await raw.query(
    "update organizations set stripe_account_id = $2 where id = (select org_id from venues where id = $1)",
    [venueId, account],
  );

  // Guests: one last seen 24 months and a day ago (who texted STOP five years ago), one seen yesterday.
  oldGuest = await insertGuest(venueId, "Olga V.", "+12125550901", ago({ months: 24, days: 1 }));
  recentGuest = await insertGuest(venueId, "Rita N.", "+12125550902", ago({ days: 1 }));
  await raw.query(
    `insert into consents (venue_id, guest_id, channel, kind, given_at, source, revoked_at, revoked_via)
     values ($1, $2, 'sms', 'texts', $3, 'form', $3, 'keyword')`,
    [venueId, oldGuest, ago({ years: 5 })],
  );
  // Another venue's guest, just as old: venue A's run never touches it.
  const org = await one<{ id: string }>(
    "insert into organizations (legal_name) values ('Other Venue LLC') returning id",
  );
  otherVenue = (
    await one<{ id: string }>(
      "insert into venues (org_id, name, slug) values ($1, 'Other', 'other-retention') returning id",
      [org.id],
    )
  ).id;
  otherGuest = await insertGuest(otherVenue, "Owen B.", "+12125550903", ago({ years: 3 }));

  // Print payloads from 31 and 29 days ago.
  const check = await one<{ id: string }>(
    "select id from checks where venue_id = $1 order by number limit 1",
    [venueId],
  );
  const print = async (days: number) =>
    (
      await one<{ id: string }>(
        `insert into print_jobs (venue_id, check_id, kind, payload, status, created_at)
         values ($1, $2, 'check', '{"lines":["Room 9"]}', 'printed', $3) returning id`,
        [venueId, check.id, ago({ days })],
      )
    ).id;
  oldPrint = await print(31);
  newPrint = await print(29);

  // Bar tabs: Hana K.'s closed 8 days ago, Jess P.'s 6 days ago, each with the card its tap saved.
  for (const [name, pm, days] of [
    ["Hana K.", "pm_ret_hana", 8],
    ["Jess P.", "pm_ret_jess", 6],
  ] as const) {
    fake.put({
      id: pm,
      object: "payment_method",
      _account: account,
      customer: `cus_${pm}`,
      card: { brand: "visa", last4: "4242" },
    });
    await raw.query(
      `update payments set generated_card_pm = $3
        where venue_id = $1 and id = (select payment_id from tabs where venue_id = $1 and name = $2)`,
      [venueId, name, pm],
    );
    await raw.query("update tabs set closed_at = $3 where venue_id = $1 and name = $2", [
      venueId,
      name,
      ago({ days }),
    ]);
  }

  // Singers 31 days past their last song: Hana K. still owes on her open tab, Sofia R. owes nothing.
  await raw.query(
    "update singers set last_song_at = $2 where venue_id = $1 and display_name in ('Hana K.', 'Sofia R.')",
    [venueId, ago({ days: 31 })],
  );

  // A text sent 4 years and a day ago (its conversation's last), and the venue's Twilio subaccount.
  const conv = await one<{ id: string }>(
    `insert into conversations (venue_id, phone_e164, created_at) values ($1, '+12125550904', $2) returning id`,
    [venueId, ago({ years: 4, days: 1 })],
  );
  oldMessage = (
    await one<{ id: string }>(
      `insert into messages (venue_id, conversation_id, direction, category, body, provider_sid, status, created_at)
       values ($1, $2, 'outbound', 'service', 'Your room is ready', 'SMold', 'delivered', $3) returning id`,
      [venueId, conv.id, ago({ years: 4, days: 1 })],
    )
  ).id;
  await withVenue(pool, { venueId }, (c) =>
    saveTwilioIntegration(c, venueId, {
      accountSid: "ACretention",
      phoneE164: "+12125550100",
      secretEnc: encryptSecret(secretKey, "token"),
      at: SEED_NOW.toString(),
    }),
  );

  // An incident past its keep_until (3 years), with a note.
  const incident = await one<{ id: string }>(
    `insert into incidents (venue_id, kind, reported_via, reported_by, at, status, closed_at, closed_by, keep_until)
     select $1, 'other', 'staff_phone', m.user_id, $2, 'closed', $2, m.user_id, $3
       from memberships m where m.venue_id = $1 limit 1 returning id`,
    [venueId, ago({ years: 3, days: 2 }), ago({ days: 1 })],
  );
  await raw.query(
    `insert into incident_notes (venue_id, incident_id, added_by, text, added_at)
     select $1, $2, m.user_id, 'Walked the guest out', $3 from memberships m where m.venue_id = $1 limit 1`,
    [venueId, incident.id, ago({ years: 3, days: 2 })],
  );
}, 120_000);

afterAll(async () => {
  await fake?.stop();
  await pool?.end();
  await raw?.end();
  await db?.drop();
});

describe("the nightly retention job", () => {
  let first: Awaited<ReturnType<typeof run>>;

  it("runs on the simulated clock and logs what it removed, by kind and count", async () => {
    first = await run();
    const log = await one<{ removed: Record<string, number> }>(
      "select removed from retention_runs where venue_id = $1 order by ran_at desc limit 1",
      [venueId],
    );
    expect(log.removed).toEqual(first.removed);
    expect(log.removed).toMatchObject({
      guests: 1,
      print_payloads: 1,
      tab_cards: 1,
      messages: 1,
      consents: 1,
      incidents: 1,
      opt_out_hashes: 1,
      message_bodies_at_twilio: 1,
    });
    expect(first.skipped).toEqual({});
    // Counts only: the log holds no names, numbers or bodies.
    expect(JSON.stringify(log)).not.toMatch(/Olga|\+1212|room is ready/);
  });

  it("pseudonymizes a guest last seen 24 months and a day ago, and not one seen yesterday", async () => {
    const old = await one<{
      name: string;
      phone_e164: string | null;
      email: string | null;
      erased_at: Date | null;
    }>("select name, phone_e164, email, erased_at from guests where id = $1", [oldGuest]);
    expect(old).toMatchObject({ name: "", phone_e164: null, email: null });
    expect(old.erased_at).not.toBeNull();
    const recent = await one<{ name: string; erased_at: Date | null }>(
      "select name, erased_at from guests where id = $1",
      [recentGuest],
    );
    expect(recent).toEqual({ name: "Rita N.", erased_at: null });
  });

  it("keeps the opt-out as a hash, so the number is never texted again", async () => {
    const n = await one<{ n: string }>("select count(*) as n from consents where guest_id = $1", [
      oldGuest,
    ]);
    expect(Number(n.n)).toBe(0);
    expect(await withVenue(pool, { venueId }, (c) => optedOut(c, venueId, "+12125550901"))).toBe(
      true,
    );
    expect(await withVenue(pool, { venueId }, (c) => optedOut(c, venueId, "+12125550902"))).toBe(
      false,
    );
    const h = await one<{ phone_hash: string }>(
      "select phone_hash from opt_out_hashes where venue_id = $1",
      [venueId],
    );
    expect(h.phone_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.phone_hash).not.toContain("2125550901");
  });

  it("purges a print payload from 31 days ago and keeps one from 29 days ago", async () => {
    const rows = await raw.query<{ id: string; payload: unknown }>(
      "select id, payload from print_jobs where id = any($1)",
      [[oldPrint, newPrint]],
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.payload]));
    expect(byId[oldPrint]).toEqual({});
    expect(byId[newPrint]).toEqual({ lines: ["Room 9"] });
  });

  it("detaches the card on a bar tab closed 8 days ago, and not one closed 6 days ago", async () => {
    expect(fake.objects.get("pm_ret_hana")?.["customer"]).toBeNull();
    expect(fake.objects.get("pm_ret_jess")?.["customer"]).toBe("cus_pm_ret_jess");
    const d = await one<{ outcome: string; stripe_payment_method_id: string }>(
      "select outcome, stripe_payment_method_id from card_detaches where venue_id = $1 and source = 'tab'",
      [venueId],
    );
    expect(d).toEqual({ outcome: "detached", stripe_payment_method_id: "pm_ret_hana" });
  });

  it("keeps a singer 31 days past their last song who still owes money, and removes one who doesn't", async () => {
    const rows = await raw.query<{ display_name: string; phone_e164: string | null }>(
      "select display_name, phone_e164 from singers where venue_id = $1",
      [venueId],
    );
    const names = rows.rows.map((r) => r.display_name);
    expect(names).toContain("Hana K.");
    expect(names).not.toContain("Sofia R.");
    expect(names).toContain("Ben T.");
  });

  it("deletes the texts 4 years after the last one, redacts bodies at Twilio after 30 days, and deletes old incidents", async () => {
    expect((await raw.query("select 1 from messages where id = $1", [oldMessage])).rowCount).toBe(
      0,
    );
    expect(texts.redacted).toEqual([
      { account: "ACretention", sid: "SMold", key: `retention:redact:${oldMessage}` },
    ]);
    expect(
      Number(
        (
          await one<{ n: string }>("select count(*) as n from incidents where venue_id = $1", [
            venueId,
          ])
        ).n,
      ),
    ).toBe(0);
  });

  it("writes the audit trail as field names only, never the old values", async () => {
    const a = await one<{ old_values: unknown; changed_fields: string[] }>(
      "select old_values, changed_fields from audit_log where target = $1 order by id desc limit 1",
      [`guests/${oldGuest}`],
    );
    expect(a.changed_fields).toEqual(expect.arrayContaining(["name", "phone_e164", "email"]));
    expect(JSON.stringify(a.old_values ?? {})).not.toMatch(/Olga|2125550901/);
  });

  it("never touches another venue's rows", async () => {
    const g = await one<{ name: string; erased_at: Date | null }>(
      "select name, erased_at from guests where id = $1",
      [otherGuest],
    );
    expect(g).toEqual({ name: "Owen B.", erased_at: null });
  });

  it("removes nothing new on a second run", async () => {
    const again = await run();
    for (const [kind, count] of Object.entries(again.removed))
      expect([kind, count]).toEqual([kind, 0]);
  });
});

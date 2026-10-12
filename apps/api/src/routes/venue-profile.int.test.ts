import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { Worker, generateSigningKey, publishRulePack, withVenue, type PaymentRow } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, builtInRulePacks } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";
import { settleDeposit } from "../bookings/confirm.js";
import { BOOKING_INBOX_KIND, makeBookingInboxHandler } from "../bookings/inbox.js";
import { loadEmailSettings } from "../email/settings.js";
import { SmtpMailer } from "../email/mailer.js";
import { EMAIL_SEND_KIND, makeSendEmailHandler } from "../jobs/send-email.js";

/**
 * O-03 acceptance: Your venue's answers (the name, the legal name, the address, the guest phone
 * and the booking inbox) are saved through Admin → Venue's routes and the settings routes, show in
 * Admin → Venue and Admin → Phone & texts, and change the checklist. An address outside New York
 * City is refused with "contact us". A new online booking sends one email to each booking inbox
 * address (Mailpit) and none when it's empty. `contacts` is the owner's alone and walled per
 * venue. No EIN column exists anywhere.
 */
const ORIGIN = "http://localhost:5173";
const KEY = "d".repeat(64);
const OWNER_EMAIL = "owner-venue@example.com";
const MANAGER_EMAIL = "manager-venue@example.com";
const MAILPIT = process.env["MAILPIT_URL"] ?? "http://localhost:8025";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
let rw: pg.Pool;
let ownerCookie = "";
let managerCookie = "";
let managerMembership = "";
const clock = new FrozenClock(SEED_NOW);

const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;
const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const raw = r.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw[0] : raw;
  return typeof line === "string" ? line.split(";")[0]! : "";
};
const call = (method: "GET" | "PUT", url: string, cookie: string, body?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });

async function passkeySession(email: string): Promise<string> {
  const key = new SoftwarePasskey("localhost");
  const post = (body: unknown) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/enroll",
      payload: body as Record<string, unknown>,
    });
  expect((await post({ step: "start", email })).statusCode).toBe(200);
  const job = await owner.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [email],
  );
  const code = job.rows[0]!.payload.data.code;
  const opts = json(await post({ step: "passkey_options", email, code }));
  const finish = await post({
    step: "passkey_finish",
    email,
    code,
    credential: key.register(opts["options"] as { challenge: string }, ORIGIN),
    name: "Phone",
    client: "web",
  });
  expect(finish.statusCode, finish.body).toBe(201);
  return cookieOf(finish);
}

const astoria = {
  line1: "31-18 Steinway St",
  line2: null,
  city: "Astoria",
  state: "NY",
  postal_code: "11103",
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  rw = appPool(db.url);
  await owner.query("update users set email = $2 where id = $1", [v.ownerA, OWNER_EMAIL]);
  const m = await owner.query<{ id: string }>(
    "insert into users (name, email) values ('Maya', $1) returning id",
    [MANAGER_EMAIL],
  );
  managerMembership = (
    await owner.query<{ id: string }>(
      "insert into memberships (venue_id, user_id, role, status, pin_digits) values ($1, $2, 'manager', 'active', 6) returning id",
      [v.venueA, m.rows[0]!.id],
    )
  ).rows[0]!.id;
  await publishRulePack(owner, {
    pack: builtInRulePacks[0]!,
    effectiveOn: "2026-09-01",
    approvedBy: ["Abhishek Gaire", "Claude Code"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  await owner.query("update venues set address = null where id = $1", [v.venueA]);
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_ORIGINS: ORIGIN,
    }),
    clock,
    moduleCacheMs: 0,
  });
  await app.ready();
  ownerCookie = await passkeySession(OWNER_EMAIL);
  managerCookie = await passkeySession(MANAGER_EMAIL);
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await rw.end();
  await db.drop();
});

describe("Your venue and Admin → Venue (O-03)", () => {
  const url = () => `/v1/venues/${v.venueA}/profile`;

  it("saves the name, legal name and address; the checklist follows", async () => {
    const before = json(await call("GET", `/v1/venues/${v.venueA}/setup`, ownerCookie)) as {
      checklist: { steps: { id: string; mark: string; missing: string[] }[] };
    };
    expect(before.checklist.steps[0]!.missing).toEqual(["address", "guestPhone"]);
    const put = await call("PUT", url(), ownerCookie, {
      name: "Sing Sing Karaoke Astoria",
      legal_name: "Sing Sing Karaoke LLC",
      address: astoria,
    });
    expect(put.statusCode, put.body).toBe(200);
    const got = json(await call("GET", url(), ownerCookie)) as {
      profile: { name: string; legal_name: string; address: unknown; time_zone: string };
    };
    expect(got.profile).toMatchObject({
      name: "Sing Sing Karaoke Astoria",
      legal_name: "Sing Sing Karaoke LLC",
      address: astoria,
      time_zone: "America/New_York",
    });
    const phone = await call("PUT", `/v1/venues/${v.venueA}/settings/phone`, ownerCookie, {
      value: { callNumber: "+17185550100", textNumber: null },
    });
    expect(phone.statusCode, phone.body).toBe(200);
    // Admin → Phone & texts reads the same number.
    const read = json(await call("GET", `/v1/venues/${v.venueA}/settings/phone`, managerCookie));
    expect(read["value"]).toEqual({ callNumber: "+17185550100", textNumber: null });
    const after = json(await call("GET", `/v1/venues/${v.venueA}/setup`, ownerCookie)) as {
      checklist: { steps: { id: string; mark: string }[] };
    };
    expect(after.checklist.steps[0]!.mark).toBe("done");
  });

  it("refuses an address outside New York with contact us; the time zone never changes", async () => {
    const r = await call("PUT", url(), ownerCookie, {
      name: "Sing Sing",
      legal_name: "Sing Sing Karaoke LLC",
      address: { ...astoria, city: "Hoboken", state: "NJ", postal_code: "07030" },
    });
    expect(r.statusCode).toBe(400);
    expect(json(r)).toMatchObject({
      error: { message: "This address is outside New York · contact us" },
    });
    expect(
      (
        await call("PUT", url(), ownerCookie, {
          name: "X",
          legal_name: "Y",
          address: null,
          time_zone: "America/Chicago",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("Admin → Venue and the contacts are the owner's alone", async () => {
    expect((await call("GET", url(), managerCookie)).statusCode).toBe(403);
    expect(
      (await call("PUT", url(), managerCookie, { name: "X", legal_name: "Y", address: null }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call("GET", `/v1/venues/${v.venueA}/settings/contacts`, managerCookie)).statusCode,
    ).toBe(403);
    const empty = json(await call("GET", `/v1/venues/${v.venueA}/settings/contacts`, ownerCookie));
    expect(empty["value"]).toEqual({
      bookingEmails: [],
      onCall: { first: null, second: null },
      breach: { primary: null, backup: null },
    });
    const tooMany = await call("PUT", `/v1/venues/${v.venueA}/settings/contacts`, ownerCookie, {
      value: {
        ...(empty["value"] as object),
        bookingEmails: ["a@x.test", "b@x.test", "c@x.test", "d@x.test"],
      },
    });
    expect(tooMany.statusCode).toBe(400);
    // Only an active owner or manager can be named; a bartender can't.
    const bartenderMembership = (
      await owner.query<{ id: string }>(
        "select id from memberships where venue_id = $1 and user_id = $2",
        [v.venueA, v.bartenderA],
      )
    ).rows[0]!.id;
    const bartender = await call("PUT", `/v1/venues/${v.venueA}/settings/contacts`, ownerCookie, {
      value: {
        ...(empty["value"] as object),
        breach: { primary: bartenderMembership, backup: null },
      },
    });
    expect(bartender.statusCode).toBe(400);
    const named = await call("PUT", `/v1/venues/${v.venueA}/settings/contacts`, ownerCookie, {
      value: {
        ...(empty["value"] as object),
        breach: { primary: managerMembership, backup: null },
      },
    });
    expect(named.statusCode, named.body).toBe(200);
  });

  it("a new online booking emails each booking inbox address once, and none when empty", async () => {
    await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
    const room = await owner.query<{ id: string }>(
      "insert into rooms (venue_id, name, size_tier, capacity_min, capacity_max) values ($1, 'Room 3', 'medium', 2, 8) returning id",
      [v.venueA],
    );
    const book = async (name: string, hour: number) => {
      const guest = await owner.query<{ id: string }>(
        "insert into guests (venue_id, name) values ($1, $2) returning id",
        [v.venueA, name],
      );
      const starts = `2026-09-26T0${hour}:00:00Z`;
      const b = await owner.query<{ id: string }>(
        `insert into bookings (venue_id, guest_id, room_id, size_tier, party_size, starts_at, ends_at, business_date, status, source)
           values ($1, $2, $3, 'medium', 6, $4, $4::timestamptz + interval '2 hours', '2026-09-25', 'pending', 'web') returning id`,
        [v.venueA, guest.rows[0]!.id, room.rows[0]!.id, starts],
      );
      const id = b.rows[0]!.id;
      const outcome = await withVenue(rw, { venueId: v.venueA }, (c) =>
        settleDeposit(
          c,
          v.venueA,
          {
            id: crypto.randomUUID(),
            booking_id: id,
            method: "card_online",
            training: false,
          } as unknown as PaymentRow,
          clock.now(),
        ),
      );
      expect(outcome).toBe("confirmed");
      return id;
    };
    const settings = loadEmailSettings("local", process.env);
    const drain = async () => {
      const mailer = new SmtpMailer(settings.smtpUrl);
      try {
        const w = new Worker(rw, {
          pool: "normal",
          handlers: {
            [BOOKING_INBOX_KIND]: makeBookingInboxHandler(settings),
            [EMAIL_SEND_KIND]: makeSendEmailHandler(mailer, settings),
          },
          clock,
          random: () => 0.5,
        });
        while ((await w.tick()) > 0) {
          /* drain */
        }
      } finally {
        mailer.close();
      }
    };
    const inboxJobs = async () =>
      (
        await owner.query<{ n: number }>(
          "select count(*)::int as n from jobs where venue_id = $1 and kind = 'email.send' and payload->>'template' = 'booking_inbox'",
          [v.venueA],
        )
      ).rows[0]!.n;

    // Empty inbox: no email.
    await owner.query(
      `update venue_settings set value = jsonb_set(value, '{bookingEmails}', '[]') where venue_id = $1 and key = 'contacts'`,
      [v.venueA],
    );
    await book("Dana", 1);
    await drain();
    expect(await inboxJobs()).toBe(0);

    // Two addresses: one email each.
    const contacts = json(
      await call("GET", `/v1/venues/${v.venueA}/settings/contacts`, ownerCookie),
    )["value"] as object;
    const saved = await call("PUT", `/v1/venues/${v.venueA}/settings/contacts`, ownerCookie, {
      value: { ...contacts, bookingEmails: ["Bookings@SingSing.test", "jin@singsing.test"] },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await book("Marcus T.", 3);
    await drain();
    expect(await inboxJobs()).toBe(2);
    for (const to of ["bookings@singsing.test", "jin@singsing.test"]) {
      const found = (await (
        await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
      ).json()) as { messages: { ID: string; Subject: string }[] };
      expect(found.messages).toHaveLength(1);
      expect(found.messages[0]!.Subject).toMatch(/^New booking · Marcus T\., 6 guests, /);
      const full = (await (
        await fetch(`${MAILPIT}/api/v1/message/${found.messages[0]!.ID}`)
      ).json()) as {
        Text: string;
      };
      expect(full.Text).toContain("Room: Room 3");
      expect(full.Text).not.toMatch(/card ending|\*\*\*\*|\d{4} \d{4}/i);
    }
  });

  it("venue wall: venue B never reads or writes venue A's contacts", async () => {
    const seen = await withVenue(rw, { venueId: v.venueB, userId: v.ownerB }, (c) =>
      c.query("select 1 from venue_settings where venue_id = $1 and key = 'contacts'", [v.venueA]),
    );
    expect(seen.rowCount).toBe(0);
    await expect(
      withVenue(rw, { venueId: v.venueB, userId: v.ownerB }, (c) =>
        c.query(
          `insert into venue_settings (venue_id, key, version, value, starts_on) values ($1, 'contacts', 99, '{}', '2026-09-01')`,
          [v.venueA],
        ),
      ),
    ).rejects.toThrow();
    // Through the API: venue B's owner asking for venue A's contacts is refused.
    expect(
      (await call("GET", `/v1/venues/${v.venueB}/settings/contacts`, ownerCookie)).statusCode,
    ).toBe(403);
  });

  it("no EIN column exists anywhere", async () => {
    const cols = await owner.query(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and column_name ~* '(^|_)(ein|tax_id|fein)($|_)'",
    );
    expect(cols.rows).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { generateSigningKey, publishRulePack, Worker, withVenue } from "@west4/db";
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
import { loadEmailSettings } from "../email/settings.js";
import { SmtpMailer } from "../email/mailer.js";
import { EMAIL_SEND_KIND, makeSendEmailHandler } from "../jobs/send-email.js";

/**
 * O-01 acceptance: the Console's New venue makes an organization, a venue and
 * an invited owner and nothing else; a slug already taken is refused; a second
 * venue under an existing organization shares its Stripe account. The owner's
 * invite is emailed (Mailpit) with a 7-day link that runs the invite path to a
 * passkey; Send again ends the old link, refused as replaced, and an old link
 * is refused as expired. Only Console staff can call the routes, and a venue's
 * own people never see the new venue's rows.
 */
const CONSOLE = "http://localhost:5174";
const STAFF_ORIGIN = "http://localhost:5173";
const KEY = "e".repeat(64);
const STAFF_EMAIL = "lee@noraymi.test";
const MAILPIT = process.env["MAILPIT_URL"] ?? "http://localhost:8025";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
let rw: pg.Pool;
let cookie = "";
const clock = new FrozenClock(SEED_NOW);
const securityKey = new SoftwarePasskey("localhost", "usb");
const ownerPasskey = new SoftwarePasskey("localhost");

const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { error?: { code: string; message: string } };
const cookiesOf = (r: { headers: Record<string, unknown> }): string => {
  const raw = r.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.map((l) => String(l).split(";")[0]!).join("; ");
};
const call = (method: "GET" | "POST", url: string, body?: unknown, headers = {}) =>
  app.inject({
    method,
    url,
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    headers,
  });
const asStaff = (method: "GET" | "POST", url: string, body?: unknown) =>
  call(method, url, body, { cookie });

async function latestJob(kind: string, to: string): Promise<Record<string, unknown>> {
  const r = await owner.query<{ payload: Record<string, unknown> }>(
    "select payload from jobs where kind = $1 and payload->>'to' = $2 order by created_at desc limit 1",
    [kind, to],
  );
  return r.rows[0]!.payload;
}
const tokenOf = (url: string) => url.split("/invite/")[1]!;

const newVenue = (over: Record<string, unknown> = {}) => ({
  name: "Sing Sing Karaoke Astoria",
  slug: "sing-sing",
  legal_name: "Sing Sing Karaoke LLC",
  owner_name: "Jin Park",
  owner_email: "jin@singsing.test",
  reason: "Onboarding Sing Sing, call with Jin on Oct 12",
  ...over,
});

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  rw = appPool(db.url);
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGINS: STAFF_ORIGIN,
    CONSOLE_URL: CONSOLE,
  });
  app = buildApp({ config, clock, moduleCacheMs: 0 });
  await app.ready();
  await owner.query("insert into console_staff (name, email) values ('Lee', $1)", [STAFF_EMAIL]);
  await publishRulePack(owner, {
    pack: builtInRulePacks[0]!,
    effectiveOn: "2026-09-01",
    approvedBy: ["Abhishek Gaire", "Claude Code"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  const sso = await call("POST", "/v1/console/auth/local", { email: STAFF_EMAIL });
  const ssoCookie = cookiesOf(sso);
  const start = json(
    await call("POST", "/v1/console/auth/key", { step: "start" }, { cookie: ssoCookie }),
  );
  const finish = await call(
    "POST",
    "/v1/console/auth/key",
    {
      step: "finish",
      credential: securityKey.register(start["options"] as { challenge: string }, CONSOLE),
      name: "Test key",
    },
    { cookie: ssoCookie },
  );
  expect(finish.statusCode, finish.body).toBe(201);
  cookie = cookiesOf(finish);
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await rw.end();
  await db.drop();
});

describe("New venue (O-01)", () => {
  let venueId = "";
  let orgId = "";

  it("makes an organization, a venue and an invited owner, and nothing else", async () => {
    const r = await asStaff("POST", "/v1/console/venues", newVenue());
    expect(r.statusCode, r.body).toBe(201);
    const body = json(r) as {
      venue: { id: string; slug: string; time_zone: string; rule_pack_id: string };
      org_id: string;
      owner: { status: string };
    };
    venueId = body.venue.id;
    orgId = body.org_id;
    expect(body.venue).toMatchObject({
      slug: "sing-sing",
      time_zone: "America/New_York",
      rule_pack_id: builtInRulePacks[0]!.id,
    });
    expect(body.owner.status).toBe("invited");
    const venue = await owner.query(
      "select v.day_cutover::text as cutover, v.address, o.legal_name from venues v join organizations o on o.id = v.org_id where v.id = $1",
      [venueId],
    );
    expect(venue.rows[0]).toEqual({
      cutover: "06:00:00",
      address: null,
      legal_name: "Sing Sing Karaoke LLC",
    });
    const members = await owner.query(
      "select m.role, m.status, u.email from memberships m join users u on u.id = m.user_id where m.venue_id = $1",
      [venueId],
    );
    expect(members.rows).toEqual([
      { role: "owner", status: "invited", email: "jin@singsing.test" },
    ]);
    // Nothing else: no settings, rooms, hours, prices, contacts, modules or devices.
    for (const table of ["venue_settings", "rooms", "venue_modules", "devices", "menu_items"]) {
      const n = await owner.query(`select count(*)::int as n from ${table} where venue_id = $1`, [
        venueId,
      ]);
      expect({ table, n: n.rows[0]!.n }).toEqual({ table, n: 0 });
    }
    // Who and why: the reason kept with the venue, the staff member as the audit actor.
    const why = await owner.query<{ reason: string; actor: string; email: string }>(
      `select o.reason, a.actor, s.email from venue_onboarding o
         join audit_log a on a.venue_id = o.venue_id and a.action = 'venues.insert'
         join console_staff s on s.id = a.actor
        where o.venue_id = $1`,
      [venueId],
    );
    expect(why.rows[0]).toMatchObject({ reason: newVenue().reason, email: STAFF_EMAIL });
  });

  it("refuses a web name already taken", async () => {
    const r = await asStaff(
      "POST",
      "/v1/console/venues",
      newVenue({ name: "Another", owner_email: "x@singsing.test" }),
    );
    expect(r.statusCode, r.body).toBe(409);
    expect(json(r).error?.message).toMatch(/already taken/);
    const bad = await asStaff("POST", "/v1/console/venues", newVenue({ slug: "Not OK!" }));
    expect(bad.statusCode).toBe(400);
  });

  it("a second venue under an existing organization shares its Stripe account", async () => {
    await owner.query(
      "update organizations set stripe_account_id = 'acct_singsing' where id = $1",
      [orgId],
    );
    const orgs = await asStaff("GET", "/v1/console/organizations");
    expect(orgs.statusCode, orgs.body).toBe(200);
    expect((json(orgs)["organizations"] as { id: string }[]).map((o) => o.id)).toContain(orgId);
    const r = await asStaff(
      "POST",
      "/v1/console/venues",
      newVenue({
        name: "Sing Sing Two",
        slug: "sing-sing-two",
        legal_name: undefined,
        org_id: orgId,
      }),
    );
    expect(r.statusCode, r.body).toBe(201);
    expect(json(r)).toMatchObject({ org_id: orgId, stripe_account_id: "acct_singsing" });
    // The same owner (by email) is the same person at both venues.
    const users = await owner.query(
      "select count(distinct user_id)::int as n from memberships m join venues v on v.id = m.venue_id where v.org_id = $1",
      [orgId],
    );
    expect(users.rows[0]!.n).toBe(1);
  });

  it("emails a 7-day invite; Send again ends the old link; the link runs the invite path to a passkey", async () => {
    await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
    const first = await asStaff("POST", `/v1/console/venues/${venueId}/owner-invite`, {});
    expect(first.statusCode, first.body).toBe(200);
    expect(json(first)["expires_at"]).toBe(clock.now().add({ hours: 168 }).toString());
    const firstToken = tokenOf(
      ((await latestJob("email.send", "jin@singsing.test"))["data"] as { inviteUrl: string })
        .inviteUrl,
    );
    const list = json(await asStaff("GET", "/v1/console/venues")) as {
      venues: { id: string; owner: { status: string; invite_expires_at: string | null } }[];
    };
    expect(list.venues.find((x) => x.id === venueId)?.owner).toMatchObject({
      status: "invited",
      invite_expires_at: expect.any(String),
    });

    const again = await asStaff("POST", `/v1/console/venues/${venueId}/owner-invite`, {});
    expect(again.statusCode, again.body).toBe(200);
    const mail = (await latestJob("email.send", "jin@singsing.test")) as {
      template: string;
      data: { inviteUrl: string; expiresDays: number };
    };
    expect(mail.template).toBe("owner_invite");
    expect(mail.data.expiresDays).toBe(7);
    const token = tokenOf(mail.data.inviteUrl);
    expect(token).not.toBe(firstToken);
    expect(json(await call("GET", `/v1/invites/${firstToken}`))["state"]).toBe("replaced");
    expect(json(await call("GET", `/v1/invites/${token}`))).toMatchObject({
      state: "open",
      role: "owner",
      needs_passkey: true,
      venue_name: "Sing Sing Karaoke Astoria",
    });

    // The email itself, through the local mail catcher.
    const settings = loadEmailSettings("local", process.env);
    const mailer = new SmtpMailer(settings.smtpUrl);
    try {
      const worker = new Worker(rw, {
        pool: "normal",
        handlers: { [EMAIL_SEND_KIND]: makeSendEmailHandler(mailer, settings) },
        clock,
        random: () => 0.5,
      });
      while ((await worker.tick()) > 0) {
        /* drain */
      }
    } finally {
      mailer.close();
    }
    const found = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent("to:jin@singsing.test")}`)
    ).json()) as { messages: { Subject: string }[] };
    expect(found.messages.map((m) => m.Subject)).toContain(
      "Set up Sing Sing Karaoke Astoria on the staff app",
    );

    // The invite path: phone, PIN, then a passkey with the code it hands back.
    const phone = "+17185550142";
    const sent = await call("POST", `/v1/invites/${token}/phone`, {
      phone_e164: phone,
      captcha_token: "XXXX.DUMMY.TOKEN.XXXX",
    });
    expect(sent.statusCode, sent.body).toBe(200);
    // A new venue hasn't connected its own Twilio yet (T-03; D123): the code goes to her email.
    expect(json(sent)).toMatchObject({ sent_by: "email", email_hint: "j•••@singsing.test" });
    const code = ((await latestJob("email.send", "jin@singsing.test"))["data"] as { code: string })
      .code;
    expect(
      (await call("POST", `/v1/invites/${token}/phone/verify`, { phone_e164: phone, code }))
        .statusCode,
    ).toBe(200);
    const done = await call("POST", `/v1/invites/${token}/finish`, { pin: "730915", locale: "en" });
    expect(done.statusCode, done.body).toBe(200);
    const enrol = json(done) as { enrol_code: string; email: string };
    const opts = json(
      await call("POST", "/v1/auth/enroll", {
        step: "passkey_options",
        email: enrol.email,
        code: enrol.enrol_code,
      }),
    );
    const passkey = await call("POST", "/v1/auth/enroll", {
      step: "passkey_finish",
      email: enrol.email,
      code: enrol.enrol_code,
      credential: ownerPasskey.register(opts["options"] as { challenge: string }, STAFF_ORIGIN),
      name: "Jin's phone",
      client: "web",
    });
    expect(passkey.statusCode, passkey.body).toBe(201);
    const after = json(await asStaff("GET", "/v1/console/venues")) as {
      venues: {
        id: string;
        owner: { status: string };
        setup: { done: number; total: number; onboarded: boolean };
      }[];
    };
    const listed = after.venues.find((x) => x.id === venueId)!;
    expect(listed.owner.status).toBe("active");
    // O-02: the Console's count is the wizard's own, and the owner's sign-in says setup is pending.
    const ownerCookie = cookiesOf(passkey);
    const setup = json(
      await call("GET", `/v1/venues/${venueId}/setup`, undefined, { cookie: ownerCookie }),
    ) as {
      checklist: { done: number; total: number };
    };
    expect(listed.setup).toMatchObject({
      done: setup.checklist.done,
      total: 12,
      onboarded: true,
    });
    const me = json(await call("GET", "/v1/auth/me", undefined, { cookie: ownerCookie })) as {
      memberships: { venue_id: string; setup: string | null }[];
    };
    expect(me.memberships.find((m) => m.venue_id === venueId)?.setup).toBe("pending");
    // Signed in now: a second invite is refused.
    const late = await asStaff("POST", `/v1/console/venues/${venueId}/owner-invite`, {});
    expect(late.statusCode).toBe(409);
  });

  it("refuses a link after its 7 days as expired", async () => {
    const r = await asStaff(
      "POST",
      "/v1/console/venues",
      newVenue({ name: "Third", slug: "third-venue", owner_email: "third@singsing.test" }),
    );
    const id = (json(r)["venue"] as { id: string }).id;
    await asStaff("POST", `/v1/console/venues/${id}/owner-invite`, {});
    const token = tokenOf(
      ((await latestJob("email.send", "third@singsing.test"))["data"] as { inviteUrl: string })
        .inviteUrl,
    );
    clock.set(clock.now().add({ hours: 7 * 24 + 1 }));
    try {
      expect(json(await call("GET", `/v1/invites/${token}`))["state"]).toBe("expired");
    } finally {
      clock.set(SEED_NOW);
    }
  });

  it("only Console staff can call the routes", async () => {
    for (const [method, url] of [
      ["GET", "/v1/console/organizations"],
      ["POST", "/v1/console/venues"],
      ["POST", `/v1/console/venues/${venueId}/owner-invite`],
    ] as const) {
      const r = await call(method, url, method === "POST" ? newVenue({ slug: "nope" }) : undefined);
      expect([401, 403]).toContain(r.statusCode);
    }
    // The definer door itself refuses anyone who isn't active Console staff.
    await expect(
      withVenue(rw, { venueId: v.venueA, userId: v.ownerA }, (c) =>
        c.query(
          "select * from console_create_venue($1, null, 'X', 'X', 'x-x', 'p', 'o', 'o@x.test')",
          [crypto.randomUUID()],
        ),
      ),
    ).rejects.toThrow(/only Console staff/);
    await expect(
      withVenue(rw, { venueId: v.venueA, userId: v.ownerA }, (c) =>
        c.query("select * from console_organizations()"),
      ).then((r) => r.rows.length),
    ).resolves.toBe(0);
  });

  it("venue wall: venue A's people never see the new venue's rows", async () => {
    const seen = await withVenue(rw, { venueId: v.venueA, userId: v.ownerA }, async (c) => ({
      venues: (await c.query("select id from venues where id = $1", [venueId])).rowCount,
      onboarding: (await c.query("select 1 from venue_onboarding where venue_id = $1", [venueId]))
        .rowCount,
      memberships: (await c.query("select 1 from memberships where venue_id = $1", [venueId]))
        .rowCount,
    }));
    expect(seen).toEqual({ venues: 0, onboarding: 0, memberships: 0 });
    const inserted = withVenue(rw, { venueId: v.venueA, userId: v.ownerA }, (c) =>
      c.query(
        "insert into venue_onboarding (venue_id, created_by, reason) values ($1, $2, 'wall')",
        [venueId, crypto.randomUUID()],
      ),
    );
    await expect(inserted).rejects.toThrow();
  });
});

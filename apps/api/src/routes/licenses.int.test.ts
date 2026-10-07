import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue, Worker } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { FakeMailer } from "../email/mailer.js";
import { loadEmailSettings } from "../email/settings.js";
import { EMAIL_SEND_KIND, makeSendEmailHandler } from "../jobs/send-email.js";
import { FakePushSender } from "../push/sender.js";
import { PUSH_SEND_KIND, makePushSendHandler } from "../push/send-push.js";
import {
  LICENSE_REMINDER_KIND,
  enqueueLicenseReminders,
  makeLicenseReminderHandler,
} from "../licenses/licenses.js";

/**
 * M8-09 acceptance on the demo seed: the register starts empty (nothing is
 * made up for West 4); owners and managers in a passkey session keep each
 * license with its number, holder, expiry, fee, conditions and a PDF copy; and
 * on the simulated clock a license 30 days from expiry reminds Abhishek and
 * Andy once, by email and push, then again at 7 days. The licenses here are
 * the test's own fixtures, not West 4's.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const people: Record<string, Principal> = {};
const email = loadEmailSettings("local", process.env);
const MB = 1024 * 1024;

const as = (who: string, method: "GET" | "POST" | "PATCH", path: string, payload?: object) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    headers: { "x-test-as": who },
    ...(payload ? { payload } : {}),
  });

async function uploadCopy(who: string, contentType: string, bytes: number) {
  const r = await as(who, "POST", "/files", {
    kind: "license_copy",
    content_type: contentType,
    bytes,
  });
  return r;
}

async function putBytes(
  answer: { upload: { url: string; fields: Record<string, string> } },
  bytes: number,
  contentType: string,
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(answer.upload.fields))
    form.set(k, k === "Content-Type" ? contentType : v);
  form.set("file", new Blob([new Uint8Array(bytes)], { type: contentType }), "license");
  return fetch(answer.upload.url, { method: "POST", body: form });
}

/** Runs today's reminder job, then the email and push jobs it queued. */
async function runReminders() {
  const mailer = new FakeMailer();
  const push = new FakePushSender();
  const ownerPool = new pg.Pool({ connectionString: db.url, max: 2 });
  await withVenue(ownerPool, { venueId }, (c) => enqueueLicenseReminders(c, venueId, clock.now()));
  const bulk = new Worker(ownerPool, {
    pool: "bulk",
    handlers: { [LICENSE_REMINDER_KIND]: makeLicenseReminderHandler(email) },
    clock,
    random: () => 0.5,
  });
  while ((await bulk.tick()) > 0);
  const normal = new Worker(ownerPool, {
    pool: "normal",
    handlers: {
      [EMAIL_SEND_KIND]: makeSendEmailHandler(mailer, email),
      [PUSH_SEND_KIND]: makePushSendHandler(push),
    },
    clock,
    random: () => 0.5,
  });
  while ((await normal.tick()) > 0);
  await ownerPool.end();
  return { mails: mailer.sent, pushes: push.sent };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  for (const who of ["abhishek", "andy", "maya", "diego"]) {
    const phone = await raw.query<{ id: string }>(
      "insert into devices (venue_id, kind, name, user_id, public_key) values ($1, 'staff_phone', $2, $3, '{}') returning id",
      [venueId, `${who}'s phone`, ids[who]],
    );
    await raw.query(
      `insert into push_subscriptions (venue_id, device_id, endpoint, keys) values ($1, $2, $3, '{"p256dh":"k","auth":"a"}')`,
      [venueId, phone.rows[0]!.id, `https://push.example.test/${who}`],
    );
  }
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
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("the license register", () => {
  let ascap = "";

  it("starts empty on the demo seed: no number, date or agency is made up for West 4", async () => {
    const r = await as("abhishek", "GET", "/licenses");
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { licenses: unknown[] }).licenses).toEqual([]);
  });

  it("an owner keeps a license with its number, holder, expiry, fee, conditions and a PDF copy", async () => {
    const asked = await uploadCopy("abhishek", "application/pdf", 2 * MB);
    expect(asked.statusCode, asked.body).toBe(201);
    const answer = asked.json() as {
      file_id: string;
      upload: { url: string; fields: Record<string, string> };
    };
    expect((await putBytes(answer, 2 * MB, "application/pdf")).status).toBeLessThan(300);
    const made = await as("abhishek", "POST", "/licenses", {
      kind: "ascap",
      number: "TEST-ASCAP-1",
      holder: "Test Holder LLC",
      authority: "Test agency",
      starts_on: "2025-10-25",
      expires_on: "2026-10-25",
      fee_cents: 123_45,
      conditions: "Test conditions",
      file_id: answer.file_id,
    });
    expect(made.statusCode, made.body).toBe(201);
    const license = (made.json() as { license: Record<string, unknown> }).license;
    expect(license).toMatchObject({
      kind: "ascap",
      number: "TEST-ASCAP-1",
      holder: "Test Holder LLC",
      expires_on: "2026-10-25",
      fee_cents: 12345,
      conditions: "Test conditions",
      file_id: answer.file_id,
      file_type: "application/pdf",
      days_left: 30,
      reminded_days: null,
    });
    ascap = license["id"] as string;
    // The copy now counts: it's attached and its link downloads it.
    const attached = await raw.query<{ attached_at: Date | null }>(
      "select attached_at from files where id = $1",
      [answer.file_id],
    );
    expect(attached.rows[0]!.attached_at).not.toBeNull();
    const link = await as("abhishek", "GET", `/files/${answer.file_id}`);
    expect(link.statusCode, link.body).toBe(200);
    expect((await fetch((link.json() as { url: string }).url)).status).toBe(200);

    // A manager edits it; the list shows it to both.
    const edited = await as("andy", "PATCH", `/licenses/${ascap}`, { conditions: "Edited" });
    expect(edited.statusCode, edited.body).toBe(200);
    const list = (await as("andy", "GET", "/licenses")).json() as {
      licenses: { id: string; conditions: string }[];
    };
    expect(list.licenses.map((l) => [l.id, l.conditions])).toEqual([[ascap, "Edited"]]);
  });

  it("refuses a bad request: unknown kind, impossible date, expiry before start, someone else's file kind", async () => {
    expect((await as("abhishek", "POST", "/licenses", { kind: "tv" })).statusCode).toBe(400);
    expect(
      (await as("abhishek", "POST", "/licenses", { kind: "bmi", expires_on: "2026-02-30" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await as("abhishek", "POST", "/licenses", {
          kind: "bmi",
          starts_on: "2026-12-01",
          expires_on: "2026-11-01",
        })
      ).statusCode,
    ).toBe(400);
    const photo = (
      await raw.query<{ id: string }>(
        `insert into files (venue_id, kind, storage_key, content_type, bytes, uploaded_at)
         values ($1::uuid, 'damage_photo', $1::text || '/lic-test.jpg', 'image/jpeg', 10, now()) returning id`,
        [venueId],
      )
    ).rows[0]!.id;
    const r = await as("abhishek", "POST", "/licenses", { kind: "bmi", file_id: photo });
    expect(r.statusCode).toBe(400);
    expect(
      (await as("abhishek", "PATCH", "/licenses/00000000-0000-4000-8000-000000000000", {}))
        .statusCode,
    ).toBe(404);
  });

  it("is Admin: a bartender, the front desk, or a manager on a PIN session can't read or change it", async () => {
    for (const who of ["maya", "diego", "andyPin"]) {
      expect((await as(who, "GET", "/licenses")).statusCode, who).toBe(403);
      expect((await as(who, "POST", "/licenses", { kind: "bmi" })).statusCode, who).toBe(403);
      expect((await as(who, "PATCH", `/licenses/${ascap}`, { holder: "x" })).statusCode, who).toBe(
        403,
      );
    }
  });

  it("30 days from expiry reminds Abhishek and Andy once, by email and push; the 7-day reminder comes later", async () => {
    const first = await runReminders();
    expect(first.mails.map((m) => m.to).sort()).toEqual([
      "abhishek@demo.west4.local",
      "andy@demo.west4.local",
    ]);
    expect(first.mails[0]!.subject).toBe(
      "ASCAP license at West 4 Boho Karaoke expires October 25, 2026",
    );
    expect(first.mails[0]!.text).toContain("TEST-ASCAP-1");
    expect(first.mails[0]!.text).toContain("Days left: 30.");
    expect(first.pushes.map((p) => p.endpoint).sort()).toEqual([
      "https://push.example.test/abhishek",
      "https://push.example.test/andy",
    ]);
    expect(JSON.parse(first.pushes[0]!.payload).body).toBe(
      "ASCAP license expires 2026-10-25 · renew it",
    );
    const after = (await as("abhishek", "GET", "/licenses")).json() as {
      licenses: { reminded_days: number | null }[];
    };
    expect(after.licenses[0]!.reminded_days).toBe(30);

    // The same day again, and every day down to 8 days left: nothing more.
    expect(await runReminders()).toEqual({ mails: [], pushes: [] });
    for (let day = 1; day <= 22; day++) {
      clock.advance({ hours: 24 });
      const quiet = await runReminders();
      expect(quiet.mails.length + quiet.pushes.length, `day ${day}`).toBe(0);
    }
    // 7 days left: the 7-day reminder, once.
    clock.advance({ hours: 24 });
    const seven = await runReminders();
    expect(seven.mails.map((m) => m.to).sort()).toEqual([
      "abhishek@demo.west4.local",
      "andy@demo.west4.local",
    ]);
    expect(seven.mails[0]!.text).toContain("Days left: 7.");
    expect(seven.pushes).toHaveLength(2);
    clock.advance({ hours: 24 });
    expect(await runReminders()).toEqual({ mails: [], pushes: [] });
    clock.set(SEED_NOW);
  });

  it("61 days out says nothing; at 60 the first reminder goes; a renewal's new expiry starts them over", async () => {
    const made = await as("andy", "POST", "/licenses", {
      kind: "liquor",
      expires_on: "2026-11-25", // 61 days after Sep 25
    });
    expect(made.statusCode, made.body).toBe(201);
    const liquor = (made.json() as { license: { id: string } }).license.id;
    // The ASCAP one was reminded at 30 and 7 days already: only the liquor license counts here.
    await raw.query(
      "update licenses set expires_on = '2027-10-25', reminded_at = null, reminded_days = null where id = $1",
      [ascap],
    );
    expect(await runReminders()).toEqual({ mails: [], pushes: [] });
    clock.advance({ hours: 24 });
    const sixty = await runReminders();
    expect(sixty.mails).toHaveLength(2);
    expect(sixty.mails[0]!.text).toContain("The Liquor license at West 4 Boho Karaoke");
    // Renewed: a year later, with nothing sent yet for the new date.
    const renewed = await as("abhishek", "PATCH", `/licenses/${liquor}`, {
      expires_on: "2027-11-25",
    });
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(renewed.json()).toMatchObject({ license: { reminded_days: null, reminded_at: null } });
    expect(await runReminders()).toEqual({ mails: [], pushes: [] });
    clock.set(SEED_NOW);
  });

  it("Spanish: Andy reads his reminder in Spanish when his language is Spanish", async () => {
    await raw.query("update memberships set locale = 'es' where id = $1", [ids["andy.membership"]]);
    await as("abhishek", "POST", "/licenses", { kind: "bmi", expires_on: "2026-10-01" });
    const r = await runReminders();
    const andy = r.mails.find((m) => m.to === "andy@demo.west4.local")!;
    expect(andy.subject).toBe(
      "La licencia de BMI en West 4 Boho Karaoke vence el 1 de octubre de 2026",
    );
    expect(andy.text).toContain("Días restantes: 6.");
    await raw.query("update memberships set locale = 'en' where id = $1", [ids["andy.membership"]]);
  });
});

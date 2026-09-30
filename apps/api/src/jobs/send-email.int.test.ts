import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Worker, withVenue, type JobRow } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, Temporal } from "@west4/shared";
import { FakeMailer, SmtpMailer } from "../email/mailer.js";
import { loadEmailSettings, type EmailSettings } from "../email/settings.js";
import { EMAIL_SEND_KIND, enqueueEmail, makeSendEmailHandler } from "./send-email.js";

// Needs the local mail catcher (docker-compose.yml: axllent/mailpit) on
// SMTP_URL, with its API on MAILPIT_URL. CI runs the same image.
const MAILPIT = process.env["MAILPIT_URL"] ?? "http://localhost:8025";

let db: TestDatabase;
let pool: pg.Pool;
let v: TwoVenues;
const clock = new FrozenClock();
const local = loadEmailSettings("local", process.env);

const invite = {
  venueName: "West 4 Boho Karaoke",
  inviteeName: "Diego",
  inviterName: "Andy",
  inviteUrl: "https://staff.west4.test/invite/abc123",
  expiresHours: 48,
};

function worker(mailer: FakeMailer | SmtpMailer, settings: EmailSettings): Worker {
  return new Worker(pool, {
    pool: "normal",
    handlers: { [EMAIL_SEND_KIND]: makeSendEmailHandler(mailer, settings) },
    clock,
    random: () => 0.5,
  });
}

async function lastJob(venueId: string): Promise<JobRow> {
  return withVenue(
    pool,
    { venueId },
    async (c) =>
      (
        await c.query<JobRow>(
          "select * from jobs where kind = $1 order by created_at desc limit 1",
          [EMAIL_SEND_KIND],
        )
      ).rows[0]!,
  );
}

async function mailpit(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${MAILPIT}/api/v1/${path}`, init);
  if (!res.ok) throw new Error(`mailpit ${path}: ${res.status}`);
  // DELETE answers a plain "ok"; everything else is JSON.
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  await mailpit("messages", { method: "DELETE" });
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

afterEach(async () => {
  await withVenue(pool, { venueId: v.venueA }, (c) =>
    c.query("update jobs set status = 'done' where kind = $1 and status <> 'done'", [
      EMAIL_SEND_KIND,
    ]),
  );
});

describe("the email job", () => {
  it("an invite email lands in the local catcher, in Spanish, with the job id as its Message-ID", async () => {
    const to = `diego-${Date.now()}@example.com`;
    const jobId = await withVenue(pool, { venueId: v.venueA }, (c) =>
      enqueueEmail(c, local, {
        venueId: v.venueA,
        to,
        locale: "es",
        template: "invite",
        data: invite,
        runAt: clock.now(),
      }),
    );
    expect(jobId).toBeTruthy();
    const mailer = new SmtpMailer(local.smtpUrl);
    try {
      expect(await worker(mailer, local).tick()).toBe(1);
    } finally {
      mailer.close();
    }
    expect((await lastJob(v.venueA)).status).toBe("done");

    const found = (await mailpit(`search?query=${encodeURIComponent(`to:${to}`)}`)) as {
      messages: { ID: string; Subject: string; To: { Address: string }[]; MessageID: string }[];
    };
    expect(found.messages).toHaveLength(1);
    const message = found.messages[0]!;
    expect(message.Subject).toBe("Únete a West 4 Boho Karaoke en la app del personal");
    expect(message.To[0]?.Address).toBe(to);
    expect(message.MessageID).toBe(`job-${jobId}@west4.email`);
    const full = (await mailpit(`message/${message.ID}`)) as { Text: string; HTML: string };
    expect(full.Text).toContain(invite.inviteUrl);
    expect(full.HTML).toContain(`href="${invite.inviteUrl}"`);
    expect(full.Text).toContain("Andy");
  });

  it("a provider error retries with backoff, then dead-letters with the reason", async () => {
    await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query(
        "insert into jobs (venue_id, kind, pool, payload, run_at, max_attempts) values ($1, $2, 'normal', $3, $4, 2)",
        [
          v.venueA,
          EMAIL_SEND_KIND,
          JSON.stringify({
            template: "invite",
            to: "diego@example.com",
            locale: "en",
            data: invite,
          }),
          new Date(clock.now().epochMilliseconds),
        ],
      ),
    );
    const mailer = new FakeMailer();
    mailer.failWith = new Error("451 4.3.0 provider temporarily unavailable");
    const w = worker(mailer, local);

    expect(await w.tick()).toBe(1);
    const first = await lastJob(v.venueA);
    expect(first.status).toBe("queued");
    expect(first.attempts).toBe(1);
    expect(first.last_error).toContain("451 4.3.0");
    const backoffMs = first.run_at.getTime() - clock.now().epochMilliseconds;
    expect(backoffMs).toBeGreaterThan(0);

    // Not due yet: nothing runs.
    expect(await w.tick()).toBe(0);

    clock.advance(Temporal.Duration.from({ milliseconds: backoffMs + 1 }));
    expect(await w.tick()).toBe(1);
    const second = await lastJob(v.venueA);
    expect(second.status).toBe("dead");
    expect(second.attempts).toBe(2);
    expect(second.last_error).toContain("provider temporarily unavailable");
    expect(mailer.sent).toEqual([]);
  });

  it("staging refuses an address outside the allow-list, at enqueue and at send", async () => {
    const staging = loadEmailSettings("staging", {
      SMTP_URL: "smtp://relay.example.com",
      EMAIL_FROM: "West 4 <no-reply@example.com>",
      EMAIL_ALLOW_LIST: "@west4.nyc",
    });
    const options = {
      venueId: v.venueA,
      locale: "en" as const,
      template: "invite" as const,
      data: invite,
      runAt: clock.now(),
    };

    await expect(
      withVenue(pool, { venueId: v.venueA }, (c) =>
        enqueueEmail(c, staging, { ...options, to: "someone@gmail.com" }),
      ),
    ).rejects.toThrow(/outside the staging allow-list/);

    // A job that got in anyway (queued before the list changed) is refused at send time too.
    await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query(
        "insert into jobs (venue_id, kind, pool, payload, run_at, max_attempts) values ($1, $2, 'normal', $3, $4, 1)",
        [
          v.venueA,
          EMAIL_SEND_KIND,
          JSON.stringify({
            template: "invite",
            to: "someone@gmail.com",
            locale: "en",
            data: invite,
          }),
          new Date(clock.now().epochMilliseconds),
        ],
      ),
    );
    const mailer = new FakeMailer();
    expect(await worker(mailer, staging).tick()).toBe(1);
    const refused = await lastJob(v.venueA);
    expect(refused.status).toBe("dead");
    expect(refused.last_error).toMatch(/outside the staging allow-list/);
    expect(refused.last_error).not.toContain("someone@");
    expect(mailer.sent).toEqual([]);

    // Our own address goes through.
    await withVenue(pool, { venueId: v.venueA }, (c) =>
      enqueueEmail(c, staging, { ...options, to: "andy@west4.nyc" }),
    );
    expect(await worker(mailer, staging).tick()).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.from).toBe("West 4 <no-reply@example.com>");
  });
});

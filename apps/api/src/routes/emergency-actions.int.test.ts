import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, openConsoleSession } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { CONSOLE_COOKIE } from "../console/auth.js";
import type { Principal } from "../http/principal.js";
import { ticketText, type TicketPayload } from "../print/ticket.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/**
 * M8-11 acceptance on the demo seed, with two Console principals: Ana (the
 * seed's support account) and Ben (a second person on our side), each in
 * their own Console session. Requeueing a print waits for Ben, then prints
 * REPRINT 2, and Abhishek gets a push and an email naming who asked, who
 * approved and why. Nobody approves their own; a request expires after its
 * time box; nothing outside the four actions runs. Every audit row the action
 * writes names Ana (actor), Ben (approver) and the request, and the chain
 * still verifies. Closing a stuck night runs the normal close: an open room,
 * tab or uncounted drawer still refuses it, and its named fixes roll back.
 */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let venueId = "";
let ana = "";
let ben = "";
const cookies: Record<string, string> = {};
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const people: Record<string, Principal> = {};

interface Emergency {
  id: string;
  state: string;
  status: string;
  requested_by: string;
  decided_by: string | null;
  result: Record<string, unknown> | null;
}
type Json = Record<string, unknown> & {
  emergency_action?: Emergency;
  emergency_actions?: Emergency[];
  error?: { code: string };
};
const body = (r: { body: string }) => JSON.parse(r.body) as Json;

const asConsole = (who: "ana" | "ben", method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({
    method,
    url: `/v1/console/venues/${venueId}/emergency-actions${path}`,
    headers: { cookie: cookies[who]! },
    ...(payload ? { payload } : {}),
  });
const asVenue = (who: string, path: string) =>
  app.inject({
    method: "GET",
    url: `/v1/venues/${venueId}${path}`,
    headers: { "x-test-as": who },
  });

async function sessions() {
  for (const [who, staffId] of [
    ["ana", ana],
    ["ben", ben],
  ] as const) {
    const s = await openConsoleSession(raw, {
      staffId,
      startedAt: clock.now().toString(),
      expiresAt: clock.now().add({ hours: 12 }).toString(),
    });
    cookies[who] = `${CONSOLE_COOKIE}=${s.token}`;
  }
}

async function failedTicket(): Promise<string> {
  const payload: TicketPayload = {
    room: "Room 5",
    accepted_by: "Maya S.",
    accepted_at: SEED_NOW.toString(),
    lines: [{ qty: 4, name: "Bud Light", options: [] }],
  };
  const job = await raw.query<{ id: string }>(
    `insert into print_jobs (venue_id, kind, station, payload, status, failed_at)
     values ($1, 'ticket', 'bar', $2, 'failed', $3) returning id`,
    [venueId, JSON.stringify(payload), SEED_NOW.toString()],
  );
  return job.rows[0]!.id;
}

const ask = (who: "ana" | "ben", payload: object) => asConsole(who, "POST", "", payload);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  for (const [who, role] of [
    ["abhishek", "owner"],
    ["andy", "manager"],
  ] as const)
    people[who] = {
      kind: "user",
      userId: ids[who]!,
      session: "passkey",
      memberships: [{ venueId, membershipId: ids[`${who}.membership`]!, role }],
    };
  ana = (
    await raw.query<{ id: string }>(
      "select id from console_staff where email = 'support@demo.west4.local'",
    )
  ).rows[0]!.id;
  ben = (
    await raw.query<{ id: string }>(
      "insert into console_staff (name, email) values ('Ben on call', 'oncall@demo.west4.local') returning id",
    )
  ).rows[0]!.id;
  await sessions();
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      CONSOLE_URL: "http://localhost:5174",
    }),
    clock,
    stripe,
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
  await app?.close();
  await fake?.stop();
  await raw?.end();
  await db?.drop();
});

describe("emergency actions (M8-11)", () => {
  it("requeues a print only after Ben approves: REPRINT 2, and Abhishek is told who and why", async () => {
    const jobId = await failedTicket();
    const reason = "Bar printer jammed at 2:50 AM; Room 5's ticket never printed";
    const r = await ask("ana", { action: "requeue_print", target: jobId, reason });
    expect(r.statusCode).toBe(200);
    const e = body(r).emergency_action!;
    expect(e.state).toBe("requested");
    // Nothing printed yet: it waits for a second person on our side.
    const before = await raw.query(
      "select 1 from print_jobs where venue_id = $1 and reprint_of = $2",
      [venueId, jobId],
    );
    expect(before.rowCount).toBe(0);
    // Abhishek is told the moment it opens: a push and an email, naming Ana and the reason.
    const opened = await raw.query<{ kind: string; payload: Record<string, unknown> }>(
      "select kind, payload from jobs where venue_id = $1 and dedupe_key like $2 order by kind",
      [venueId, `emergency:${e.id}:opened:${ids["abhishek"]}:%`],
    );
    expect(opened.rows.map((j) => j.kind)).toEqual(["email.send", "push.send"]);
    const openedEmail = opened.rows[0]!.payload as {
      template: string;
      data: Record<string, string>;
    };
    expect(openedEmail.template).toBe("emergency_action");
    expect(openedEmail.data).toMatchObject({
      stage: "opened",
      action: "requeue_print",
      requestedBy: "Noraymi support",
      reason,
    });

    // Ben approves in his own session: it runs at once.
    const ok = await asConsole("ben", "POST", `/${e.id}/approve`);
    expect(ok.statusCode).toBe(200);
    const done = body(ok).emergency_action!;
    expect(done.status).toBe("done");
    expect(done.decided_by).toBe(ben);
    const reprint = await raw.query<{ id: string; reprint_n: number; payload: TicketPayload }>(
      "select id, reprint_n, payload from print_jobs where venue_id = $1 and reprint_of = $2",
      [venueId, jobId],
    );
    expect(reprint.rows).toHaveLength(1);
    expect(
      ticketText(reprint.rows[0]!.payload, {
        timeZone: "America/New_York",
        reprintN: reprint.rows[0]!.reprint_n,
      }).split("\n")[0],
    ).toBe("REPRINT 2");

    // Abhishek is told at once it ran: who asked, who approved, and why.
    const ran = await raw.query<{ kind: string; payload: Record<string, unknown> }>(
      "select kind, payload from jobs where venue_id = $1 and dedupe_key like $2 order by kind",
      [venueId, `emergency:${e.id}:done:${ids["abhishek"]}:%`],
    );
    expect(ran.rows.map((j) => j.kind)).toEqual(["email.send", "push.send"]);
    expect((ran.rows[0]!.payload as { data: object }).data).toMatchObject({
      stage: "done",
      requestedBy: "Noraymi support",
      approvedBy: "Ben on call",
      reason,
    });
    const push = ran.rows[1]!.payload as {
      audience: { user_id: string };
      message: { key: string; params: Record<string, string> };
    };
    expect(push.audience.user_id).toBe(ids["abhishek"]);
    expect(push.message.key).toBe("emergency.push.done");
    expect(push.message.params).toMatchObject({ name: "Noraymi support", approver: "Ben on call" });
    // Only the owner: Andy (a manager) gets nothing.
    const andy = await raw.query("select 1 from jobs where venue_id = $1 and dedupe_key like $2", [
      venueId,
      `emergency:${e.id}:%:${ids["andy"]}:%`,
    ]);
    expect(andy.rowCount).toBe(0);

    // Audit rows: Ana as actor, Ben as approver, the request named; the chain verifies.
    const audit = await raw.query<{ actor: string; approver: string; target: string }>(
      "select actor, approver, target from audit_log where venue_id = $1 and emergency_action_id = $2",
      [venueId, e.id],
    );
    expect(audit.rows.some((a) => a.target === `print_jobs/${reprint.rows[0]!.id}`)).toBe(true);
    expect(audit.rows.every((a) => a.actor === ana && a.approver === ben)).toBe(true);
    const chain = await raw.query<{ id: string | null }>("select verify_audit_chain($1) as id", [
      venueId,
    ]);
    expect(chain.rows[0]!.id).toBeNull();

    // Abhishek reads it in Admin → Console; Andy can't.
    const list = body(await asVenue("abhishek", "/emergency-actions")).emergency_actions!;
    expect(list.find((x) => x.id === e.id)?.state).toBe("done");
    expect((await asVenue("andy", "/emergency-actions")).statusCode).toBe(403);
  });

  it("refuses anyone approving their own; a second approval, a decline after it, or an expired one", async () => {
    const jobId = await failedTicket();
    const e = body(
      await ask("ana", { action: "requeue_print", target: jobId, reason: "ticket lost" }),
    ).emergency_action!;
    const own = await asConsole("ana", "POST", `/${e.id}/approve`);
    expect(own.statusCode).toBe(403);
    expect((await asConsole("ana", "POST", `/${e.id}/decline`)).statusCode).toBe(403);
    // The table refuses it too, whoever writes it.
    await expect(
      raw.query(
        "update emergency_actions set status = 'approved', decided_by = requested_by, decided_at = now() where id = $1",
        [e.id],
      ),
    ).rejects.toThrow(/check/);
    const still = body(await asConsole("ana", "GET", "")).emergency_actions!;
    expect(still.find((x) => x.id === e.id)?.state).toBe("requested");
    // Ben can't withdraw Ana's; Ana can.
    expect((await asConsole("ben", "POST", `/${e.id}/withdraw`)).statusCode).toBe(403);
    expect(body(await asConsole("ana", "POST", `/${e.id}/withdraw`)).emergency_action!.state).toBe(
      "withdrawn",
    );
    expect((await asConsole("ben", "POST", `/${e.id}/approve`)).statusCode).toBe(409);

    // Time-boxed: after 15 minutes nobody can approve it.
    const f = body(
      await ask("ben", { action: "requeue_print", target: jobId, reason: "ticket lost again" }),
    ).emergency_action!;
    clock.advance(Temporal.Duration.from({ minutes: 15 }));
    await sessions();
    const late = await asConsole("ana", "POST", `/${f.id}/approve`);
    expect(late.statusCode).toBe(409);
    expect(body(late).error!.code).toBe("version_conflict");
    expect(
      body(await asConsole("ana", "GET", "")).emergency_actions!.find((x) => x.id === f.id)?.state,
    ).toBe("expired");
    const none = await raw.query(
      "select 1 from print_jobs where venue_id = $1 and reprint_of = $2",
      [venueId, jobId],
    );
    expect(none.rowCount).toBe(0);
  });

  it("runs only the four listed actions, each on the venue's own target", async () => {
    for (const action of ["void_check", "refund_payment", "drop_tables", "requeue_print "])
      expect(
        (await ask("ana", { action, target: "2026-09-25", reason: "not allowed" })).statusCode,
      ).toBe(400);
    // A reason is required.
    const jobId = await failedTicket();
    expect(
      (await ask("ana", { action: "requeue_print", target: jobId, reason: "" })).statusCode,
    ).toBe(400);
    // Another venue's job, or no job at all: not found.
    expect(
      (
        await ask("ana", {
          action: "requeue_print",
          target: "00000000-0000-4000-8000-000000000123",
          reason: "nope",
        })
      ).statusCode,
    ).toBe(404);
    // Fixes belong only to closing a stuck night, and only the named ones.
    expect(
      (
        await ask("ana", {
          action: "requeue_print",
          target: jobId,
          reason: "with fixes",
          fixes: [{ kind: "clear_draft", id: jobId, reason: "stale" }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await ask("ana", {
          action: "close_night",
          target: "2026-09-25",
          reason: "stuck",
          fixes: [{ kind: "close_tab", id: jobId, reason: "skip it" }],
        })
      ).statusCode,
    ).toBe(400);
    // A plain Console session can't reach the venue's own routes.
    const direct = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/nights/2026-09-25/close`,
      headers: { cookie: cookies["ana"]! },
      payload: {},
    });
    expect(direct.statusCode).toBe(403);
  });

  it("closes a stuck night only through the normal close: open rooms, tabs and drawers still refuse it", async () => {
    const shift = await raw.query<{ id: string }>(
      "select id from shifts where venue_id = $1 and ended_at is null limit 1",
      [venueId],
    );
    const fixes = shift.rows[0]
      ? [
          {
            kind: "clock_out_shift",
            id: shift.rows[0].id,
            reason: "Left at 3 AM without clocking out",
          },
        ]
      : [];
    const e = body(
      await ask("ana", {
        action: "close_night",
        target: "2026-09-25",
        reason: "Close won't finish after the manager left",
        fixes,
      }),
    ).emergency_action!;
    const run = body(await asConsole("ben", "POST", `/${e.id}/approve`)).emergency_action!;
    expect(run.status).toBe("failed");
    expect(run.result!["error"]).toBe("night_open");
    const blocking = (run.result!["details"] as { checks: { id: string }[] }).checks.map(
      (x) => x.id,
    );
    expect(blocking).toEqual(expect.arrayContaining(["open_rooms", "open_tabs", "drawers"]));
    // Nothing was closed, and the fix rolled back with the close.
    expect(
      (await raw.query("select 1 from night_closes where venue_id = $1", [venueId])).rowCount,
    ).toBe(0);
    if (shift.rows[0])
      expect(
        (
          await raw.query("select 1 from shifts where id = $1 and ended_at is null", [
            shift.rows[0].id,
          ])
        ).rowCount,
      ).toBe(1);
    // The owner hears it didn't finish.
    const failed = await raw.query(
      "select 1 from jobs where venue_id = $1 and dedupe_key like $2",
      [venueId, `emergency:${e.id}:failed:%`],
    );
    expect(failed.rowCount).toBeGreaterThan(0);
  });

  it("re-syncs one payment and cancels one reader's action against Stripe, outside any transaction", async () => {
    const account = (
      await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
        account: null,
        platform: true,
        idempotencyKey: "west4-account",
        params: { display_name: "West 4 Boho Karaoke" },
      })
    ).id;
    await raw.query("update organizations set stripe_account_id = $1", [account]);
    const location = await stripe.call<{ id: string }>(
      "payments",
      "POST",
      "/v1/terminal/locations",
      {
        account,
        idempotencyKey: "emergency-location",
        params: { display_name: "West 4" },
      },
    );
    const reader = await stripe.call<{ id: string }>("payments", "POST", "/v1/terminal/readers", {
      account,
      idempotencyKey: "emergency-reader",
      params: {
        registration_code: "simulated-s710",
        label: "Front desk S710",
        location: location.id,
      },
    });
    const device = (
      await raw.query<{ id: string }>(
        "insert into devices (venue_id, kind, name, stripe_reader_id) values ($1, 'reader', 'Front desk S710', $2) returning id",
        [venueId, reader.id],
      )
    ).rows[0]!.id;
    const pi = await stripe.call<{ id: string }>("payments", "POST", "/v1/payment_intents", {
      account,
      idempotencyKey: "emergency-pi",
      params: { amount: "1000", currency: "usd", "payment_method_types[]": "card_present" },
    });
    await stripe.call(
      "payments",
      "POST",
      `/v1/terminal/readers/${reader.id}/process_payment_intent`,
      {
        account,
        idempotencyKey: "emergency-process",
        params: { payment_intent: pi.id },
      },
    );
    const c = body(
      await ask("ben", {
        action: "cancel_reader_action",
        target: device,
        reason: "Reader stuck on a guest's card after they left",
      }),
    ).emergency_action!;
    const cancelled = body(await asConsole("ana", "POST", `/${c.id}/approve`)).emergency_action!;
    expect(cancelled.status).toBe("done");
    const after = await stripe.call<{ action: { status: string } | null }>(
      "payments",
      "GET",
      `/v1/terminal/readers/${reader.id}`,
      { account },
    );
    expect(after.action?.status ?? "none").not.toBe("in_progress");

    const payment = await raw.query<{ id: string }>(
      "select id from payments where venue_id = $1 limit 1",
      [venueId],
    );
    if (payment.rows[0]) {
      const p = body(
        await ask("ben", {
          action: "resync_payment",
          target: payment.rows[0].id,
          reason: "Guest charged but the tab shows unpaid",
        }),
      ).emergency_action!;
      const synced = body(await asConsole("ana", "POST", `/${p.id}/approve`)).emergency_action!;
      expect(["done", "failed"]).toContain(synced.status);
      expect(synced.decided_by).toBe(ana);
    }
  });
});

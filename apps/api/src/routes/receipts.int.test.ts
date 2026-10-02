import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { FakeMailer } from "../email/mailer.js";
import type { Principal } from "../http/principal.js";
import { makeSendEmailHandler } from "../jobs/send-email.js";
import { receiptPrintLines } from "../print/ticket.js";
import { receiptText, type ReceiptModel } from "../receipts/model.js";
import { presentCheck } from "../rooms/present.js";

/** Receipts (M4-19): Room 9's receipt, the same printed, texted, emailed and on the web. */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let andy: Principal | undefined;

const staff = (method: "GET" | "POST", path: string, payload?: object) =>
  api.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": randomUUID() },
    ...(payload ? { payload } : {}),
  });
const receipt = (token: string) =>
  api.inject({ method: "GET", url: `/v1/public/receipts/${token}` });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  andy = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" } as never],
  };
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async (request) => (request.url.startsWith("/v1/public/") ? undefined : andy)],
  });
  await api.ready();
  await owner.query(
    "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
    [ids["order_o1"]],
  );
  await withVenue(app, { venueId }, (c) =>
    presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
  );
  // $498.60 in cash with a $5.00 cash tip.
  const cash = await staff("POST", `/checks/${ids["chk_room9"]}/payments`, {
    method: "cash",
    amount_cents: 49860,
    tendered_cents: 50500,
    tip_cents: 500,
  });
  expect(cash.statusCode, cash.body).toBe(201);
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("Room 9's receipt", () => {
  let model: ReceiptModel;
  let textToken = "";

  it("reads the same printed, texted, emailed and on the web", async () => {
    for (const body of [
      { channel: "print" },
      { channel: "text", to: "+16465550134" },
      { channel: "email", to: "marcus@example.com" },
    ]) {
      const r = await staff("POST", `/checks/${ids["chk_room9"]}/receipts`, body);
      expect(r.statusCode, r.body).toBe(201);
    }
    const text = (
      await owner.query<{ body: string }>(
        `select m.body from messages m join message_templates t on t.id = m.template_id
          where t.key = 'receipt' order by m.created_at desc limit 1`,
      )
    ).rows[0]!.body;
    expect(text).toMatch(
      /^Thanks for singing with us\. Your receipt for \$618\.60: http:\/\/localhost:3001\/receipt\//,
    );
    textToken = /\/receipt\/([A-Za-z0-9_-]+)/.exec(text)![1]!;
    const web = await receipt(textToken);
    expect(web.statusCode, web.body).toBe(200);
    expect(web.headers["cache-control"]).toContain("no-store");
    model = web.json();
    const lines = receiptText(model);

    const printed = (
      await owner.query<{ payload: { lines: string[] } }>(
        "select payload from print_jobs where kind = 'receipt' and check_id = $1",
        [ids["chk_room9"]],
      )
    ).rows[0]!.payload;
    expect(printed.lines).toEqual(lines);
    const job = (
      await owner.query<{ id: string; payload: { data: { lines: string[] } } }>(
        "select id, payload from jobs where kind = 'email.send' order by created_at desc limit 1",
      )
    ).rows[0]!;
    expect(job.payload.data.lines).toEqual(lines);
    // The email: the same lines, the link, and the receipt PDF attached.
    const mailer = new FakeMailer();
    await makeSendEmailHandler(
      mailer,
      {
        env: "local",
        smtpUrl: "smtp://x",
        from: "West 4 <no-reply@example.com>",
        allowList: null,
      } as never,
      async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    )({ job: { ...job, payload: job.payload } } as never);
    expect(mailer.sent[0]!.text.startsWith(lines.join("\n"))).toBe(true);
    expect(mailer.sent[0]!.attachments?.[0]).toMatchObject({
      filename: "receipt-Check1042.pdf",
      contentType: "application/pdf",
    });
    // Printed 32 wide, every amount on its line.
    expect(receiptPrintLines(printed, { reprintN: 0 }).every((l) => l.length <= 32)).toBe(true);
  });

  it("has every line: tax of $28.58 and $14.02, Gratuity included (20%), Deposit −$120.00, the payment and #1042", () => {
    const lines = receiptText(model);
    expect(model.number).toBe("Check #1042");
    expect(lines).toEqual(
      expect.arrayContaining([
        "Room time · 161 min at $120.00 an hour  $322.00",
        "Tax · room time (8.875%)  $28.58",
        "Tax · drinks (8.875%)  $14.02",
        "Gratuity included (20%)  $96.00",
        "Total  $618.60",
        "Deposit  −$120.00",
        "Paid in cash  −$498.60",
        "Additional tip (optional)  $5.00",
        "Left to pay  $0.00",
        "Paid in full · thank you",
      ]),
    );
    // A tip is never called gratuity.
    expect(lines.filter((l) => /Gratuity/.test(l))).toEqual(["Gratuity included (20%)  $96.00"]);
    expect(model.opened).toMatch(/E[DS]T$/);
  });

  it("after a refund, the same link shows the refunded state", async () => {
    const pay = (
      await owner.query<{ id: string }>(
        "select id from payments where method = 'cash' and status = 'captured' order by created_at desc limit 1",
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into payment_allocations (venue_id, payment_id, check_id, amount_cents, kind, state)
       values ($1, $2, $3, -1000, 'refund', 'captured')`,
      [venueId, pay, ids["chk_room9"]],
    );
    const again = (await receipt(textToken)).json();
    expect(again).toMatchObject({
      status: "partly_refunded",
      status_label: "Partly refunded · $10.00 back",
    });
  });

  it("a wrong or expired token answers not found", async () => {
    expect((await receipt("not-a-real-receipt-token")).statusCode).toBe(404);
    clock.set(SEED_NOW.add({ hours: 24 * 31 }));
    expect((await receipt(textToken)).statusCode).toBe(404);
    clock.set(SEED_NOW);
  });
});

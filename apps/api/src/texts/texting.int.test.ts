import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Worker, encryptSecret, parseAuthSecretKey, withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, TEXTING_DEFAULTS, type TextingSettings } from "@west4/shared";
import { MESSAGE_SEND_KIND } from "./queue.js";
import { TEXT_SEND_KIND, enqueueText, makeSendTextHandler } from "../jobs/send-text.js";
import { makeSendMessageHandler } from "../jobs/send-message.js";
import { ApiError } from "../http/errors.js";
import { textsLive } from "./live.js";
import { guardSend, queueOutbound } from "./queue.js";
import { receiveText, sendReply } from "./inbox.js";
import { FakeVenueClient } from "./venue.js";

/**
 * F-01 (D124): texting switched off venue-wide, or text by text, sends nothing to Twilio and lets
 * the fallbacks run; a text queued before the switch is dropped; STOP and HELP still answer.
 */
const KEY = parseAuthSecretKey("d".repeat(64));
const SID = `AC${"7".repeat(32)}`;
const local = { requireApprovedCampaign: false, allowList: null };
let db: TestDatabase;
let pool: pg.Pool;
let owner: pg.Pool;
let v: TwoVenues;
let version = 0;
const clock = new FrozenClock(SEED_NOW);

const setTexting = async (patch: Partial<TextingSettings>) => {
  version += 1;
  await owner.query(
    `insert into venue_settings (venue_id, key, version, value, starts_on) values ($1, 'texting', $2, $3, '2026-09-25')`,
    [v.venueA, version, JSON.stringify({ ...TEXTING_DEFAULTS, ...patch })],
  );
};
const inA = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  withVenue(pool, { venueId: v.venueA }, fn as never) as Promise<T>;

const worker = (handlers: Record<string, never>) =>
  new Worker(pool, { pool: "normal", handlers, clock, random: () => 0.5 });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  await owner.query(
    `insert into integrations (venue_id, kind, status, external_id, config)
       values ($1, 'twilio', 'connected', $2, $3)`,
    [
      v.venueA,
      SID,
      JSON.stringify({
        phone_e164: "+12125550190",
        secret_enc: encryptSecret(KEY, "venue-token"),
        campaign: { service_sid: `MG${"8".repeat(32)}`, status: "approved" },
      }),
    ],
  );
  await owner.query(
    "insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'guest_texts', true, 'on') on conflict (venue_id, module_id) do update set state = 'on', allowed = true",
    [v.venueA],
  );
});

beforeEach(() => setTexting({}));

afterAll(async () => {
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("the texting switch (F-01)", () => {
  it("off reads as not live for every staff text, so codes go by email and alerts by push", async () => {
    expect(await inA((c) => textsLive(c, v.venueA, local, "+12125550191", "staffCodes"))).toBe(
      true,
    );
    await setTexting({ on: false });
    for (const kind of ["staffCodes", "orderWaiting", "singerCode", "staffReplies"] as const)
      expect(await inA((c) => textsLive(c, v.venueA, local, "+12125550191", kind))).toBe(false);
    expect(await inA((c) => textsLive(c, v.venueA, local))).toBe(false);
  });

  it("each staff switch turns off only its own text", async () => {
    await setTexting({ orderWaiting: false });
    expect(await inA((c) => textsLive(c, v.venueA, local, undefined, "orderWaiting"))).toBe(false);
    expect(await inA((c) => textsLive(c, v.venueA, local, undefined, "staffCodes"))).toBe(true);
    await setTexting({ staffCodes: false });
    expect(await inA((c) => textsLive(c, v.venueA, local, undefined, "staffCodes"))).toBe(false);
    expect(await inA((c) => textsLive(c, v.venueA, local, undefined, "singerCode"))).toBe(true);
  });

  it("refuses a guest text and a staff reply while off", async () => {
    await setTexting({ on: false });
    const refused = await inA((c) =>
      guardSend(c, v.venueA, "+12125550192", clock.now(), local).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).details).toMatchObject({ reason: "texting_off" });
    // HELP's answer still passes: the carriers require it.
    await inA((c) =>
      guardSend(c, v.venueA, "+12125550192", clock.now(), local, { carrierReply: true }),
    );
    await setTexting({ staffReplies: false });
    // An open conversation (the guest wrote just now), then a reply refused.
    const conversationId = await inA(async (c) => {
      await receiveText(c, v.venueA, {
        from: "+12125550193",
        body: "Running 10 late",
        sid: null,
        now: clock.now(),
      });
      const r = await c.query<{ id: string }>(
        "select id from conversations where venue_id = $1 and phone_e164 = $2",
        [v.venueA, "+12125550193"],
      );
      return r.rows[0]!.id;
    });
    const reply = await inA((c) =>
      sendReply(
        c,
        v.venueA,
        conversationId,
        { body: "No problem", userId: v.ownerA, now: clock.now() },
        local,
      ).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect((reply as ApiError).details).toMatchObject({ reason: "texting_off" });
  });

  it("drops a text queued before the switch went off, but still answers HELP and STOP", async () => {
    const client = new FakeVenueClient();
    const conversationId = await inA(async (c) => {
      await receiveText(c, v.venueA, {
        from: "+12125550194",
        body: "hi",
        sid: null,
        now: clock.now(),
      });
      const r = await c.query<{ id: string }>(
        "select id from conversations where venue_id = $1 and phone_e164 = $2",
        [v.venueA, "+12125550194"],
      );
      const id = r.rows[0]!.id;
      await queueOutbound(c, v.venueA, {
        conversationId: id,
        templateId: null,
        category: "service",
        body: "queued before",
        sentBy: null,
        now: clock.now(),
      });
      return id;
    });
    await setTexting({ on: false });
    await inA((c) =>
      receiveText(c, v.venueA, { from: "+12125550196", body: "HELP", sid: null, now: clock.now() }),
    );
    await inA((c) =>
      receiveText(c, v.venueA, { from: "+12125550194", body: "STOP", sid: null, now: clock.now() }),
    );
    const w = worker({
      [MESSAGE_SEND_KIND]: makeSendMessageHandler(client, { publicApiUrl: null }, KEY) as never,
    });
    while ((await w.tick()) > 0);
    const bodies = client.sent.map((s) => s.text.body);
    expect(bodies).not.toContain("queued before");
    expect(bodies.some((b) => /help|call/i.test(b))).toBe(true);
    expect(bodies.some((b) => /unsubscribed|stop|no more/i.test(b))).toBe(true);
    const dropped = await owner.query<{ status: string }>(
      "select status from messages where conversation_id = $1 and body = 'queued before'",
      [conversationId],
    );
    expect(dropped.rows[0]!.status).not.toBe("sent");
  });

  it("a singer's code waits for its own switch when the job runs", async () => {
    const client = new FakeVenueClient();
    await inA((c) =>
      enqueueText(c, {
        venueId: v.venueA,
        runAt: clock.now(),
        template: "phone_code",
        to: "+12125550195",
        locale: "en",
        for: "singer",
        data: { venueName: "West 4", code: "111222", minutes: 10 },
      }),
    );
    await setTexting({ singerCode: false });
    const w = worker({
      [TEXT_SEND_KIND]: makeSendTextHandler(
        { client, settings: local, secretKey: KEY },
        () => {},
      ) as never,
    });
    expect(await w.tick()).toBe(1);
    expect(client.sent).toEqual([]);
  });
});

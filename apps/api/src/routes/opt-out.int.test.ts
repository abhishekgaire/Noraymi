import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { Worker, encryptSecret, loadDemoSeed, saveTwilioIntegration, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makeSendMessageHandler } from "../jobs/send-message.js";
import { MESSAGE_SEND_KIND, queueText } from "../texts/queue.js";
import { twilioSignature, type VenueTextClient } from "../texts/venue.js";

/** M2-23 acceptance on the demo seed: STOP and HELP, and the send path after an opt-out. */
const KEY = "f".repeat(64);
const secretKey = Buffer.from(KEY, "hex");
const ACCOUNT = "AC00000000000000000000000000west4";
const TOKEN = "west4-subaccount-token";
const WEST4 = "+12125550000";
const SAM = "+12125550110";
const MARCUS = "+19175550187";
const BIANCA = "+17185550199";
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const sent: { to: string; body: string }[] = [];
const client: VenueTextClient = {
  send: async (_account, text) => {
    sent.push({ to: text.to, body: text.body });
    return { sid: `SM_out_${sent.length}` };
  },
};
let sid = 0;
const incoming = (from: string, body: string) => {
  const params = {
    AccountSid: ACCOUNT,
    MessageSid: `SM_in_${++sid}`,
    From: from,
    To: WEST4,
    Body: body,
  };
  return app.inject({
    method: "POST",
    url: "/v1/hooks/twilio",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: "api.example.test",
      "x-twilio-signature": twilioSignature(
        TOKEN,
        "https://api.example.test/v1/hooks/twilio",
        params,
      ),
    },
    payload: new URLSearchParams(params).toString(),
  });
};
const drain = async () => {
  const worker = new Worker(pool, {
    pool: "normal",
    clock,
    handlers: {
      [MESSAGE_SEND_KIND]: makeSendMessageHandler(client, { publicApiUrl: null }, secretKey),
    },
  });
  while ((await worker.tick()) > 0);
};
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

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
  await withVenue(pool, { venueId }, (c) =>
    saveTwilioIntegration(c, venueId, {
      accountSid: ACCOUNT,
      phoneE164: WEST4,
      secretEnc: encryptSecret(secretKey, TOKEN),
      at: SEED_NOW.toString(),
    }),
  );
  // Jobs from the seed (none for texts) aside, start from an empty outbox.
  await raw.query("delete from jobs where kind = $1", [MESSAGE_SEND_KIND]);
  const diego: Principal = {
    kind: "user",
    userId: ids["diego"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["diego.membership"]!, role: "front_desk" }],
  };
  process.env["PUBLIC_API_URL"] = "https://api.example.test";
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
    }),
    clock,
    authenticators: [async () => diego],
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

describe("STOP and HELP", () => {
  it("after Sam O. texts STOP, a text already queued stops, his check-in's Room code text never goes, and he gets one confirmation only", async () => {
    // A text queued before the STOP...
    const queued = await withVenue(pool, { venueId }, (c) =>
      queueText(
        c,
        venueId,
        {
          templateKey: "room_ready",
          to: SAM,
          params: { room: "Room 2" },
          guestId: ids["g_sam"]!,
          context: null,
          sentBy: null,
          now: clock.now(),
        },
        { allowList: null },
      ),
    );
    expect((await incoming(SAM, "STOP")).statusCode).toBe(200);
    await drain();
    expect(sent).toEqual([
      {
        to: SAM,
        body: "You're unsubscribed from West 4 Boho Karaoke texts. You won't get any more.",
      },
    ]);
    const stopped = await raw.query<{ status: string }>(
      "select status from messages where id = $1",
      [queued.messageId],
    );
    expect(stopped.rows[0]!.status).toBe("stopped");
    // His check-in: seated, but the Room code text is never written as sending.
    const checkIn = await req("POST", `/bookings/${ids["bk_sam"]}/check-in`, {
      party_size: 3,
      ids_checked: 3,
    });
    expect(checkIn.statusCode, checkIn.body).toBe(201);
    expect(checkIn.json()).toMatchObject({ text: "not_sent" });
    const roomCode = await raw.query(
      "select m.status from messages m join message_templates t on t.id = m.template_id where t.key = 'room_code'",
    );
    expect(roomCode.rows).toEqual([]);
    // A second STOP, or anything else: nothing more goes.
    expect((await incoming(SAM, "stop")).statusCode).toBe(200);
    expect((await incoming(SAM, "HELP")).statusCode).toBe(200);
    await drain();
    expect(sent).toHaveLength(1);
    const consents = await raw.query("select revoked_via from consents where phone_e164 = $1", [
      SAM,
    ]);
    expect(consents.rows).toEqual([{ revoked_via: "keyword" }]);
  });

  it('"please stop texting me" is caught too', async () => {
    await incoming(MARCUS, "please stop texting me");
    await drain();
    expect(sent.at(-1)).toEqual({
      to: MARCUS,
      body: "You're unsubscribed from West 4 Boho Karaoke texts. You won't get any more.",
    });
    const refused = await req("POST", `/conversations/${ids["th_marcus"]}/messages`, {
      body: "Sorry about that",
    });
    expect(refused.json()).toMatchObject({ error: { details: { reason: "opted_out" } } });
  });

  it("staff mark an opt-out with one tap", async () => {
    const thread = (await req("GET", `/conversations/${ids["th_bianca"]}`)).json<{
      messages: { id: string; direction: string }[];
    }>();
    const cake = thread.messages.find((m) => m.direction === "inbound")!;
    const r = await req("POST", `/messages/${cake.id}/opt-out`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ opted_out: true, already: false });
    expect((await req("POST", `/messages/${cake.id}/opt-out`)).json()).toMatchObject({
      already: true,
    });
    const list = (await req("GET", "/conversations")).json<{
      conversations: { phone_e164: string; opted_out: boolean }[];
    }>();
    expect(list.conversations.find((c) => c.phone_e164 === BIANCA)!.opted_out).toBe(true);
    await drain();
    expect(sent.filter((s) => s.to === BIANCA)).toHaveLength(1);
  });

  it("HELP gets West 4 Boho Karaoke and +1 212 255 0011", async () => {
    const AMARA = "+13475550177";
    await incoming(AMARA, "HELP");
    await drain();
    expect(sent.at(-1)).toEqual({
      to: AMARA,
      body: "West 4 Boho Karaoke: for help, call +1 212 255 0011. Reply STOP to stop texts.",
    });
  });
});

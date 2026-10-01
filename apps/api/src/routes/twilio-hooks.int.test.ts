import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import {
  Worker,
  encryptSecret,
  loadDemoSeed,
  saveTwilioIntegration,
  setModuleState,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { makeSendMessageHandler } from "../jobs/send-message.js";
import { MESSAGE_SEND_KIND, queueText } from "../texts/queue.js";
import { TwilioVenueClient, loadVenueTextSettings, twilioSignature } from "../texts/venue.js";

/**
 * M2-09 acceptance. A local stand-in for Twilio's Messages API takes the
 * subaccount's calls (no real credentials are configured here), and a fake
 * callback sender signs status callbacks the way Twilio does.
 */
const KEY = "d".repeat(64);
const secretKey = Buffer.from(KEY, "hex");
const ACCOUNT = "AC00000000000000000000000000west4";
const TOKEN = "west4-subaccount-token";
const FROM = "+12125550000";
const AMARA = "+13475550177";

let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let twilio: Server;
let twilioUrl = "";
const calls: { path: string; auth: string; body: URLSearchParams }[] = [];
let venueId = "";
const clock = new SimulatedClock(SEED_NOW);
const settings = { allowList: null };

const message = async (id: string) =>
  (
    await raw.query<{ status: string; provider_sid: string | null; body: string }>(
      "select status, provider_sid, body from messages where id = $1",
      [id],
    )
  ).rows[0]!;
const worker = () =>
  new Worker(pool, {
    pool: "normal",
    clock,
    handlers: {
      [MESSAGE_SEND_KIND]: makeSendMessageHandler(
        new TwilioVenueClient(twilioUrl),
        { publicApiUrl: "https://api.example.test" },
        secretKey,
      ),
    },
  });
const callback = (params: Record<string, string>, token = TOKEN) =>
  app.inject({
    method: "POST",
    url: "/v1/hooks/twilio/status",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: "api.example.test",
      "x-twilio-signature": twilioSignature(
        token,
        "https://api.example.test/v1/hooks/twilio/status",
        params,
      ),
    },
    payload: new URLSearchParams(params).toString(),
  });
const queue = (
  over: Partial<Parameters<typeof queueText>[2]> = {},
  s: { allowList: readonly string[] | null } = settings,
) =>
  withVenue(pool, { venueId }, (c) =>
    queueText(
      c,
      venueId,
      {
        templateKey: "room_ready",
        to: AMARA,
        params: { room: "Room 11" },
        guestId: null,
        context: null,
        sentBy: null,
        now: clock.now(),
        ...over,
      },
      s,
    ),
  );

beforeAll(async () => {
  twilio = createServer((req, res) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      calls.push({
        path: req.url ?? "",
        auth: req.headers.authorization ?? "",
        body: new URLSearchParams(data),
      });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ sid: `SM${String(calls.length).padStart(32, "0")}`, status: "queued" }),
      );
    });
  });
  await new Promise<void>((done) => twilio.listen(0, "127.0.0.1", done));
  twilioUrl = `http://127.0.0.1:${(twilio.address() as AddressInfo).port}`;
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  await withVenue(pool, { venueId }, (c) =>
    saveTwilioIntegration(c, venueId, {
      accountSid: ACCOUNT,
      phoneE164: FROM,
      secretEnc: encryptSecret(secretKey, TOKEN),
      at: SEED_NOW.toString(),
    }),
  );
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
  });
  process.env["PUBLIC_API_URL"] = "https://api.example.test";
  app = buildApp({ config, clock, moduleCacheMs: 0 });
  await app.ready();
});

afterAll(async () => {
  delete process.env["PUBLIC_API_URL"];
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
  await new Promise((done) => twilio.close(done));
});

describe("guest texts through West 4's subaccount", () => {
  let ready = "";
  let sid = "";

  it("a Room ready text to Amara B. is written as sending, then becomes sent and delivered from Twilio's callbacks", async () => {
    ready = (await queue()).messageId;
    expect(await message(ready)).toMatchObject({
      status: "sending",
      provider_sid: null,
      body: "Your room is ready: Room 11. You have 10 minutes to claim it at the front desk.",
    });
    await worker().tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/2010-04-01/Accounts/${ACCOUNT}/Messages.json`);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64")}`);
    expect(Object.fromEntries(calls[0]!.body)).toMatchObject({
      To: AMARA,
      From: FROM,
      StatusCallback: "https://api.example.test/v1/hooks/twilio/status",
    });
    const sent = await message(ready);
    sid = sent.provider_sid!;
    expect(sent).toMatchObject({ status: "sending" });
    expect(
      (await callback({ AccountSid: ACCOUNT, MessageSid: sid, MessageStatus: "sent" })).statusCode,
    ).toBe(204);
    expect((await message(ready)).status).toBe("sent");
    expect(
      (await callback({ AccountSid: ACCOUNT, MessageSid: sid, MessageStatus: "delivered" }))
        .statusCode,
    ).toBe(204);
    expect((await message(ready)).status).toBe("delivered");
  });

  it("the same job retried after a crash sends nothing twice, and a repeated or late callback changes nothing", async () => {
    await raw.query(
      "update jobs set status = 'queued', attempts = 0, run_at = now() - interval '1 minute' where kind = $1",
      [MESSAGE_SEND_KIND],
    );
    await worker().tick();
    expect(calls).toHaveLength(1);
    expect(
      (await callback({ AccountSid: ACCOUNT, MessageSid: sid, MessageStatus: "delivered" }))
        .statusCode,
    ).toBe(204);
    expect(
      (await callback({ AccountSid: ACCOUNT, MessageSid: sid, MessageStatus: "sent" })).statusCode,
    ).toBe(204);
    expect((await message(ready)).status).toBe("delivered");
    const events = await raw.query("select 1 from webhook_events where event_id like $1", [
      `${sid}:%`,
    ]);
    expect(events.rowCount).toBe(2); // sent and delivered, each once
  });

  it("a failed callback marks the message failed; a bad signature is refused before anything else", async () => {
    const other = (await queue({ params: { room: "Room 8" } })).messageId;
    await worker().tick();
    const otherSid = (await message(other)).provider_sid!;
    expect(
      (
        await callback(
          { AccountSid: ACCOUNT, MessageSid: otherSid, MessageStatus: "failed" },
          "wrong-token",
        )
      ).statusCode,
    ).toBe(403);
    expect((await message(other)).status).toBe("sending");
    expect(
      (
        await callback({
          AccountSid: ACCOUNT,
          MessageSid: otherSid,
          MessageStatus: "undelivered",
          ErrorCode: "30003",
        })
      ).statusCode,
    ).toBe(204);
    expect((await message(other)).status).toBe("failed");
    expect(
      (await callback({ AccountSid: "ACnobody", MessageSid: otherSid, MessageStatus: "sent" }))
        .statusCode,
    ).toBe(403);
  });

  it("a number outside +1 is refused, and staging refuses a number outside our test phones", async () => {
    await expect(queue({ to: "+447700900123" })).rejects.toMatchObject({
      details: { reason: "not_us" },
    });
    await expect(queue({}, { allowList: ["+12125550199"] })).rejects.toMatchObject({
      details: { reason: "not_allowed" },
    });
    expect(() => loadVenueTextSettings("staging", {})).toThrow(/TEXT_ALLOW_LIST/);
    expect(loadVenueTextSettings("staging", { TEXT_ALLOW_LIST: "+12125550199" }).allowList).toEqual(
      ["+12125550199"],
    );
  });

  it("Review ask and Birthday never send, a template that's off never sends, and with Guest texts off no service text does", async () => {
    await expect(queue({ templateKey: "review_ask", params: { link: "x" } })).rejects.toMatchObject(
      { details: { reason: "marketing" } },
    );
    await expect(queue({ templateKey: "birthday", params: {} })).rejects.toMatchObject({
      details: { reason: "marketing" },
    });
    await raw.query(
      `update message_templates set "on" = false where venue_id = $1 and key = 'offer_expiring'`,
      [venueId],
    );
    await expect(
      queue({ templateKey: "offer_expiring", params: { venue: "West 4" } }),
    ).rejects.toMatchObject({ details: { reason: "template_off" } });
    await withVenue(pool, { venueId }, (c) =>
      setModuleState(c, venueId, "guest_texts", "off", undefined),
    );
    await expect(queue()).rejects.toMatchObject({ code: "module_off" });
    await withVenue(pool, { venueId }, (c) =>
      setModuleState(c, venueId, "guest_texts", "on", undefined),
    );
  });

  it("another venue's message never moves on a callback from this venue's account", async () => {
    const venueB = (
      await raw.query<{ id: string }>(
        "insert into venues (org_id, name, slug, address, time_zone) select org_id, 'B', 'b-venue', '{}', 'America/New_York' from venues limit 1 returning id",
      )
    ).rows[0]!.id;
    const conv = (
      await raw.query<{ id: string }>(
        "insert into conversations (venue_id, phone_e164) values ($1, '+12125550100') returning id",
        [venueB],
      )
    ).rows[0]!.id;
    await raw.query(
      "insert into messages (venue_id, conversation_id, direction, category, body, status, provider_sid) values ($1, $2, 'outbound', 'service', 'B', 'sending', 'SMvenueB')",
      [venueB, conv],
    );
    expect(
      (await callback({ AccountSid: ACCOUNT, MessageSid: "SMvenueB", MessageStatus: "delivered" }))
        .statusCode,
    ).toBe(204);
    expect(
      (await raw.query("select status from messages where provider_sid = 'SMvenueB'")).rows[0],
    ).toEqual({ status: "sending" });
  });
});

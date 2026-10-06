import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  Worker,
  encryptSecret,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  saveTwilioIntegration,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makeSendMessageHandler } from "../jobs/send-message.js";
import { FakePushSender } from "../push/sender.js";
import { SINGER_PUSH_KIND, makeSingerPushHandler, planSingerAlerts } from "../songs/alerts.js";
import { MESSAGE_SEND_KIND } from "../texts/queue.js";
import { TEXT_TRIGGER_KIND, makeTextTriggerHandler } from "../texts/triggers.js";
import { twilioSignature, type VenueTextClient } from "../texts/venue.js";

/**
 * Singer alerts (M6-21) on the demo seed: Luis M. is singing, then Jess P., Kira, Ben T., Tariq A., Hana K.
 * and Sofia R. Ben T.'s phone allows alerts and gets "2 singers before you"; when Kira starts he gets
 * "You're up next at the bar · come to the stage" by push and the You're up next text through Twilio (a
 * fake client with the subaccount's test credentials). Songs started and skipped around him never repeat an
 * alert; Tariq A. texts STOP and still gets the push, never the text; with bar mode off nothing is planned.
 */
const KEY = "f".repeat(64);
const secretKey = Buffer.from(KEY, "hex");
const ACCOUNT = "AC00000000000000000000000000west4";
const TOKEN = "west4-subaccount-token";
const WEST4 = "+12125550000";
const BEN = "+16465550163";
const TARIQ = "+19175550171";
const SLUG = "west4karaoke";
let db: TestDatabase;
let owner: pg.Pool;
let pool: pg.Pool;
let api: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
let who: Principal | undefined;
let n = 0;
const clock = new SimulatedClock(SEED_NOW);
const push = new FakePushSender();
const texts: { to: string; body: string }[] = [];
const client: VenueTextClient = {
  send: async (_account, text) => {
    texts.push({ to: text.to, body: text.body });
    return { sid: `SM_out_${texts.length}` };
  },
};
const maya = (): Principal => ({
  kind: "user",
  userId: ids["maya"]!,
  session: "pin",
  memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" } as never],
});
const singer = (slug: string): Principal =>
  ({ kind: "singer", venueId, singerId: ids[slug]! }) as Principal;
const endpointOf = (who: string) => `https://push.example.test/send/${who}`;
const pushesTo = (who: string) =>
  push.sent
    .filter((p) => p.endpoint === endpointOf(who))
    .map((p) => (JSON.parse(p.payload) as { body: string }).body);
const textsTo = (to: string) => texts.filter((x) => x.to === to).map((x) => x.body);

const drain = async () => {
  const worker = new Worker(pool, {
    pool: "normal",
    clock,
    handlers: {
      [SINGER_PUSH_KIND]: makeSingerPushHandler(push),
      [TEXT_TRIGGER_KIND]: makeTextTriggerHandler({ allowList: null }),
      [MESSAGE_SEND_KIND]: makeSendMessageHandler(client, { publicApiUrl: null }, secretKey),
    },
  });
  while ((await worker.tick()) > 0);
};
const subscribe = async (slug: string, endpoint = endpointOf(slug)) => {
  who = singer(slug);
  return api.inject({
    method: "POST",
    url: `/v1/public/venues/${SLUG}/alerts`,
    payload: { endpoint, keys: { p256dh: "BPk3", auth: "a1" } },
  });
};
const songAction = async (song: string, action: "start" | "skip") => {
  who = maya();
  const r = await api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/song-queue/${ids[song]}/${action}`,
    headers: { "idempotency-key": `singer-alerts-${++n}` },
  });
  expect(r.statusCode, r.body).toBeLessThan(300);
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  pool = appPool(db.url);
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
      await owner.query<{ slug: string; id: string }>(
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
  await owner.query("delete from jobs where kind = any($1)", [
    [MESSAGE_SEND_KIND, TEXT_TRIGGER_KIND, SINGER_PUSH_KIND],
  ]);
  process.env["PUBLIC_API_URL"] = "https://api.example.test";
  api = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
    }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("singer alerts", () => {
  it('Ben T. turns alerts on at 2 singers before him and gets "2 singers before you" by push, once', async () => {
    const r = await subscribe("sg_ben");
    expect(r.statusCode, r.body).toBe(201);
    await drain();
    expect(pushesTo("sg_ben")).toEqual(["2 singers before you"]);
    expect(JSON.parse(push.sent[0]!.payload)).toMatchObject({
      title: "West 4 Boho Karaoke",
      url: `/v/${SLUG}/sing`,
    });
    // The same phone again, and a song skipped behind him: no second alert.
    expect((await subscribe("sg_ben")).statusCode).toBe(201);
    await songAction("song_sg_sofia", "skip");
    await drain();
    expect(pushesTo("sg_ben")).toEqual(["2 singers before you"]);
    expect(textsTo(BEN)).toEqual([]);
  });

  it("Tariq A. texts STOP; his phone still allows alerts", async () => {
    const params = {
      AccountSid: ACCOUNT,
      MessageSid: "SM_in_stop",
      From: TARIQ,
      To: WEST4,
      Body: "STOP",
    };
    const r = await api.inject({
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
    expect(r.statusCode).toBe(200);
    expect((await subscribe("sg_tariq")).statusCode).toBe(201);
    // An old browser of his that the push service no longer knows.
    expect((await subscribe("sg_tariq", "https://push.example.test/send/old")).statusCode).toBe(
      201,
    );
    push.gone.add("https://push.example.test/send/old");
    await drain();
    // Tariq A. is 3 singers back (Jess P., Kira, Ben T.): nothing yet.
    expect(pushesTo("sg_tariq")).toEqual([]);
  });

  it("Jess P. starts: Ben T. is 1 singer back and gets nothing new; Tariq A. gets 2 singers before you", async () => {
    await songAction("song_sg_jess", "start");
    await drain();
    expect(pushesTo("sg_ben")).toEqual(["2 singers before you"]);
    expect(pushesTo("sg_tariq")).toEqual(["2 singers before you"]);
    expect(textsTo(BEN)).toEqual([]);
  });

  it("Kira starts: Ben T. gets You're up next by push and by text", async () => {
    await songAction("song_sg_kira", "start");
    await drain();
    expect(pushesTo("sg_ben")).toEqual([
      "2 singers before you",
      "You're up next at the bar · come to the stage",
    ]);
    expect(textsTo(BEN)).toEqual([
      "You're up next at the bar. Come to the stage when this song ends.",
    ]);
  });

  it("songs skipped around him and his phone subscribing again never repeat an alert", async () => {
    await songAction("song_sg_hana", "skip");
    expect((await subscribe("sg_ben")).statusCode).toBe(201);
    await drain();
    expect(pushesTo("sg_ben")).toHaveLength(2);
    expect(textsTo(BEN)).toHaveLength(1);
  });

  it("Ben T. starts: Tariq A., who texted STOP, gets the push but no text", async () => {
    await songAction("song_sg_ben", "start");
    await drain();
    expect(pushesTo("sg_tariq")).toEqual([
      "2 singers before you",
      "You're up next at the bar · come to the stage",
    ]);
    // Only the STOP confirmation ever went to his number.
    expect(textsTo(TARIQ)).toEqual([
      "You're unsubscribed from West 4 Boho Karaoke texts. You won't get any more.",
    ]);
    // Ben T. is singing now: nothing more for him.
    expect(pushesTo("sg_ben")).toHaveLength(2);
    // The push service said the old browser is gone: its subscription is revoked.
    const old = await owner.query<{ revoked: boolean }>(
      "select revoked_at is not null as revoked from singer_push_subscriptions where endpoint = $1",
      ["https://push.example.test/send/old"],
    );
    expect(old.rows[0]?.revoked).toBe(true);
  });

  it("with bar mode off, nothing is planned", async () => {
    await owner.query(
      "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'bar_mode'",
      [venueId],
    );
    const keys = await withVenue(pool, { venueId }, (c) =>
      planSingerAlerts(c, venueId, clock.now()),
    );
    expect(keys).toEqual([]);
    await owner.query(
      "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'bar_mode'",
      [venueId],
    );
    // Back on, every alert that's due has already gone: nothing is planned twice.
    const again = await withVenue(pool, { venueId }, (c) =>
      planSingerAlerts(c, venueId, clock.now()),
    );
    expect(again).toEqual([]);
  });
});

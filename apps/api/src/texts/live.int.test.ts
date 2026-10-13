import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker, encryptSecret, parseAuthSecretKey, withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { TEXT_SEND_KIND, enqueueText, makeSendTextHandler } from "../jobs/send-text.js";
import { textsLive } from "./live.js";
import { FakeVenueClient } from "./venue.js";

/**
 * T-03 (D123): a venue's texts are live only from its own connected Twilio account (and, on a
 * server that waits for one, an approved campaign); a staff text goes from that account and number,
 * and from no account of ours when the venue has none.
 */
const KEY = parseAuthSecretKey("d".repeat(64));
const SID = `AC${"5".repeat(32)}`;
const SERVICE = `MG${"6".repeat(32)}`;
let db: TestDatabase;
let pool: pg.Pool;
let owner: pg.Pool;
let v: TwoVenues;
const clock = new FrozenClock(SEED_NOW);
const local = { requireApprovedCampaign: false, allowList: null };
const production = { requireApprovedCampaign: true, allowList: null };

const connect = (status: "pending" | "approved") =>
  owner.query(
    `insert into integrations (venue_id, kind, status, external_id, config)
       values ($1, 'twilio', 'connected', $2, $3)
       on conflict (venue_id, kind) do update set status = 'connected',
         external_id = excluded.external_id, config = excluded.config`,
    [
      v.venueA,
      SID,
      JSON.stringify({
        phone_e164: "+12125550190",
        secret_enc: encryptSecret(KEY, "venue-token"),
        campaign: { service_sid: SERVICE, status },
      }),
    ],
  );
const live = (settings: typeof local, to?: string) =>
  withVenue(pool, { venueId: v.venueA }, (c) => textsLive(c, v.venueA, settings, to));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("texts are live (T-03)", () => {
  it("only once the venue's own account is connected, and approved where the server waits", async () => {
    expect(await live(local)).toBe(false);
    await connect("pending");
    expect(await live(local)).toBe(true);
    expect(await live(production)).toBe(false);
    await connect("approved");
    expect(await live(production)).toBe(true);
    // +1 only, staging's allow list, and never to a number that opted out.
    expect(await live(local, "+442071234567")).toBe(false);
    expect(await live({ ...local, allowList: ["+12125550191"] }, "+12125550192")).toBe(false);
    expect(await live({ ...local, allowList: ["+12125550191"] }, "+12125550191")).toBe(true);
  });

  it("a staff text goes from the venue's own account and number, through its messaging service", async () => {
    const client = new FakeVenueClient();
    await withVenue(pool, { venueId: v.venueA }, (c) =>
      enqueueText(c, {
        venueId: v.venueA,
        runAt: clock.now(),
        template: "phone_code",
        to: "+12125550193",
        locale: "en",
        data: { venueName: "West 4", code: "123456", minutes: 10 },
      }),
    );
    const worker = new Worker(pool, {
      pool: "normal",
      handlers: {
        [TEXT_SEND_KIND]: makeSendTextHandler({ client, settings: local, secretKey: KEY }),
      },
      clock,
      random: () => 0.5,
    });
    expect(await worker.tick()).toBe(1);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.account).toBe(SID);
    expect(client.sent[0]!.text).toMatchObject({
      to: "+12125550193",
      from: "+12125550190",
      messagingServiceSid: SERVICE,
    });
    expect(client.sent[0]!.text.body).toContain("123456");
  });

  it("with no connection, nothing is sent from any account", async () => {
    await owner.query(
      "update integrations set status = 'disconnected', external_id = null, config = '{}' where venue_id = $1",
      [v.venueA],
    );
    const client = new FakeVenueClient();
    const lines: string[] = [];
    await withVenue(pool, { venueId: v.venueA }, (c) =>
      enqueueText(c, {
        venueId: v.venueA,
        runAt: clock.now(),
        template: "phone_code",
        to: "+12125550194",
        locale: "en",
        data: { venueName: "West 4", code: "654321", minutes: 10 },
      }),
    );
    const worker = new Worker(pool, {
      pool: "normal",
      handlers: {
        [TEXT_SEND_KIND]: makeSendTextHandler({ client, settings: local, secretKey: KEY }, (l) =>
          lines.push(l),
        ),
      },
      clock,
      random: () => 0.5,
    });
    expect(await worker.tick()).toBe(1);
    expect(client.sent).toEqual([]);
    expect(lines.join("\n")).toContain("aren't live");
    expect(lines.join("\n")).not.toContain("654321");
  });
});

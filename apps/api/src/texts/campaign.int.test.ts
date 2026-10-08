import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import {
  Worker,
  encryptSecret,
  loadDemoSeed,
  saveTextCampaign,
  saveTwilioIntegration,
  twilioIntegration,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makeSendMessageHandler } from "../jobs/send-message.js";
import { campaignStatusOf, readCampaignStatus } from "./campaign.js";
import { MESSAGE_SEND_KIND, queueText, type SendSettings } from "./queue.js";
import { FakeVenueClient, loadVenueTextSettings } from "./venue.js";

/**
 * M8-22: texts live on the venue's 10DLC campaign. Production holds every
 * text until the campaign is approved and sends through its messaging
 * service; the marketing rules (own opt-in with proof, 8 AM to 9 PM where
 * the guest is, opt-outs at once) are proven on a test venue with Marketing
 * texts on, though both marketing texts stay off at West 4.
 */
const secretKey = Buffer.from("e".repeat(64), "hex");
const ACCOUNT = "AC00000000000000000000000000camp1";
const SERVICE = "MG" + "a".repeat(32);
const MARKETING = "MG" + "b".repeat(32);
const NY_GUEST = "+12125550161";
const LA_GUEST = "+13105550162";
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
const clock = new SimulatedClock(SEED_NOW);
const client = new FakeVenueClient();
const local = (iso: string, zone = "America/New_York") =>
  Temporal.ZonedDateTime.from(`${iso}[${zone}]`).toInstant();
const production: SendSettings = { allowList: null, requireApprovedCampaign: true };
const queue = (
  over: {
    templateKey?: string;
    to?: string;
    params?: Record<string, string>;
    now?: Temporal.Instant;
  },
  settings: SendSettings = production,
) =>
  withVenue(pool, { venueId }, (c) =>
    queueText(
      c,
      venueId,
      {
        templateKey: over.templateKey ?? "room_ready",
        to: over.to ?? NY_GUEST,
        params: over.params ?? { room: "Room 11" },
        guestId: null,
        context: null,
        sentBy: null,
        now: over.now ?? clock.now(),
      },
      settings,
    ),
  );
const campaign = (which: "service" | "marketing", status: "pending" | "approved") =>
  withVenue(pool, { venueId }, (c) =>
    saveTextCampaign(c, venueId, which, {
      serviceSid: which === "service" ? SERVICE : MARKETING,
      status,
      at: SEED_NOW.toString(),
    }),
  );
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
const marketingOn = async () => {
  await raw.query(
    `update venue_modules set allowed = true, state = 'on' where venue_id = $1 and module_id = 'marketing_texts'`,
    [venueId],
  );
  await raw.query(
    `update message_templates set "on" = true where venue_id = $1 and key = 'birthday'`,
    [venueId],
  );
};
const optIn = (phone: string, proof: { ip: string | null } = { ip: "203.0.113.7" }) =>
  raw.query(
    `insert into consents (venue_id, phone_e164, channel, kind, given_at, source, text_version, ip)
     values ($1, $2, 'sms', 'marketing', $3, 'booking form', 'marketing-v1', $4)`,
    [venueId, phone, SEED_NOW.toString(), proof.ip],
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  await withVenue(pool, { venueId }, (c) =>
    saveTwilioIntegration(c, venueId, {
      accountSid: ACCOUNT,
      phoneE164: "+12125550000",
      secretEnc: encryptSecret(secretKey, "token"),
      at: SEED_NOW.toString(),
    }),
  );
  const m = (
    await raw.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'manager'",
      [venueId],
    )
  ).rows[0]!;
  const andy: Principal = {
    kind: "user",
    userId: m.user_id,
    session: "passkey",
    memberships: [{ venueId, membershipId: m.id, role: "manager" }],
  };
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({ config, clock, authenticators: [async () => andy], moduleCacheMs: 0 });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await pool.end();
  await db.drop();
});

describe("the 10DLC campaign gate", () => {
  it("production always waits for an approved campaign; other servers only when asked", () => {
    expect(loadVenueTextSettings("production", {}).requireApprovedCampaign).toBe(true);
    expect(loadVenueTextSettings("local", {}).requireApprovedCampaign).toBe(false);
    expect(
      loadVenueTextSettings("staging", { TEXT_ALLOW_LIST: "+12125550199" }).requireApprovedCampaign,
    ).toBe(false);
    expect(
      loadVenueTextSettings("local", { TEXT_REQUIRE_CAMPAIGN: "1" }).requireApprovedCampaign,
    ).toBe(true);
  });

  it("Twilio's campaign states read as ours: only VERIFIED is approved", async () => {
    expect(campaignStatusOf([])).toBe("not_registered");
    expect(campaignStatusOf(["IN_PROGRESS"])).toBe("pending");
    expect(campaignStatusOf(["VERIFIED"])).toBe("approved");
    expect(campaignStatusOf(["FAILED"])).toBe("rejected");
    const seen: string[] = [];
    const status = await readCampaignStatus({ accountSid: ACCOUNT, authToken: "t" }, SERVICE, {
      baseUrl: "https://messaging.test",
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify({ compliance: [{ campaign_status: "VERIFIED" }] }));
      }) as unknown as typeof fetch,
    });
    expect(status).toBe("approved");
    expect(seen).toEqual([`https://messaging.test/v1/Services/${SERVICE}/Compliance/Usa2p`]);
  });

  it("holds every text until the campaign is approved, then sends through its messaging service", async () => {
    await expect(queue({})).rejects.toMatchObject({ details: { reason: "campaign_not_approved" } });
    await campaign("service", "pending");
    await expect(queue({})).rejects.toMatchObject({ details: { reason: "campaign_not_approved" } });
    let view = await app.inject({ method: "GET", url: `/v1/venues/${venueId}/texts/campaign` });
    expect(view.json()).toMatchObject({ service: { status: "pending" }, marketing: null });

    await campaign("service", "approved");
    await queue({});
    await drain();
    const last = client.sent.at(-1)!;
    expect(last.text.to).toBe(NY_GUEST);
    expect(last.text.messagingServiceSid).toBe(SERVICE);
    view = await app.inject({ method: "GET", url: `/v1/venues/${venueId}/texts/campaign` });
    expect(view.json()).toMatchObject({ number: "+12125550000", service: { status: "approved" } });
  });

  it("running the subaccount setup again keeps the recorded campaign", async () => {
    await withVenue(pool, { venueId }, (c) =>
      saveTwilioIntegration(c, venueId, {
        accountSid: ACCOUNT,
        phoneE164: "+12125550000",
        secretEnc: encryptSecret(secretKey, "token"),
        at: SEED_NOW.toString(),
      }),
    );
    const t = await withVenue(pool, { venueId }, (c) => twilioIntegration(c, venueId));
    expect(t?.campaign).toMatchObject({ serviceSid: SERVICE, status: "approved" });
  });
});

describe("marketing texts on a test venue with Marketing texts on", () => {
  const birthday = (to: string, now: Temporal.Instant) =>
    queue({ templateKey: "birthday", to, params: {}, now });

  it("stay refused at West 4, where Marketing texts is off", async () => {
    await expect(birthday(NY_GUEST, local("2026-09-25T12:00"))).rejects.toMatchObject({
      details: { reason: "marketing" },
    });
  });

  it("need their own approved campaign and the guest's opt-in with proof", async () => {
    await marketingOn();
    await expect(birthday(NY_GUEST, local("2026-09-25T12:00"))).rejects.toMatchObject({
      details: { reason: "campaign_not_approved" },
    });
    await campaign("marketing", "approved");
    await expect(birthday(NY_GUEST, local("2026-09-25T12:00"))).rejects.toMatchObject({
      details: { reason: "no_marketing_consent" },
    });
    await optIn(NY_GUEST, { ip: null }); // no IP address: no proof
    await expect(birthday(NY_GUEST, local("2026-09-25T12:00"))).rejects.toMatchObject({
      details: { reason: "no_marketing_consent" },
    });
    await optIn(NY_GUEST);
    await birthday(NY_GUEST, local("2026-09-25T12:00"));
    await drain();
    expect(client.sent.at(-1)!.text.messagingServiceSid).toBe(MARKETING);
  });

  it("are refused at 9:05 PM in the recipient's time zone", async () => {
    await expect(birthday(NY_GUEST, local("2026-09-25T21:05"))).rejects.toMatchObject({
      details: { reason: "outside_hours" },
    });
    await optIn(LA_GUEST);
    const la = "America/Los_Angeles";
    await expect(birthday(LA_GUEST, local("2026-09-25T21:05", la))).rejects.toMatchObject({
      details: { reason: "outside_hours" },
    });
    // Noon in Los Angeles is 3 PM at the New York venue: inside both.
    await birthday(LA_GUEST, local("2026-09-25T12:00", la));
  });

  it("an opt-out is honored at once, even for a marketing text already queued", async () => {
    const before = client.sent.length;
    await birthday(NY_GUEST, local("2026-09-25T13:00"));
    await raw.query(
      `insert into consents (venue_id, phone_e164, channel, kind, revoked_at, revoked_via, source)
       values ($1, $2, 'sms', 'texts', $3, 'keyword', 'STOP')`,
      [venueId, NY_GUEST, SEED_NOW.toString()],
    );
    await drain();
    expect(client.sent.slice(before).filter((s) => s.text.to === NY_GUEST)).toEqual([]);
    await expect(birthday(NY_GUEST, local("2026-09-25T14:00"))).rejects.toMatchObject({
      details: { reason: "opted_out" },
    });
  });
});

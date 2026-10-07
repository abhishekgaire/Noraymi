import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { checkOfflineCode, offlineSecretFingerprint, printedOfflineCodes } from "@west4/rules";
import { FrozenClock, SEED_NOW, Temporal, makeDeviceKey, signDeviceRequest } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { hmac } from "./offline-codes.js";

/**
 * M8-04 on the simulated clock (Fri Sep 25, 2026, 10:41 PM): the bar computer
 * sets up its offline-code secret while online; a manager's phone fetches
 * each computer's next 12 hours of codes and tonight's printed codes; a
 * bartender, a tablet and venue B get nothing.
 */
let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let pool: pg.Pool;
let owner: pg.Client;
const clock = new FrozenClock(SEED_NOW);
type Key = Awaited<ReturnType<typeof makeDeviceKey>>;
let bar: { id: string; key: Key };
let desk: { id: string; key: Key };
let tablet: { id: string; key: Key };

const headerAuth = async (request: { headers: Record<string, unknown> }) => {
  const raw = request.headers["x-test-principal"];
  return typeof raw === "string" ? (JSON.parse(raw) as Principal) : undefined;
};
const as = (role: "owner" | "manager" | "bartender", venueId = v.venueA) => ({
  "x-test-principal": JSON.stringify({
    kind: "user",
    userId: v.ownerA,
    session: "passkey",
    memberships: [{ venueId, membershipId: v.membershipA, role }],
  } satisfies Principal),
});

async function device(kind: string, name: string, venueId = v.venueA) {
  const key = await makeDeviceKey();
  const r = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, public_key) values ($1, $2, $3, $4) returning id",
    [venueId, kind, name, JSON.stringify(key.publicJwk)],
  );
  return { id: r.rows[0]!.id, key };
}

async function setup(d: { id: string; key: Key }, fingerprint: string | null, venueId = v.venueA) {
  const path = `/v1/venues/${venueId}/devices/offline-secret`;
  const payload = JSON.stringify({ fingerprint });
  const headers = await signDeviceRequest({
    deviceId: d.id,
    privateKey: d.key.privateKey,
    method: "POST",
    path,
    body: payload,
  });
  const res = await app.inject({
    method: "POST",
    url: path,
    headers: { ...headers, "content-type": "application/json" },
    payload,
  });
  return {
    status: res.statusCode,
    body: res.json() as { device_id: string; secret: string | null },
  };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({ config, clock, authenticators: [headerAuth], moduleCacheMs: 0 });
  await app.ready();
  bar = await device("bar_computer", "Bar computer");
  desk = await device("front_desk", "Front-desk computer");
  tablet = await device("room_tablet", "Room 9 tablet");
}, 120_000);

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await pool?.end();
  await db?.drop();
});

describe("offline codes", () => {
  let secret: string;

  it("the bar computer sets up its secret once; the server keeps it sealed, never plain", async () => {
    const first = await setup(bar, null);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.device_id).toBe(bar.id);
    expect(first.body.secret).toMatch(/^[0-9a-f]{64}$/);
    secret = first.body.secret!;
    // The computer says which secret it holds: the same one changes nothing and hands nothing back.
    const again = await setup(bar, offlineSecretFingerprint(hmac, secret));
    expect(again.body.secret).toBeNull();
    const kept = await owner.query<{ secret_enc: string }>(
      "select secret_enc from device_offline_secrets where device_id = $1",
      [bar.id],
    );
    expect(kept.rows[0]!.secret_enc).not.toContain(secret);
    expect((await setup(desk, null)).status).toBe(200);
  });

  it("a computer that lost its keychain, or holds an old one, gets a new secret", async () => {
    const lost = await setup(bar, "0".repeat(32));
    expect(lost.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(lost.body.secret).not.toBe(secret);
    secret = lost.body.secret!;
  });

  it("only the bar and front-desk computers, and only in their own venue", async () => {
    expect((await setup(tablet, null)).status).toBe(403);
    expect((await setup(bar, null, v.venueB)).status).toBe(403);
  });

  it("a manager's phone gets each computer's next 12 hours of codes, which the computer accepts", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/offline-codes`,
      headers: as("manager"),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      devices: { device_id: string; name: string; codes: { starts_at: string; code: string }[] }[];
    };
    expect(body.devices.map((d) => d.name).sort()).toEqual(["Bar computer", "Front-desk computer"]);
    const barCodes = body.devices.find((d) => d.device_id === bar.id)!.codes;
    expect(barCodes).toHaveLength(144);
    expect(barCodes[0]!.starts_at).toBe("2026-09-26T02:40:00Z");
    const scope = { deviceId: bar.id, timeZone: "America/New_York", dayCutover: "06:00" };
    // 3:15 AM: the code the phone shows then opens the bar computer then.
    const at315 = Temporal.Instant.from("2026-09-26T07:15:00Z");
    const shown = barCodes.find((c) => c.starts_at === "2026-09-26T07:15:00Z")!.code;
    expect(checkOfflineCode(hmac, secret, scope, at315, shown).ok).toBe(true);
    const deskShown = body.devices.find((d) => d.device_id === desk.id)!.codes[0]!.code;
    expect(checkOfflineCode(hmac, secret, scope, SEED_NOW, deskShown).ok).toBe(false);
  });

  it("tonight's printed codes for one computer, or another business date's", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/devices/${bar.id}/offline-codes/printed`,
      headers: as("owner"),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { business_date: string; codes: string[] };
    expect(body.business_date).toBe("2026-09-25");
    expect(body.codes).toEqual(printedOfflineCodes(hmac, secret, bar.id, "2026-09-25"));
    const sat = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/devices/${bar.id}/offline-codes/printed?date=2026-09-26`,
      headers: as("owner"),
    });
    expect((sat.json() as { codes: string[] }).codes[0]).not.toBe(body.codes[0]);
    const none = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/devices/${tablet.id}/offline-codes/printed`,
      headers: as("owner"),
    });
    expect(none.statusCode).toBe(404);
  });

  it("a bartender's phone never gets the codes", async () => {
    for (const url of [
      `/v1/venues/${v.venueA}/offline-codes`,
      `/v1/venues/${v.venueA}/devices/${bar.id}/offline-codes/printed`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: as("bartender") });
      expect(res.statusCode).toBe(403);
    }
  });
});

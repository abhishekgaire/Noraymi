import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { generateSigningKey, publishRulePack } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import {
  FrozenClock,
  SEED_NOW,
  Temporal,
  makeDeviceKey,
  newYorkCounty,
  signDeviceRequest,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepQuietDevices } from "../jobs/device-watch.js";

/**
 * M1-16 on the simulated clock: Fri Sep 25, 2026, 10:41 PM in New York, a
 * venue open 4 PM to 4 AM. 28 devices heartbeat: 25 sign their own, and the
 * bar computer reports its two printers and NFC reader.
 */
let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let pool: pg.Pool;
let owner: pg.Client;
const clock = new FrozenClock(SEED_NOW);
const weekly = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: "16:00", closes: "04:00" }));

interface Dev {
  id: string;
  kind: string;
  key: Awaited<ReturnType<typeof makeDeviceKey>>;
}
const devices: Dev[] = [];
let bar: Dev;
let tablet: Dev;
let cellularPhone: Dev;
let attached: string[] = [];
let venueBDevice: Dev;

const headerAuth = async (request: { headers: Record<string, unknown> }) => {
  const raw = request.headers["x-test-principal"];
  return typeof raw === "string" ? (JSON.parse(raw) as Principal) : undefined;
};
const asOwner = (venueId: string, userId: string, membershipId: string) => ({
  "x-test-principal": JSON.stringify({
    kind: "user",
    userId,
    session: "passkey",
    memberships: [{ venueId, membershipId, role: "owner" }],
  } satisfies Principal),
});
const ownerA = () => asOwner(v.venueA, v.ownerA, v.membershipA);

/** A paired device, inserted as the table owner: pairing itself is M1-15's test, and /claim is rate-limited to 20 a minute. */
async function pairAndClaim(venueId: string, kind: string, name: string): Promise<Dev> {
  const key = await makeDeviceKey();
  const r = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, public_key) values ($1, $2, $3, $4) returning id",
    [venueId, kind, name, JSON.stringify(key.publicJwk)],
  );
  return { id: r.rows[0]!.id, kind, key };
}

async function beat(
  d: Dev,
  body: Record<string, unknown> = {},
): Promise<{ statusCode: number; json: () => Record<string, unknown> }> {
  const payload = JSON.stringify({
    app_version: "1.0.0",
    network: { type: "wifi" },
    clock: new Date(Date.now()).toISOString(),
    ...body,
  });
  const headers = await signDeviceRequest({
    deviceId: d.id,
    privateKey: d.key.privateKey,
    method: "POST",
    path: "/v1/devices/heartbeat",
    body: payload,
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/devices/heartbeat",
    headers: { ...headers, "content-type": "application/json" },
    payload,
  });
  return { statusCode: res.statusCode, json: () => res.json() as Record<string, unknown> };
}

async function beatAll(except: Dev[] = []): Promise<void> {
  const skip = new Set(except.map((d) => d.id));
  for (const d of devices) {
    if (skip.has(d.id)) continue;
    const res = await beat(
      d,
      d === bar ? { attached } : d === cellularPhone ? { network: { type: "cellular" } } : {},
    );
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  }
}

async function eventsSince(id: number, venueId = v.venueA) {
  const r = await owner.query<{ id: string; type: string; entity_id: string; audience: string }>(
    "select id, type, entity_id, audience from venue_events where venue_id = $1 and id > $2 order by id",
    [venueId, id],
  );
  return r.rows;
}
async function lastEventId(): Promise<number> {
  const r = await owner.query<{ m: string | null }>("select max(id)::text as m from venue_events");
  return Number(r.rows[0]?.m ?? 0);
}
async function auditCount(): Promise<number> {
  const r = await owner.query<{ n: string }>("select count(*)::text as n from audit_log");
  return Number(r.rows[0]!.n);
}
const at = (iso: string) => clock.set(Temporal.Instant.from(iso));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({
    config,
    clock,
    authenticators: [headerAuth],
    eventsPollMs: 100,
    moduleCacheMs: 0,
  });
  await app.ready();
  const hours = await app.inject({
    method: "PUT",
    url: `/v1/venues/${v.venueA}/settings/hours`,
    headers: ownerA(),
    payload: { value: { weekly, lastCall: "04:00" } },
  });
  expect(hours.statusCode, hours.body).toBe(200);

  // 25 signing devices: the bar computer, the front desk, 14 tablets, 4 staff phones, a display, and 4 more phones.
  bar = await pairAndClaim(v.venueA, "bar_computer", "Bar computer");
  devices.push(bar);
  devices.push(await pairAndClaim(v.venueA, "front_desk", "Front desk"));
  for (let i = 1; i <= 14; i += 1)
    devices.push(await pairAndClaim(v.venueA, "room_tablet", `Room ${i} tablet`));
  tablet = devices[2]!;
  for (let i = 1; i <= 8; i += 1)
    devices.push(await pairAndClaim(v.venueA, "staff_phone", `Phone ${i}`));
  devices.push(await pairAndClaim(v.venueA, "up_next_display", "Up next TV"));
  expect(devices).toHaveLength(25);
  // Two printers and an NFC reader, reported by the bar computer.
  const peripherals = await owner.query<{ id: string }>(
    `insert into devices (venue_id, kind, name) values ($1, 'printer', 'Bar printer'), ($1, 'printer', 'Kitchen printer'), ($1, 'nfc_reader', 'Badge reader') returning id`,
    [v.venueA],
  );
  attached = peripherals.rows.map((r) => r.id);
  // A manager's phone on cellular: on the venue's list, but not on its line.
  cellularPhone = await pairAndClaim(v.venueA, "staff_phone", "Manager's phone (LTE)");
  devices.push(cellularPhone);
  venueBDevice = await pairAndClaim(v.venueB, "bar_computer", "B bar");
}, 60_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("heartbeats", () => {
  it("only a signed device may heartbeat: unsigned and a manager's session are 403", async () => {
    const anon = await app.inject({
      method: "POST",
      url: "/v1/devices/heartbeat",
      payload: { clock: "x" },
    });
    expect(anon.statusCode).toBe(403);
    const manager = await app.inject({
      method: "POST",
      url: "/v1/devices/heartbeat",
      headers: ownerA(),
      payload: { clock: new Date().toISOString() },
    });
    expect(manager.statusCode).toBe(403);
    const bad = await beat(bar, { clock: "tonight" });
    expect(bad.statusCode).toBe(400);
  });

  it("every device checks in at 10:41 PM, the host reports its printers, and none of it reaches the audit log", async () => {
    const before = await auditCount();
    await beatAll();
    const res = await beat(bar, { attached: [...attached, venueBDevice.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json().attached_ignored).toEqual([venueBDevice.id]);
    expect(Math.abs(res.json().clock_skew_ms as number)).toBeLessThan(5_000);
    expect(await auditCount()).toBe(before);

    const rows = await owner.query<{ n: string; seen: string }>(
      "select count(*)::text as n, min(last_seen_at)::text as seen from device_heartbeats where venue_id = $1",
      [v.venueA],
    );
    expect(Number(rows.rows[0]!.n)).toBe(29); // 25 signing + 3 attached + the cellular phone
    expect(new Date(rows.rows[0]!.seen).toISOString()).toBe("2026-09-26T02:41:00.000Z");

    const list = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/devices`,
      headers: ownerA(),
    });
    const listed = (
      list.json() as { devices: { id: string; online: boolean; app_version: string | null }[] }
    ).devices;
    expect(listed.find((d) => d.id === bar.id)).toMatchObject({
      online: true,
      app_version: "1.0.0",
    });
    expect(listed.find((d) => d.id === attached[0])).toMatchObject({
      online: true,
      app_version: null,
    });
    expect(listed.some((d) => d.id === venueBDevice.id)).toBe(false);
  });

  it("a tablet that stops at 10:41 PM is offline at 10:43 PM: one device.offline, then device.online when it returns", async () => {
    const mark = await lastEventId();
    at("2026-09-26T02:42:30Z");
    await beatAll([tablet]);
    at("2026-09-26T02:42:59Z");
    expect(await sweepQuietDevices(pool, clock.now())).toEqual([]);
    at("2026-09-26T02:43:00Z");
    expect(await sweepQuietDevices(pool, clock.now())).toEqual([
      { venueId: v.venueA, offline: [tablet.id], venueOffline: false },
    ]);
    expect(await sweepQuietDevices(pool, clock.now())).toEqual([]);
    expect(await eventsSince(mark)).toEqual([
      expect.objectContaining({ type: "device.offline", entity_id: tablet.id, audience: "venue" }),
    ]);
    const list = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/devices`,
      headers: ownerA(),
    });
    expect(
      (list.json() as { devices: { id: string; online: boolean }[] }).devices.find(
        (d) => d.id === tablet.id,
      )?.online,
    ).toBe(false);

    at("2026-09-26T02:43:30Z");
    const back = await beat(tablet);
    expect(back.json().back_online).toEqual([tablet.id]);
    const events = await eventsSince(mark);
    expect(events.map((e) => e.type)).toEqual(["device.offline", "device.online"]);
    expect(await auditCount()).toBe(await auditCount());
  });

  it("a device that stops at 4:30 AM, after the close, raises nothing", async () => {
    at("2026-09-26T08:30:00Z"); // Sat 4:30 AM New York
    await beatAll();
    const mark = await lastEventId();
    at("2026-09-26T08:32:30Z");
    expect(await sweepQuietDevices(pool, clock.now())).toEqual([]);
    at("2026-09-26T12:00:00Z");
    expect(await sweepQuietDevices(pool, clock.now())).toEqual([]);
    expect(await eventsSince(mark)).toEqual([]);
  });

  it("a clock 45 seconds off raises device.clock_skew once for the managers; 20 seconds off doesn't", async () => {
    at("2026-09-26T03:00:00Z"); // Fri 11:00 PM
    const mark = await lastEventId();
    const off = await beat(bar, { clock: new Date(Date.now() + 45_000).toISOString() });
    expect(off.json().clock_alert).toBe("raised");
    expect(off.json().clock_skew_ms as number).toBeGreaterThan(40_000);
    const stillOff = await beat(bar, { clock: new Date(Date.now() + 46_000).toISOString() });
    expect(stillOff.json().clock_alert).toBeNull();
    const fine = await beat(tablet, { clock: new Date(Date.now() - 20_000).toISOString() });
    expect(fine.json().clock_alert).toBeNull();
    const fixed = await beat(bar, { clock: new Date(Date.now() + 20_000).toISOString() });
    expect(fixed.json().clock_alert).toBe("cleared");
    expect(await eventsSince(mark)).toEqual([
      expect.objectContaining({
        type: "device.clock_skew",
        entity_id: bar.id,
        audience: "managers",
      }),
    ]);
  });

  it("when all 28 devices go quiet together, managers get one venue.offline, not 28; the first heartbeat back raises venue.online", async () => {
    at("2026-09-26T03:10:00Z");
    await beatAll();
    const mark = await lastEventId();
    at("2026-09-26T03:11:30Z");
    // The manager's phone on LTE keeps checking in; it isn't on the venue's line.
    expect((await beat(cellularPhone, { network: { type: "cellular" } })).statusCode).toBe(200);
    at("2026-09-26T03:12:00Z");
    const swept = await sweepQuietDevices(pool, clock.now());
    expect(swept).toHaveLength(1);
    expect(swept[0]!.venueOffline).toBe(true);
    expect(swept[0]!.offline).toHaveLength(28);
    const events = await eventsSince(mark);
    // The whole venue is down, and with it the bar computer, so "no bar device connected" too (M3-17).
    expect(events).toEqual([
      expect.objectContaining({ type: "venue.offline", entity_id: v.venueA, audience: "managers" }),
      expect.objectContaining({ type: "bar.disconnected", entity_id: v.venueA }),
    ]);
    expect(await sweepQuietDevices(pool, clock.now())).toEqual([]);

    at("2026-09-26T03:12:30Z");
    const back = await beat(bar, { attached });
    expect(back.json().back_online).toEqual([bar.id, ...attached]);
    const after = await eventsSince(mark);
    expect(after.map((e) => e.type)).toEqual([
      "venue.offline",
      "bar.disconnected",
      "venue.online",
      "device.online",
      "device.online",
      "device.online",
      "device.online",
      "bar.connected",
    ]);
    expect(await eventsSince(0, v.venueB)).toEqual([]);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import pg from "pg";
import { emitEvent, withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import {
  DEVICE_HEADERS,
  FrozenClock,
  SEED_NOW,
  makeDeviceKey,
  signDeviceRequest,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { route } from "../http/conventions.js";
import type { Principal } from "../http/principal.js";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let baseUrl: string;
let pool: pg.Pool;

const headerAuth = async (request: { headers: Record<string, unknown> }) => {
  const raw = request.headers["x-test-principal"];
  return typeof raw === "string" ? (JSON.parse(raw) as Principal) : undefined;
};
const asManager = () => ({
  "x-test-principal": JSON.stringify({
    kind: "user",
    userId: v.ownerA,
    session: "passkey",
    memberships: [{ venueId: v.venueA, membershipId: v.membershipA, role: "manager" }],
  } satisfies Principal),
});

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({
    config,
    clock: new FrozenClock(SEED_NOW),
    authenticators: [headerAuth],
    eventsPollMs: 100,
    moduleCacheMs: 0,
    extraRoutes: (a) => {
      a.get(
        "/v1/venues/:venueId/fixture/device-ping",
        {
          config: route({
            principals: ["shared_device", "room_tablet"],
            module: "core",
            rateLimit: false,
          }),
        },
        async (request) => ({ principal: request.principal }),
      );
    },
  });
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

async function pair(kind = "bar_computer", name = "Bar computer") {
  const res = await app.inject({
    method: "POST",
    url: `/v1/venues/${v.venueA}/devices/pair`,
    headers: asManager(),
    payload: { kind, name },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { code: string; expires_at: string };
}

describe("devices", () => {
  let deviceId: string;
  let key: Awaited<ReturnType<typeof makeDeviceKey>>;

  it("a code made in Admin pairs the bar computer once; the same code fails a second time, and an expired code fails", async () => {
    const { code } = await pair();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    key = await makeDeviceKey();
    const claimed = await app.inject({
      method: "POST",
      url: "/v1/devices/claim",
      payload: { code, public_key: key.publicJwk },
    });
    expect(claimed.statusCode, claimed.body).toBe(201);
    deviceId = claimed.json().device_id;
    expect(claimed.json().venue_id).toBe(v.venueA);
    const again = await app.inject({
      method: "POST",
      url: "/v1/devices/claim",
      payload: { code, public_key: key.publicJwk },
    });
    expect(again.statusCode).toBe(403);
    // An expired code: push its expiry into the past.
    const { code: expired } = await pair("front_desk", "Front desk");
    const owner = new pg.Client({ connectionString: db.url });
    await owner.connect();
    await owner.query(
      "update device_pairing_codes set expires_at = now() - interval '1 minute' where claimed_at is null",
    );
    await owner.end();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/devices/claim",
          payload: { code: expired, public_key: key.publicJwk },
        })
      ).statusCode,
    ).toBe(403);
    const list = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/devices`,
      headers: asManager(),
    });
    expect(list.json().devices).toHaveLength(1);
    expect(list.json().devices[0]).toMatchObject({
      id: deviceId,
      kind: "bar_computer",
      name: "Bar computer",
    });
  });

  it("a signed request is accepted as the device; a bad, missing or replayed signature answers 403", async () => {
    const path = `/v1/venues/${v.venueA}/fixture/device-ping`;
    const headers = await signDeviceRequest({
      deviceId,
      privateKey: key.privateKey,
      method: "GET",
      path,
    });
    const ok = await app.inject({ method: "GET", url: path, headers });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().principal).toEqual({
      kind: "device",
      deviceId,
      venueId: v.venueA,
      deviceKind: "bar_computer",
    });
    // Replay: the same headers again.
    const replay = await app.inject({ method: "GET", url: path, headers });
    expect(replay.statusCode).toBe(403);
    expect(replay.json().error.message).toMatch(/replayed/);
    // Tampered signature.
    const fresh = await signDeviceRequest({
      deviceId,
      privateKey: key.privateKey,
      method: "GET",
      path,
    });
    const bad = await app.inject({
      method: "GET",
      url: path,
      headers: {
        ...fresh,
        [DEVICE_HEADERS.signature]: fresh[DEVICE_HEADERS.signature]!.replace(/.$/, (c) =>
          c === "A" ? "B" : "A",
        ),
      },
    });
    expect(bad.statusCode).toBe(403);
    // Signed for another path.
    const other = await signDeviceRequest({
      deviceId,
      privateKey: key.privateKey,
      method: "GET",
      path: "/v1/somewhere-else",
    });
    expect((await app.inject({ method: "GET", url: path, headers: other })).statusCode).toBe(403);
    // A stale timestamp.
    const stale = await signDeviceRequest({
      deviceId,
      privateKey: key.privateKey,
      method: "GET",
      path,
      timestampMs: Date.now() - 10 * 60_000,
    });
    expect(
      (await app.inject({ method: "GET", url: path, headers: stale })).json().error.message,
    ).toMatch(/clock/);
    // Missing: anonymous, and the route wants a device.
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(403);
    // Another device's key can't sign for this id.
    const otherKey = await makeDeviceKey();
    expect(
      (
        await app.inject({
          method: "GET",
          url: path,
          headers: await signDeviceRequest({
            deviceId,
            privateKey: otherKey.privateKey,
            method: "GET",
            path,
          }),
        })
      ).statusCode,
    ).toBe(403);
    // A device can't reach another venue.
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/venues/${v.venueB}/fixture/device-ping`,
          headers: await signDeviceRequest({
            deviceId,
            privateKey: key.privateKey,
            method: "GET",
            path: `/v1/venues/${v.venueB}/fixture/device-ping`,
          }),
        })
      ).statusCode,
    ).toBe(403);
  });

  it("a locked shared device's channel carries ring state and nothing else", async () => {
    const path = `/v1/venues/${v.venueA}/events?locked=1`;
    const headers = await signDeviceRequest({
      deviceId,
      privateKey: key.privateKey,
      method: "GET",
      path,
    });
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}${path}`, { headers });
    const frames: Record<string, unknown>[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(String(d)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await withVenue(pool, { venueId: v.venueA }, async (c) => {
      await emitEvent(c, {
        venueId: v.venueA,
        type: "check.updated",
        entityId: "check-1",
        roomId: randomUUID(),
      });
      await emitEvent(c, { venueId: v.venueA, type: "settings.changed", entityId: "hours" });
      await emitEvent(c, {
        venueId: v.venueA,
        type: "order.ringing",
        entityId: "order-1",
        roomId: randomUUID(),
      });
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(frames.map((f) => f["type"])).toEqual(["hello", "order.ringing"]);
    ws.close();
  });

  it("revoking the bar computer closes its WebSocket within a second, and its next request answers 403", async () => {
    const path = `/v1/venues/${v.venueA}/events`;
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}${path}`, {
      headers: await signDeviceRequest({
        deviceId,
        privateKey: key.privateKey,
        method: "GET",
        path,
      }),
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    const started = Date.now();
    const revoke = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/devices/${deviceId}/revoke`,
      headers: asManager(),
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect(revoke.json().revoked_at).toBeTruthy();
    expect(await closed).toBe(4401);
    expect(Date.now() - started).toBeLessThan(1000);
    const pingPath = `/v1/venues/${v.venueA}/fixture/device-ping`;
    const after = await app.inject({
      method: "GET",
      url: pingPath,
      headers: await signDeviceRequest({
        deviceId,
        privateKey: key.privateKey,
        method: "GET",
        path: pingPath,
      }),
    });
    expect(after.statusCode).toBe(403);
    expect(after.json().error.message).toMatch(/revoked/);
    // A revoked device can't be edited, and the event went out for Admin → Printers & devices.
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/v1/venues/${v.venueA}/devices/${deviceId}`,
          headers: asManager(),
          payload: { name: "x" },
        })
      ).statusCode,
    ).toBe(404);
    const events = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query("select type from venue_events where type = 'device.offline'"),
    );
    expect(events.rowCount).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { emitEvent, withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "./principal.js";

let db: TestDatabase;
let v: TwoVenues;
let one: FastifyInstance;
let two: FastifyInstance;
let urlOne: string;
let urlTwo: string;

// Test-only authentication: the principal arrives as a header.
const headerAuth = async (request: { headers: Record<string, unknown> }) => {
  const raw = request.headers["x-test-principal"];
  return typeof raw === "string" ? (JSON.parse(raw) as Principal) : undefined;
};

function makeApp(): FastifyInstance {
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  return buildApp({
    config,
    clock: new FrozenClock(SEED_NOW),
    authenticators: [headerAuth],
    eventsPollMs: 200,
    drainMs: 100,
  });
}

interface Frame {
  [key: string]: unknown;
}

async function connect(
  base: string,
  principal: Principal,
  query = "",
): Promise<{
  ws: WebSocket;
  frames: Frame[];
  next: (pred: (f: Frame) => boolean, ms?: number) => Promise<Frame>;
}> {
  const ws = new WebSocket(`${base}/v1/venues/${v.venueA}/events${query}`, {
    headers: { "x-test-principal": JSON.stringify(principal) },
  });
  const frames: Frame[] = [];
  const waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Frame;
    frames.push(frame);
    for (const w of [...waiters]) {
      if (w.pred(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(frame);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = (pred: (f: Frame) => boolean, ms = 1000): Promise<Frame> => {
    const found = frames.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`no frame within ${ms} ms; got ${JSON.stringify(frames)}`)),
        ms,
      );
      waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
      });
    });
  };
  return { ws, frames, next };
}

const manager = (): Principal => ({
  kind: "user",
  userId: v.ownerA,
  session: "passkey",
  memberships: [{ venueId: v.venueA, membershipId: v.membershipA, role: "owner" }],
});
const tablet = (): Principal => ({
  kind: "device",
  deviceId: "tab-9",
  venueId: v.venueA,
  deviceKind: "room_tablet",
});

async function emit(type: string, entityId: string, roomId?: string): Promise<void> {
  const pool = appPool(db.url);
  await withVenue(pool, { venueId: v.venueA }, (c) =>
    emitEvent(c, { venueId: v.venueA, type, entityId, entityVersion: 1, roomId }),
  );
  await pool.end();
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  one = makeApp();
  two = makeApp();
  urlOne = (await one.listen({ port: 0, host: "127.0.0.1" })).replace("http", "ws");
  urlTwo = (await two.listen({ port: 0, host: "127.0.0.1" })).replace("http", "ws");
});

afterAll(async () => {
  await one.close();
  await two.close();
  await db.drop();
});

describe("live events", () => {
  it("an event written in a transaction reaches a socket on either of two API containers within a second", async () => {
    const a = await connect(urlOne, manager());
    const b = await connect(urlTwo, manager());
    expect(await a.next((f) => f["type"] === "hello")).toMatchObject({
      type: "hello",
      server_time: "2026-09-25T22:41:00-04:00",
      seq: 0,
    });
    const started = Date.now();
    await emit("settings.changed", "settings-1");
    const ea = await a.next((f) => f["type"] === "settings.changed");
    const eb = await b.next((f) => f["type"] === "settings.changed");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ea).toEqual({
      seq: 1,
      type: "settings.changed",
      id: "settings-1",
      entity_version: 1,
      at: expect.any(String),
    });
    expect(Object.keys(eb)).toHaveLength(5);
    a.ws.close();
    b.ws.close();
  });

  it("a screen that reconnects with its last seq gets exactly what it missed", async () => {
    await emit("menu.changed", "menu-1");
    await emit("menu.changed", "menu-2");
    const s = await connect(urlOne, manager(), "?after=1");
    await s.next((f) => f["type"] === "caught_up");
    expect(
      s.frames
        .filter((f) => typeof f["seq"] === "number" && typeof f["id"] === "string")
        .map((f) => f["seq"]),
    ).toEqual([2, 3]);
    expect(s.frames.find((f) => f["type"] === "caught_up")).toEqual({ type: "caught_up", seq: 3 });
    s.ws.close();
  });

  it("killing the relay leader loses no event, and seq keeps going up", async () => {
    for (let i = 0; i < 20 && !one.events.relay.leader && !two.events.relay.leader; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const leader = one.events.relay.leader ? one : two;
    const other = leader === one ? two : one;
    expect(leader.events.relay.leader).toBe(true);
    expect(other.events.relay.leader).toBe(false);
    const s = await connect(urlOne, manager());
    const hello = await s.next((f) => f["type"] === "hello");
    const base = hello["seq"] as number;
    await leader.events.relay.crash();
    await emit("room.updated", "room-9");
    await emit("room.updated", "room-9");
    const got = await s.next((f) => f["seq"] === base + 2, 3000);
    expect(got).toMatchObject({ type: "room.updated", seq: base + 2 });
    expect(
      s.frames
        .filter((f) => typeof f["seq"] === "number" && f["type"] === "room.updated")
        .map((f) => f["seq"]),
    ).toEqual([base + 1, base + 2]);
    expect(other.events.relay.leader).toBe(true);
    s.ws.close();
  });

  it("a socket on Room 9's channel never receives an event for another room", async () => {
    const roomA = v.venueA.replace(/^.{8}/, "aaaaaaaa"); // any uuid-shaped id
    const roomB = v.venueA.replace(/^.{8}/, "bbbbbbbb");
    const s = await connect(urlTwo, tablet(), `?room=${roomA}`);
    await s.next((f) => f["type"] === "hello");
    await emit("order.ready", "order-b", roomB);
    await emit("order.ready", "order-a", roomA);
    const mine = await s.next((f) => f["id"] === "order-a");
    expect(mine["type"]).toBe("order.ready");
    expect(s.frames.some((f) => f["id"] === "order-b")).toBe(false);
    s.ws.close();
  });

  it("asking for a seq older than what's kept is told to refetch", async () => {
    // Retention: clear everything kept so far, then add one more; seq 1 is gone.
    const pool = appPool(db.url);
    await pool.query("select clear_venue_events($1)", [new Date(Date.now() + 60_000)]);
    await pool.end();
    await emit("settings.changed", "settings-2");
    const s = await connect(urlOne, manager(), "?after=1");
    const frame = await s.next((f) => f["type"] === "refetch" || f["type"] === "caught_up");
    expect(frame["type"]).toBe("refetch");
    s.ws.close();
  });

  it("a caller with no membership at the venue is closed with 4403", async () => {
    const stranger: Principal = {
      kind: "user",
      userId: v.stranger,
      session: "passkey",
      memberships: [],
    };
    const s = await connect(urlOne, stranger);
    const code = await new Promise<number>((resolve) => s.ws.once("close", (c) => resolve(c)));
    expect(code).toBe(4403);
    expect(s.frames).toEqual([]);
  });
});

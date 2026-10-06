import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, type RouterLink } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import type { MakerReading } from "../router/peplink.js";
import { sweepRouters, type RouterWatchDeps } from "./router-watch.js";

/**
 * M8-02 on the demo seed at 10:41 PM: the router as a device, read through
 * the maker's API or, with it switched off, from the network owner behind
 * the bar computer's public IP; venue.backup_internet; the failover test.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let routerId = "";
let barId = "";
const clock = new SimulatedClock(SEED_NOW);

// What the fakes answer: the router through its maker's API, and the owner of an IP.
let maker: MakerReading | null = { backupReady: true, onBackupNow: false };
let makerCalls = 0;
let owner: string | null = null;
const deps: RouterWatchDeps = {
  adapter: {
    read: async (link: RouterLink) => {
      makerCalls += 1;
      return link.maker === "peplink" ? maker : null;
    },
  },
  ipOwner: async () => owner,
};
const sweep = () => sweepRouters(pool, deps, clock.now());

const get = async <T>(url: string) => {
  const res = await app.inject({ method: "GET", url: `/v1/venues/${venueId}${url}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<T>();
};
const send = (method: "PUT" | "POST", url: string, payload: unknown) =>
  app.inject({ method, url: `/v1/venues/${venueId}${url}`, payload: payload as object });
const onBackup = async () =>
  (await get<{ backup_internet: boolean }>("/connection")).backup_internet;
const backupEvents = async () =>
  Number(
    (
      await raw.query<{ n: string }>(
        "select count(*) as n from venue_events where venue_id = $1 and type = 'venue.backup_internet'",
        [venueId],
      )
    ).rows[0]!.n,
  );
type RouterAnswer = {
  routers: {
    id: string;
    backup_internet: "on" | "off" | null;
    on_backup_now: boolean;
    source: string | null;
    failover: {
      due: boolean;
      dueOn: string | null;
      tests: { passed: boolean; switch_seconds: number | null }[];
    };
  }[];
};
const link = (patch: Partial<RouterLink>) =>
  send("PUT", `/routers/${routerId}/link`, {
    maker: "peplink",
    maker_org_id: "org-1",
    maker_device_id: "101",
    api_on: true,
    wired_owner: "Example Fiber",
    lte_owner: "Example Wireless",
    ...patch,
  });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  const m = (
    await raw.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'owner'",
      [venueId],
    )
  ).rows[0]!;
  const ownerPrincipal: Principal = {
    kind: "user",
    userId: m.user_id,
    session: "passkey",
    memberships: [{ venueId, membershipId: m.id, role: "owner" }],
  };
  const ids = await raw.query<{ id: string; kind: string }>(
    "select id, kind from devices where venue_id = $1 and kind in ('router', 'bar_computer')",
    [venueId],
  );
  routerId = ids.rows.find((r) => r.kind === "router")!.id;
  barId = ids.rows.find((r) => r.kind === "bar_computer")!.id;
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => ownerPrincipal],
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

describe("the router as a device (M8-02)", () => {
  it("at 10:41 PM Admin and the Console read Backup internet · on, and the venue isn't on it", async () => {
    const { routers } = await get<RouterAnswer>("/routers");
    expect(routers).toHaveLength(1);
    expect(routers[0]).toMatchObject({ backup_internet: "on", on_backup_now: false });
    const devices = await get<{
      devices: { kind: string; network: Record<string, unknown> | null }[];
    }>("/devices");
    expect(devices.devices.find((d) => d.kind === "router")!.network).toMatchObject({
      cellular_backup: true,
      on_backup_now: false,
    });
    expect(await onBackup()).toBe(false);
  });

  it("nothing to read it by (no maker link, no network names): the sweep leaves it as it was", async () => {
    owner = "EXWL-BLK · Example Wireless LLC";
    const [r] = await sweep();
    expect(r).toMatchObject({ read: [], changed: [] });
    expect(makerCalls).toBe(0);
    expect(await backupEvents()).toBe(0);
  });

  it("through the maker's API: the wired line unplugged puts the venue on LTE, plugged back clears it", async () => {
    expect((await link({})).statusCode).toBe(200);
    maker = { backupReady: true, onBackupNow: true };
    expect((await sweep())[0]).toMatchObject({ read: [routerId], changed: [routerId] });
    expect(await onBackup()).toBe(true);
    expect((await get<RouterAnswer>("/routers")).routers[0]).toMatchObject({
      on_backup_now: true,
      source: "maker_api",
    });
    expect(await backupEvents()).toBe(1);
    // The same reading again raises nothing.
    await sweep();
    expect(await backupEvents()).toBe(1);
    maker = { backupReady: true, onBackupNow: false };
    await sweep();
    expect(await onBackup()).toBe(false);
    expect(await backupEvents()).toBe(2);
  });

  it("the backup not ready (no SIM) reads Backup internet · off in Admin and the Console", async () => {
    maker = { backupReady: false, onBackupNow: false };
    await sweep();
    expect((await get<RouterAnswer>("/routers")).routers[0]!.backup_internet).toBe("off");
    const health = await raw.query<{ b: boolean }>(
      "select (network ->> 'cellular_backup')::boolean as b from device_heartbeats where device_id = $1",
      [routerId],
    );
    expect(health.rows[0]!.b).toBe(false);
    maker = { backupReady: true, onBackupNow: false };
    await sweep();
  });

  it("with the maker's API switched off, the fallback sees LTE from the bar computer's public IP", async () => {
    expect((await link({ api_on: false })).statusCode).toBe(200);
    await raw.query(
      `update device_heartbeats set network = coalesce(network, '{}') || '{"public_ip": "198.51.100.20"}',
              last_seen_at = $2, offline_since = null where device_id = $1`,
      [barId, new Date(SEED_NOW.epochMilliseconds)],
    );
    makerCalls = 0;
    maker = { backupReady: true, onBackupNow: false }; // would say "on the line" if asked
    owner = "EXWL-BLK · Example Wireless LLC";
    expect((await sweep())[0]).toMatchObject({ read: [routerId], changed: [routerId] });
    expect(makerCalls).toBe(0);
    expect(await onBackup()).toBe(true);
    expect((await get<RouterAnswer>("/routers")).routers[0]).toMatchObject({
      backup_internet: "on",
      source: "public_ip",
    });
    owner = "EXAMPLE-FIBER-NYC · Example Fiber Inc.";
    await sweep();
    expect(await onBackup()).toBe(false);
    // An owner it can't place says nothing: the state stays.
    owner = "Somebody Else";
    expect((await sweep())[0]).toMatchObject({ read: [] });
    expect(await onBackup()).toBe(false);
  });

  it("the monthly failover test reminds the managers once when due, and keeps its result", async () => {
    const reminders = async () =>
      Number(
        (
          await raw.query<{ n: string }>(
            "select count(*) as n from jobs where venue_id = $1 and dedupe_key like 'router-failover:%'",
            [venueId],
          )
        ).rows[0]!.n,
      );
    expect((await get<RouterAnswer>("/routers")).routers[0]!.failover).toMatchObject({
      due: true,
      tests: [],
    });
    expect(await reminders()).toBe(1);
    await sweep();
    expect(await reminders()).toBe(1);
    const job = await raw.query<{ payload: { audience: unknown; message: { key: string } } }>(
      "select payload from jobs where venue_id = $1 and dedupe_key like 'router-failover:%'",
      [venueId],
    );
    expect(job.rows[0]!.payload.audience).toEqual({ kind: "role", role: "manager" });
    expect(job.rows[0]!.payload.message.key).toBe("router.push.failoverDue");

    const res = await send("POST", `/routers/${routerId}/failover-tests`, {
      passed: true,
      switch_seconds: 42,
    });
    expect(res.statusCode, res.body).toBe(200);
    const failover = (await get<RouterAnswer>("/routers")).routers[0]!.failover;
    expect(failover).toMatchObject({ due: false, dueOn: "2026-10-25" });
    expect(failover.tests[0]).toMatchObject({ passed: true, switch_seconds: 42 });
    await sweep();
    expect(await reminders()).toBe(1);
  });

  it("refuses a bad body, and a device that isn't the venue's router", async () => {
    expect(
      (await send("POST", `/routers/${routerId}/failover-tests`, { passed: "yes" })).statusCode,
    ).toBe(400);
    expect((await link({ maker: "acme" as never })).statusCode).toBe(400);
    expect(
      (await send("POST", `/routers/${barId}/failover-tests`, { passed: true })).statusCode,
    ).toBe(404);
    expect(
      (
        await send("PUT", `/routers/${barId}/link`, {
          maker: null,
          maker_org_id: null,
          maker_device_id: null,
          api_on: false,
          wired_owner: null,
          lte_owner: null,
        })
      ).statusCode,
    ).toBe(404);
  });
});

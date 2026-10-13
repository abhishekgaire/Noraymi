import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { insertPrintJob, loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  makeDeviceKey,
  signDeviceRequest,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepPrintJobs } from "./print.js";

/**
 * W-04: a network printer on the venue's LAN, relayed by the bar computers'
 * desktop apps. Two bar computers poll; the API leases the printer to one at a
 * time and hands each job to one of them only.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
type Key = Awaited<ReturnType<typeof makeDeviceKey>>;
const computers: Record<"a" | "b" | "desk", { id: string; key: Key }> = {} as never;

const signed = async (who: keyof typeof computers, url: string, body: object) => {
  const payload = JSON.stringify(body);
  const headers = await signDeviceRequest({
    deviceId: computers[who].id,
    privateKey: computers[who].key.privateKey,
    method: "POST",
    path: url,
    body: payload,
  });
  return app.inject({
    method: "POST",
    url,
    headers: { ...headers, "content-type": "application/json" },
    payload,
  });
};

interface RelayAnswer {
  printers: { printer_id: string; address: string; port: number }[];
  job: { id: string; printer_id: string; address: string; port: number; escpos: string } | null;
}
const relayNext = async (who: keyof typeof computers): Promise<RelayAnswer> => {
  const r = await signed(who, `/v1/venues/${venueId}/print-host/relay/next`, {});
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as RelayAnswer;
};
const settle = (who: keyof typeof computers, jobId: string, printerId: string, printed = true) =>
  signed(who, `/v1/venues/${venueId}/print-host/jobs/${jobId}`, {
    printer_id: printerId,
    printed,
    failure: printed ? null : "The printer at 192.168.1.50 didn't answer",
  });

const kitchenJob = () =>
  withVenue(pool, { venueId }, (c) =>
    insertPrintJob(c, venueId, {
      kind: "ticket",
      station: "kitchen",
      payload: { test: { printer: "Kitchen" } },
      createdAt: clock.now().toString(),
    }),
  );

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
  await raw.query("update print_jobs set status = 'printed', confirmed_at = now()");
  const second = await raw.query<{ id: string }>(
    "insert into devices (venue_id, kind, name) values ($1, 'bar_computer', 'Bar computer 2') returning id",
    [venueId],
  );
  const pairs: [keyof typeof computers, string][] = [
    ["a", ids["dev_bar_computer"]!],
    ["b", second.rows[0]!.id],
    ["desk", ids["dev_front_computer"] ?? ids["dev_front_desk"]!],
  ];
  for (const [who, id] of pairs) {
    const key = await makeDeviceKey();
    computers[who] = { id, key };
    await raw.query("update devices set public_key = $2 where id = $1", [
      id,
      JSON.stringify(key.publicJwk),
    ]);
  }
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [
      async (r) =>
        r.headers["x-device-id"] ? undefined : r.url.startsWith("/v1/venues/") ? andy : undefined,
    ],
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

describe("a network printer relayed by the bar computers (W-04)", () => {
  let printer = "";

  it("a manager adds it with its private address; a public one is refused", async () => {
    const bad = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/printers`,
      payload: { name: "Kitchen", station: "kitchen", protocol: "lan", address: "8.8.8.8" },
    });
    expect(bad.statusCode).toBe(400);
    const noAddress = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/printers`,
      payload: { name: "Kitchen", station: "kitchen", protocol: "lan" },
    });
    expect(noAddress.statusCode).toBe(400);
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/printers`,
      payload: {
        name: "Star TSP143IIILAN",
        station: "kitchen",
        protocol: "lan",
        address: "192.168.1.50",
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).not.toHaveProperty("password");
    printer = r.json().device_id;
    const row = await raw.query(
      "select network_address, network_port, command_set, relay_device_ids from devices where id = $1",
      [printer],
    );
    expect(row.rows[0]).toEqual({
      network_address: "192.168.1.50",
      network_port: 9100,
      command_set: "star_raster",
      relay_device_ids: null,
    });
  });

  it("two relays polling: each job goes to one of them only, and prints once", async () => {
    const job = await kitchenJob();
    const a = await relayNext("a");
    expect(a.printers.map((p) => p.printer_id)).toEqual([printer]);
    expect(a.job).toMatchObject({
      id: job,
      printer_id: printer,
      address: "192.168.1.50",
      port: 9100,
    });
    // Star raster, as the printer's command set says.
    expect(Buffer.from(a.job!.escpos, "base64").toString("hex").startsWith("1b2a7252")).toBe(true);
    // B gets nothing while A holds the lease, even the job A was sent and hasn't confirmed.
    expect(await relayNext("b")).toMatchObject({ printers: [], job: null });
    // A's next poll doesn't get the job again either: it was sent once.
    expect((await relayNext("a")).job).toBeNull();
    expect((await settle("a", job, printer)).statusCode).toBe(200);
    // B can't speak for a printer it doesn't hold.
    const other = await kitchenJob();
    const again = await relayNext("a");
    expect(again.job?.id).toBe(other);
    expect((await settle("b", other, printer)).statusCode).toBe(404);
    expect((await settle("a", other, printer)).statusCode).toBe(200);
  });

  it("a relay that goes quiet: its job fails after three polls, and the other relay takes over", async () => {
    const lost = await kitchenJob();
    expect((await relayNext("a")).job?.id).toBe(lost);
    clock.advance(Temporal.Duration.from({ seconds: 20 }));
    await sweepPrintJobs(pool, clock.now());
    const failed = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/print-jobs?status=failed` })
    ).json().jobs as { id: string }[];
    expect(failed.some((j) => j.id === lost)).toBe(true);
    // The lease ran out with A silent: B relays now, and the reprint prints there once.
    const reprint = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/print-jobs/${lost}/reprint`,
    });
    expect(reprint.statusCode).toBe(201);
    const b = await relayNext("b");
    expect(b.job?.id).toBe(reprint.json().job_id);
    expect((await relayNext("a")).job).toBeNull();
    expect((await settle("b", b.job!.id, printer)).statusCode).toBe(200);
  });

  it("with no relay up, a kitchen ticket fails after three polls (Kitchen ticket didn't print)", async () => {
    const nobody = await kitchenJob();
    clock.advance(Temporal.Duration.from({ seconds: 20 }));
    await sweepPrintJobs(pool, clock.now());
    const status = await raw.query<{ status: string }>(
      "select status from print_jobs where id = $1",
      [nobody],
    );
    expect(status.rows[0]!.status).toBe("failed");
  });

  it("the venue names its relays: a computer not named gets nothing; the front desk only when named", async () => {
    clock.advance(Temporal.Duration.from({ seconds: 20 }));
    expect((await relayNext("desk")).printers).toEqual([]);
    const set = await app.inject({
      method: "PATCH",
      url: `/v1/venues/${venueId}/printers/${printer}`,
      payload: { relay_device_ids: [computers.desk.id] },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect((await relayNext("a")).printers).toEqual([]);
    expect((await relayNext("b")).printers).toEqual([]);
    expect((await relayNext("desk")).printers.map((p) => p.printer_id)).toEqual([printer]);
    // Another venue's computer can't be named.
    const b = await raw.query<{ id: string }>(
      "insert into venues (org_id, name, slug, time_zone) select org_id, 'Elsewhere', 'elsewhere-w04', time_zone from venues where id = $1 returning id",
      [venueId],
    );
    const theirs = await raw.query<{ id: string }>(
      "insert into devices (venue_id, kind, name) values ($1, 'bar_computer', 'Theirs') returning id",
      [b.rows[0]!.id],
    );
    const refused = await app.inject({
      method: "PATCH",
      url: `/v1/venues/${venueId}/printers/${printer}`,
      payload: { relay_device_ids: [theirs.rows[0]!.id] },
    });
    expect(refused.statusCode).toBe(400);
  });

  it("the test print reaches the relay", async () => {
    clock.advance(Temporal.Duration.from({ seconds: 20 }));
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/printers/${printer}/test`,
    });
    expect(r.statusCode).toBe(201);
    const got = await relayNext("desk");
    expect(got.job?.id).toBe(r.json().job_id);
  });
});

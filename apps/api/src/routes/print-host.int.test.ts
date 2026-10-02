import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { insertOrder, loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, makeDeviceKey, signDeviceRequest } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * M3-14: the bar computer's desktop app hosting a USB printer. A virtual USB
 * printer stands in for the hardware: it takes ESC/POS bytes, or fails when
 * unplugged, and the host confirms or fails each job over its signed channel.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
let hostId = "";
let hostKey: Awaited<ReturnType<typeof makeDeviceKey>>;
const clock = new SimulatedClock(SEED_NOW);

/** The virtual USB printer: what it printed, and whether it's plugged in. */
const usb = { plugged: true, printed: [] as Buffer[] };

const signed = async (method: "POST", url: string, body: object) => {
  const payload = JSON.stringify(body);
  const headers = await signDeviceRequest({
    deviceId: hostId,
    privateKey: hostKey.privateKey,
    method,
    path: url,
    body: payload,
  });
  return app.inject({
    method,
    url,
    headers: { ...headers, "content-type": "application/json" },
    payload,
  });
};

/** One turn of the desktop app's print host for one printer: ask, print, confirm. */
async function hostTurn(printerId: string): Promise<string | null> {
  const next = await signed("POST", `/v1/venues/${venueId}/print-host/next`, {
    printer_id: printerId,
  });
  expect(next.statusCode).toBe(200);
  const job = next.json().job as { id: string; escpos: string } | null;
  if (!job) return null;
  const bytes = Buffer.from(job.escpos, "base64");
  const ok = usb.plugged;
  if (ok) usb.printed.push(bytes);
  const done = await signed("POST", `/v1/venues/${venueId}/print-host/jobs/${job.id}`, {
    printer_id: printerId,
    printed: ok,
    failure: ok ? null : "printer unplugged",
  });
  expect(done.statusCode).toBe(200);
  return job.id;
}

async function acceptedOrder(): Promise<void> {
  const id = await withVenue(pool, { venueId }, (c) =>
    insertOrder(c, venueId, {
      checkId: ids["chk_room5"]!,
      sessionId: ids["sess_room5"]!,
      source: "room",
      placedAt: clock.now().toString(),
      businessDate: "2026-09-25",
      items: [
        {
          variantId: ids["menu_bud_regular"]!,
          itemId: ids["menu_bud"]!,
          options: [],
          qty: 4,
          unitCents: 800,
          name: "Bud Light",
          alcohol: true,
          taxCategory: "drink",
          station: "bar",
        },
      ],
    }),
  );
  const r = await app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/orders/${id}/accept`,
    payload: {},
  });
  expect(r.statusCode).toBe(200);
}

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
  // The seed's printed tickets are out of the way; the bar computer gets a key.
  await raw.query("update print_jobs set status = 'printed', confirmed_at = now()");
  hostKey = await makeDeviceKey();
  hostId = ids["dev_bar_computer"]!;
  await raw.query("update devices set public_key = $2 where id = $1", [
    hostId,
    JSON.stringify(hostKey.publicJwk),
  ]);
  const maya: Principal = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [
      async (r) =>
        r.headers["x-device-id"] ? undefined : r.url.startsWith("/v1/venues/") ? maya : undefined,
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

describe("a USB printer on the bar computer", () => {
  let printer = "";

  it("is a printer device of the bar's station, and the heartbeat reports it", async () => {
    const r = await signed("POST", `/v1/venues/${venueId}/devices/attached`, {
      kind: "printer",
      name: "Star TSP143IIIU",
      serial: "VIRTUAL-USB-1",
    });
    expect(r.statusCode).toBe(201);
    printer = r.json().device_id;
    const row = await raw.query<{ station: string; protocol: string; host: string }>(
      "select station, protocol, host_device_id as host from devices where id = $1",
      [printer],
    );
    expect(row.rows[0]).toEqual({ station: "bar", protocol: "usb", host: hostId });
    const beat = await signed("POST", "/v1/devices/heartbeat", {
      app_version: "1.0.0",
      clock: new Date().toISOString(),
      attached: [printer],
    });
    expect(beat.statusCode).toBe(200);
    const seen = await raw.query<{ seen: boolean }>(
      "select last_seen_at is not null as seen from device_heartbeats where device_id = $1",
      [printer],
    );
    expect(seen.rows[0]!.seen).toBe(true);
  });

  it("accepting an order prints its ticket as ESC/POS and confirms the job", async () => {
    await acceptedOrder();
    const job = await hostTurn(printer);
    expect(job).not.toBeNull();
    const bytes = usb.printed.at(-1)!;
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...bytes.subarray(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    const text = bytes.toString("latin1");
    expect(text).toContain("ROOM 5");
    expect(text).toContain("4 x Bud Light");
    const row = await raw.query<{ status: string }>("select status from print_jobs where id = $1", [
      job,
    ]);
    expect(row.rows[0]!.status).toBe("printed");
    expect(await hostTurn(printer)).toBeNull();
  });

  it("unplugged: Ticket didn't print, and the reprint says REPRINT 2", async () => {
    usb.plugged = false;
    await acceptedOrder();
    const failed = await hostTurn(printer);
    const list = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/print-jobs?status=failed` })
    ).json().jobs as { id: string; room_name: string }[];
    expect(list.find((j) => j.id === failed)).toMatchObject({ room_name: "Room 5" });
    const board = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/board` })
    ).json() as {
      alerts: { kind: string; job_id?: string }[];
    };
    expect(board.alerts.some((a) => a.kind === "ticket" && a.job_id === failed)).toBe(true);
    const reprint = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/print-jobs/${failed}/reprint`,
    });
    expect(reprint.json()).toMatchObject({ reprint_n: 2 });
    usb.plugged = true;
    await hostTurn(printer);
    const text = usb.printed.at(-1)!.toString("latin1");
    expect(text).toContain("REPRINT 2");
  });

  it("another host's printer isn't this host's to print on", async () => {
    const other = await raw.query<{ id: string }>(
      `insert into devices (venue_id, kind, name, host_device_id, serial, station, protocol)
       values ($1, 'printer', 'Front USB', $2, 'OTHER', 'front_desk', 'usb') returning id`,
      [venueId, ids["dev_front_computer"] ?? ids["dev_front_desk"]],
    );
    const r = await signed("POST", `/v1/venues/${venueId}/print-host/next`, {
      printer_id: other.rows[0]!.id,
    });
    expect(r.statusCode).toBe(404);
  });
});

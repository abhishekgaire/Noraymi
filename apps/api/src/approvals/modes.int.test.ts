import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, makeDeviceKey, signDeviceRequest } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { requestApproval } from "./service.js";

/**
 * F-04 (D124): the venue decides how approvals are decided. "pin": a manager's PIN on the register
 * that asked decides it, never the requester's own and never a wrong one; "none": it runs at once
 * and its row is still the record; "phone": as before.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
let version = 100;
type Device = { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
let desk: Device;
let diegoAuth: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);

const setMode = async (mode: "phone" | "pin" | "none") => {
  version += 1;
  await raw.query(
    `insert into venue_settings (venue_id, key, version, value, starts_on) values ($1, 'approvals', $2, $3, '2026-09-25')`,
    [venueId, version, JSON.stringify({ mode })],
  );
};
async function signed(device: Device, path: string, body: unknown, headers = {}) {
  const payload = JSON.stringify(body);
  const sig = await signDeviceRequest({
    deviceId: device.id,
    privateKey: device.key.privateKey,
    method: "POST",
    path,
    body: payload,
  });
  return app.inject({
    method: "POST",
    url: path,
    headers: { ...sig, ...headers, "content-type": "application/json" },
    payload,
  });
}
const ask = (requester: string, deviceId: string | null) =>
  withVenue(pool, { venueId }, (c) =>
    requestApproval(c, venueId, {
      kind: "comp",
      targetKind: "check",
      targetId: ids["chk_room9"]!,
      amountCents: 3000,
      reason: "Mic died for 15 minutes",
      payload: {
        check_id: ids["chk_room9"],
        description: "Comp 15 min of room time",
        amount_cents: 3000,
        tax_category: "room_time",
        business_date: "2026-09-25",
      },
      requestedBy: ids[requester]!,
      requestedDeviceId: deviceId,
      now: clock.now(),
    }),
  );
const row = async (id: string) =>
  (
    await raw.query<{ status: string; decided_with: string; approver_id: string | null }>(
      "select status, decided_with, approver_id from approvals where id = $1",
      [id],
    )
  ).rows[0]!;
const pinPath = (id: string) => `/v1/venues/${venueId}/approvals/${id}/pin`;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  await raw.query("delete from approvals");
  pool = appPool(db.url);
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
  });
  await app.ready();
  const key = await makeDeviceKey();
  const r = await raw.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, public_key) values ($1, 'front_desk', 'Desk test', $2) returning id",
    [venueId, JSON.stringify(key.publicJwk)],
  );
  desk = { id: r.rows[0]!.id, key };
  const pin = await signed(desk, "/v1/auth/pin", {
    membership_id: ids["diego.membership"],
    pin: "6358",
    client: "shared",
  });
  expect(pin.statusCode, pin.body).toBe(200);
  diegoAuth = { authorization: `Bearer ${(JSON.parse(pin.body) as { token: string }).token}` };
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("how approvals are decided (F-04)", () => {
  it("phone: a request waits for the manager's phone, and the PIN route refuses", async () => {
    await setMode("phone");
    const a = await ask("diego", desk.id);
    expect(a).toMatchObject({ status: "approval_pending", decided_with: "phone" });
    const r = await signed(
      desk,
      pinPath(a.approval_id),
      { user_id: ids["andy"], pin: "730915", decision: "approve" },
      diegoAuth,
    );
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error.details).toMatchObject({ reason: "approvals_by_phone" });
  });

  it("pin: the list offers the managers; a wrong PIN and the requester's own are refused; Andy's PIN approves on the same register", async () => {
    await setMode("pin");
    const a = await ask("diego", desk.id);
    expect(a).toMatchObject({ status: "approval_pending", decided_with: "pin" });
    const list = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/approvals`,
      headers: diegoAuth,
    });
    expect(JSON.parse(list.body)).toMatchObject({ mode: "pin" });
    expect(
      (JSON.parse(list.body).approvers as { name: string }[]).map((p) => p.name).sort(),
    ).toEqual([expect.stringMatching(/^Abhishek/), expect.stringMatching(/^Andy/)]);
    const wrong = await signed(
      desk,
      pinPath(a.approval_id),
      { user_id: ids["andy"], pin: "000000", decision: "approve" },
      diegoAuth,
    );
    expect(wrong.statusCode).toBeGreaterThanOrEqual(400);
    expect((await row(a.approval_id)).status).toBe("pending");
    const staff = await signed(
      desk,
      pinPath(a.approval_id),
      { user_id: ids["diego"], pin: "6358", decision: "approve" },
      diegoAuth,
    );
    expect(staff.statusCode).toBe(403);
    const ok = await signed(
      desk,
      pinPath(a.approval_id),
      { user_id: ids["andy"], pin: "730915", decision: "approve" },
      diegoAuth,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await row(a.approval_id)).toMatchObject({
      status: "approved",
      decided_with: "pin",
      approver_id: ids["andy"],
    });
  });

  it("none: the comp runs at once, and its row is still the record", async () => {
    await setMode("none");
    const before = await raw.query<{ n: number }>(
      "select count(*)::int as n from check_lines where check_id = $1",
      [ids["chk_room9"]],
    );
    const a = await ask("diego", desk.id);
    expect(a).toMatchObject({ status: "approved", waiting_for: null });
    expect(await row(a.approval_id)).toMatchObject({ status: "approved", decided_with: "none" });
    const after = await raw.query<{ n: number }>(
      "select count(*)::int as n from check_lines where check_id = $1",
      [ids["chk_room9"]],
    );
    expect(after.rows[0]!.n).toBeGreaterThan(before.rows[0]!.n);
    await setMode("phone");
  });

  it("only the owner sets how approvals are decided", async () => {
    const r = await app.inject({
      method: "PUT",
      url: `/v1/venues/${venueId}/settings/approvals`,
      headers: diegoAuth,
      payload: { value: { mode: "none" } },
    });
    expect(r.statusCode).toBe(403);
  });
});

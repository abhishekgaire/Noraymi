import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, makeDeviceKey, signDeviceRequest } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";
import { requestApproval } from "../approvals/service.js";
import type { Principal } from "../http/principal.js";

/**
 * M2-15 acceptance on the demo seed, with real sign-in: Andy enrols a passkey,
 * his phone signs with its own key, and every way to decide from the wrong
 * place is refused.
 */
const ORIGIN = "http://localhost:5173";
const ANDY = "andy@demo.west4.local";
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
let andyCookie = "";
type Device = { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
let andyPhone: Device;
let diegoPhone: Device;
let desk: Device;
const clock = new SimulatedClock(SEED_NOW);
const passkey = new SoftwarePasskey("localhost");

const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { error?: { code: string; message: string } };
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: body as Record<string, unknown>, headers });
async function signed(device: Device | null, path: string, body: unknown, cookie: string) {
  const payload = JSON.stringify(body);
  const headers = device
    ? await signDeviceRequest({
        deviceId: device.id,
        privateKey: device.key.privateKey,
        method: "POST",
        path,
        body: payload,
      })
    : {};
  return app.inject({
    method: "POST",
    url: path,
    headers: { ...headers, cookie, "content-type": "application/json" },
    payload,
  });
}
async function device(kind: string, userId: string | null): Promise<Device> {
  const key = await makeDeviceKey();
  const r = await raw.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, user_id, public_key) values ($1, $2, $3, $4, $5) returning id",
    [venueId, kind, `${kind} test`, userId, JSON.stringify(key.publicJwk)],
  );
  return { id: r.rows[0]!.id, key };
}
const ask = (requester: string, deviceId: string | null, checkSlug = "chk_room9") =>
  withVenue(pool, { venueId }, (c) =>
    requestApproval(c, venueId, {
      kind: "comp",
      targetKind: "check",
      targetId: ids[checkSlug]!,
      amountCents: 3000,
      reason: "Mic died for 15 minutes",
      payload: {
        check_id: ids[checkSlug],
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
const decidePath = (id: string) => `/v1/venues/${venueId}/approvals/${id}/decide`;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  // The seed's own pending void (Diego's, M3-25) is the scenario tests' business; these count their own.
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
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_ORIGINS: ORIGIN,
    }),
    clock,
    moduleCacheMs: 0,
  });
  await app.ready();
  // Andy's first passkey, by the emailed code, then a passkey session.
  await raw.query("delete from auth_credentials where user_id = $1", [ids["andy"]]);
  expect((await post("/v1/auth/enroll", { step: "start", email: ANDY })).statusCode).toBe(200);
  const code = (
    await raw.query<{ payload: { data: { code: string } } }>(
      "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
      [ANDY],
    )
  ).rows[0]!.payload.data.code;
  const opts = json(await post("/v1/auth/enroll", { step: "passkey_options", email: ANDY, code }));
  const done = await post("/v1/auth/enroll", {
    step: "passkey_finish",
    email: ANDY,
    code,
    credential: passkey.register(opts["options"] as { challenge: string }, ORIGIN),
    name: "Andy's phone",
    client: "web",
  });
  expect(done.statusCode, done.body).toBe(201);
  const raw0 = done.headers["set-cookie"];
  andyCookie = String(Array.isArray(raw0) ? raw0[0] : raw0).split(";")[0]!;
  andyPhone = await device("staff_phone", ids["andy"]!);
  diegoPhone = await device("staff_phone", ids["diego"]!);
  desk = await device("front_desk", null);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("approvals", () => {
  it("Diego's and Maya's requests go to Andy, the manager on duty; Andy's go to Abhishek", async () => {
    expect((await ask("diego", desk.id)).waiting_for).toEqual({
      user_id: ids["andy"],
      name: "Andy C.",
    });
    expect((await ask("maya", null)).waiting_for.name).toBe("Andy C.");
    expect((await ask("andy", andyPhone.id)).waiting_for.name).toBe("Abhishek G.");
    const push = await raw.query(
      "select 1 from jobs where kind = 'push.send' and payload->'audience'->>'user_id' = $1",
      [ids["andy"]],
    );
    expect(push.rowCount).toBe(2);
  });

  it("Andy's inbox lists what waits for him with the line, amount, reason, who asked and when", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/approvals?status=pending`,
      headers: { cookie: andyCookie },
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = json(r) as unknown as {
      waiting_for_me: Record<string, unknown>[];
      asked_by_me: Record<string, unknown>[];
    };
    expect(body.waiting_for_me).toHaveLength(2);
    expect(body.waiting_for_me[0]).toMatchObject({
      kind: "comp",
      amount_cents: 3000,
      reason: "Mic died for 15 minutes",
      routed_to_name: "Andy C.",
    });
    expect(body.asked_by_me).toHaveLength(1);
    expect(body.asked_by_me[0]).toMatchObject({ routed_to_name: "Abhishek G.", status: "pending" });
  });

  it("can't be decided without his phone, from a shared screen, from someone else's phone, from the requester's device, or by the requester", async () => {
    const fromDesk = await ask("diego", desk.id);
    const p = decidePath(fromDesk.approval_id);
    expect(json(await signed(null, p, { decision: "approve" }, andyCookie)).error?.message).toMatch(
      /own phone/,
    );
    expect(json(await signed(desk, p, { decision: "approve" }, andyCookie)).error?.message).toMatch(
      /own phone/,
    );
    expect(
      json(await signed(diegoPhone, p, { decision: "approve" }, andyCookie)).error?.message,
    ).toMatch(/own phone/);
    const fromAndysPhone = await ask("maya", andyPhone.id);
    expect(
      json(
        await signed(
          andyPhone,
          decidePath(fromAndysPhone.approval_id),
          { decision: "approve" },
          andyCookie,
        ),
      ).error?.message,
    ).toMatch(/device that asked/);
    const andysOwn = await ask("andy", null);
    expect(
      json(
        await signed(
          andyPhone,
          decidePath(andysOwn.approval_id),
          { decision: "approve" },
          andyCookie,
        ),
      ).error?.message,
    ).toMatch(/own request/);
    const none = await raw.query("select 1 from approvals where status <> 'pending'");
    expect(none.rowCount).toBe(0);
  });

  it("approved on Andy's own phone in his passkey session, the comp line goes on Room 9's check with Andy as approver", async () => {
    const asked = await ask("diego", desk.id);
    const r = await signed(
      andyPhone,
      decidePath(asked.approval_id),
      { decision: "approve" },
      andyCookie,
    );
    expect(r.statusCode, r.body).toBe(200);
    expect((json(r)["approval"] as Record<string, unknown>)["status"]).toBe("approved");
    const line = await raw.query<{
      amount_cents: string;
      added_by: string;
      approved_by: string;
      tax_category: string;
    }>(
      "select amount_cents::text, added_by, approved_by, tax_category from check_lines where check_id = $1 and kind = 'comp'",
      [ids["chk_room9"]],
    );
    expect(line.rows).toEqual([
      {
        amount_cents: "-3000",
        added_by: ids["diego"],
        approved_by: ids["andy"],
        tax_category: "room_time",
      },
    ]);
    expect(
      (await signed(andyPhone, decidePath(asked.approval_id), { decision: "approve" }, andyCookie))
        .statusCode,
    ).toBe(409);
  });

  it("a declined request changes nothing, and the requester sees the decision", async () => {
    const asked = await ask("diego", desk.id);
    const before = (await raw.query("select count(*)::int as n from check_lines")).rows[0];
    const r = await signed(
      andyPhone,
      decidePath(asked.approval_id),
      { decision: "decline" },
      andyCookie,
    );
    expect((json(r)["approval"] as Record<string, unknown>)["status"]).toBe("declined");
    expect((await raw.query("select count(*)::int as n from check_lines")).rows[0]).toEqual(before);
    const decided = await raw.query(
      "select 1 from venue_events where type = 'approval.decided' and entity_id = $1 and user_id = $2",
      [asked.approval_id, ids["diego"]],
    );
    expect(decided.rowCount).toBe(1);
  });

  it("a request whose target is gone expires instead of running", async () => {
    const asked = await ask("diego", desk.id, "chk_room1");
    await raw.query("update checks set status = 'void' where id = $1", [ids["chk_room1"]]);
    const r = await signed(
      andyPhone,
      decidePath(asked.approval_id),
      { decision: "approve" },
      andyCookie,
    );
    expect((json(r)["approval"] as Record<string, unknown>)["status"]).toBe("expired");
    expect(
      (
        await raw.query("select 1 from check_lines where check_id = $1 and kind = 'comp'", [
          ids["chk_room1"],
        ])
      ).rowCount,
    ).toBe(0);
  });

  it("is refused in a PIN session, even on Andy's own phone", async () => {
    const m = (
      await raw.query<{ id: string }>(
        "select id from memberships where venue_id = $1 and user_id = $2",
        [venueId, ids["andy"]],
      )
    ).rows[0]!.id;
    const andyByPin: Principal = {
      kind: "user",
      userId: ids["andy"]!,
      session: "pin",
      memberships: [{ venueId, membershipId: m, role: "manager" }],
    };
    const pinApp = buildApp({
      config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
      clock,
      authenticators: [async () => andyByPin],
      moduleCacheMs: 0,
    });
    await pinApp.ready();
    try {
      const asked = await ask("diego", desk.id);
      const path = decidePath(asked.approval_id);
      const body = JSON.stringify({ decision: "approve" });
      const headers = await signDeviceRequest({
        deviceId: andyPhone.id,
        privateKey: andyPhone.key.privateKey,
        method: "POST",
        path,
        body,
      });
      const r = await pinApp.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      expect(r.statusCode).toBe(403);
      expect(
        (await raw.query("select status from approvals where id = $1", [asked.approval_id]))
          .rows[0],
      ).toEqual({ status: "pending" });
    } finally {
      await pinApp.close();
    }
  });
});

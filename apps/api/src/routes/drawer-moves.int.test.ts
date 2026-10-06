import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * Drops, paid-outs, no-sales and tip-outs at the drawer (M7-06; Money rules
 * 15; spec 08 · Drawer; spec 09 · Cash drawer): each a move on the open
 * session at the drawer's own screen, each opening the drawer, and a kick with
 * nothing behind it refused.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;

type Role = "owner" | "manager" | "bartender" | "front_desk";
interface Who {
  slug: string;
  role: Role;
  session: SessionKind;
  device: string;
  deviceKind: "bar_computer" | "front_desk" | "staff_phone";
}
let who: Who;
const as = (slug: string, role: Role, session: SessionKind, device: string) => {
  who = {
    slug,
    role,
    session,
    device,
    deviceKind: device.startsWith("dev_phone")
      ? "staff_phone"
      : device === "dev_bar_computer"
        ? "bar_computer"
        : "front_desk",
  };
};
const post = (path: string, payload?: unknown) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": `drawer-${++n}` },
    ...(payload ? { payload } : {}),
  });
const get = (path: string) => api.inject({ method: "GET", url: `/v1/venues/${venueId}${path}` });

interface PanelSession {
  id: string;
  state: string;
  opened_with_cents: number;
  responsible: string | null;
  waiting_for: string | null;
  accepted: boolean;
  count: { counted_cents: number; expected_cents: number; over_short_cents: number } | null;
  expected_cents?: number;
  cash_taken_cents?: number;
}
interface Panel {
  handover: { waiting_for: { name: string } } | null;
  drawers: { id: string; name: string; can_count: boolean; sessions: PanelSession[] }[];
}
const panel = async () => (await get("/drawers")).json() as Panel;
const openSession = async (name: string) =>
  (await panel()).drawers.find((d) => d.name === name)!.sessions.find((s) => s.state === "open")!;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  const memberships = Object.fromEntries(
    (
      await owner.query<{ user_id: string; id: string }>(
        "select user_id, id from memberships where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.user_id, r.id]),
  );
  as("andy", "manager", "passkey", "dev_phone_andy");
  api = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
    }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request: FastifyRequest): Promise<Principal> => {
        const userId = ids[who.slug]!;
        const deviceId = ids[who.device]!;
        Object.assign(request, {
          session: {
            assurance: who.session,
            membershipId: memberships[userId],
            deviceId,
          },
          signedDevice: { deviceId, venueId, kind: who.deviceKind },
        });
        return {
          kind: "user",
          userId,
          session: who.session,
          memberships: [{ venueId, membershipId: memberships[userId]!, role: who.role }],
        };
      },
    ],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

interface Move {
  kind: string;
  amount_cents: number;
  by: string;
  paid_to: string | null;
  reason: string | null;
}
const movesOf = async (name: string) =>
  (await panel()).drawers.find((d) => d.name === name)!.sessions[0]! as unknown as PanelSession & {
    moves: Move[];
  };
const kicks = async (reason: string) =>
  (
    await owner.query<{ n: number }>(
      "select count(*)::int as n from print_jobs where venue_id = $1 and kind = 'drawer' and payload->>'reason' = $2",
      [venueId, reason],
    )
  ).rows[0]!.n;

describe("drops, paid-outs, no-sales and tip-outs", () => {
  it("Diego's phone cash sits in his staff bank, and his drop at the front desk is logged to him", async () => {
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    as("diego", "front_desk", "pin", "dev_phone_diego");
    expect((await post(`/checks/${ids["chk_room9"]}/present`)).statusCode).toBe(200);
    const paid = await post(`/checks/${ids["chk_room9"]}/payments`, {
      method: "cash",
      amount_cents: 49860,
      tendered_cents: 50000,
    });
    expect(paid.statusCode, paid.body).toBe(201);
    expect((await panel()).me).toMatchObject({ bank_cents: 49860 });

    // A drop happens at the drawer's own screen, not on his phone.
    const front = await openSession("Front-desk drawer");
    expect((await post(`/drawer-sessions/${front.id}/drop`)).statusCode).toBe(403);
    as("diego", "front_desk", "pin", "dev_front_computer");
    const drop = await post(`/drawer-sessions/${front.id}/drop`);
    expect(drop.statusCode, drop.body).toBe(200);
    expect(drop.json()).toMatchObject({
      amount_cents: 49860,
      bank_cents: 0,
      logged_to: { name: "Diego", drawer: "Front-desk drawer" },
    });
    expect((await panel()).me).toMatchObject({ bank_cents: 0 });
    expect((await movesOf("Front-desk drawer")).moves).toEqual([
      expect.objectContaining({ kind: "drop", amount_cents: 49860, by: "Diego R." }),
    ]);
    expect(await kicks("drop")).toBe(1);
    // Nothing left to drop.
    expect((await post(`/drawer-sessions/${front.id}/drop`)).statusCode).toBe(400);
  });

  it("Andy's $42.00 ice-run paid-out goes to Abhishek's phone, and the drawer opens only once he approves", async () => {
    const bar = await openSession("Bar drawer");
    const photo = (
      await owner.query<{ id: string }>(
        "insert into files (venue_id, kind, storage_key, content_type, bytes, uploaded_at) values ($1::uuid, 'paid_out_photo', $1::text || '/paid-out/ice.jpg', 'image/jpeg', 2000, now()) returning id",
        [venueId],
      )
    ).rows[0]!.id;
    as("andy", "manager", "pin", "dev_bar_computer");
    expect(
      (await post(`/drawer-sessions/${bar.id}/paid-out`, { amount_cents: 4200, reason: "Ice run" }))
        .statusCode,
    ).toBe(400);
    const asked = await post(`/drawer-sessions/${bar.id}/paid-out`, {
      amount_cents: 4200,
      reason: "Ice run",
      photo_file_id: photo,
    });
    expect(asked.statusCode, asked.body).toBe(202);
    expect(asked.json()).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: "Abhishek G." },
    });
    expect(await kicks("paid_out")).toBe(0);
    expect((await movesOf("Bar drawer")).moves).toEqual([]);

    const id = asked.json().approval_id as string;
    as("andy", "manager", "passkey", "dev_phone_andy");
    expect((await post(`/approvals/${id}/decide`, { decision: "approve" })).statusCode).toBe(403);
    as("abhishek", "owner", "passkey", "dev_bar_computer");
    expect((await post(`/approvals/${id}/decide`, { decision: "approve" })).statusCode).toBe(403);
    as("abhishek", "owner", "passkey", "dev_phone_abhishek");
    const ok = await post(`/approvals/${id}/decide`, { decision: "approve" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await kicks("paid_out")).toBe(1);
    expect((await movesOf("Bar drawer")).moves).toEqual([
      expect.objectContaining({
        kind: "paid_out",
        amount_cents: 4200,
        by: "Andy C.",
        reason: "Ice run",
      }),
    ]);
  });

  it("asks for the PIN again for a no-sale after a badge tap, then opens the drawer and logs it", async () => {
    const bar = await openSession("Bar drawer");
    as("maya", "bartender", "badge", "dev_bar_computer");
    const noPin = await post(`/drawer-sessions/${bar.id}/no-sale`, {
      reason: "Change for the jukebox",
    });
    expect(noPin.statusCode).toBe(400);
    expect(noPin.json().error.details.reason).toBe("pin");
    const ok = await post(`/drawer-sessions/${bar.id}/no-sale`, {
      reason: "Change for the jukebox",
      pin: "4071",
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await kicks("no_sale")).toBe(1);
    expect((await movesOf("Bar drawer")).moves.find((m) => m.kind === "no_sale")).toMatchObject({
      kind: "no_sale",
      amount_cents: 0,
      by: "Maya S.",
      reason: "Change for the jukebox",
    });
  });

  it("records Andy's $20.00 tip-out to Maya against her name", async () => {
    const bar = await openSession("Bar drawer");
    as("maya", "bartender", "pin", "dev_bar_computer");
    expect(
      (
        await post(`/drawer-sessions/${bar.id}/tip-out`, {
          paid_to: ids["maya"],
          amount_cents: 2000,
          pin: "4071",
        })
      ).statusCode,
    ).toBe(403);
    as("andy", "manager", "pin", "dev_bar_computer");
    const ok = await post(`/drawer-sessions/${bar.id}/tip-out`, {
      paid_to: ids["maya"],
      amount_cents: 2000,
      pin: "730915",
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await movesOf("Bar drawer")).moves.find((m) => m.kind === "tip_out")).toMatchObject({
      kind: "tip_out",
      amount_cents: 2000,
      paid_to: "Maya S.",
    });
  });

  it("moves each drawer's expected cash by its moves", async () => {
    as("andy", "manager", "passkey", "dev_phone_andy");
    const bar = await openSession("Bar drawer");
    const front = await openSession("Front-desk drawer");
    const b = await post(`/drawer-sessions/${bar.id}/count`, {
      counted_cents: 30000 - 4200 - 2000,
    });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json()).toMatchObject({
      paid_outs_cents: 4200,
      tip_outs_cents: 2000,
      over_short_cents: 0,
    });
    const f = await post(`/drawer-sessions/${front.id}/count`, { counted_cents: 30000 + 49860 });
    expect(f.statusCode, f.body).toBe(200);
    expect(f.json()).toMatchObject({
      drops_cents: 49860,
      expected_cents: 79860,
      over_short_cents: 0,
    });
  });

  it("refuses a drawer kick with nothing behind it, and never reprints one", async () => {
    const printer = ids["dev_bar_printer"]!;
    const bogus = withVenue(app, { venueId }, (c) =>
      c.query(
        `insert into print_jobs (venue_id, kind, station, payload, device_id, created_at)
         values ($1, 'drawer', 'bar', '{"reason": "cash", "payment_id": "00000000-0000-4000-8000-000000000000"}', $2, now())`,
        [venueId, printer],
      ),
    );
    await expect(bogus).rejects.toMatchObject({ code: "W4K01" });
    const job = (
      await owner.query<{ id: string }>(
        "select id from print_jobs where venue_id = $1 and kind = 'drawer' order by created_at limit 1",
        [venueId],
      )
    ).rows[0]!.id;
    const again = withVenue(app, { venueId }, (c) =>
      c.query(
        `insert into print_jobs (venue_id, kind, station, payload, device_id, created_at, reprint_of, reprint_n)
         select venue_id, kind, station, payload, device_id, now(), id, 2 from print_jobs where id = $1`,
        [job],
      ),
    );
    await expect(again).rejects.toMatchObject({ code: "W4K01" });
  });
});

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  recordNightClose,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { sweepDrawers } from "./drawers.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * A drawer per person with trays (M7-07; Money rules 15): the model follows
 * the setting in force at the business date's start, each person counts in
 * their own bank, only they take cash into it, and a pulled tray is counted
 * at close before the night can close.
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

interface TraySession extends PanelSession {
  owner: string | null;
  tray_label: string | null;
  model: string;
}
const bar = async () => (await panel()).drawers.find((d) => d.name === "Bar drawer")!;
const SAT = "2026-09-26";

describe("a drawer per person", () => {
  it("starts on Sat Sep 26 when Admin switches on Fri Sep 25, and Fri stays house drawers", async () => {
    as("abhishek", "owner", "passkey", "dev_phone_abhishek");
    const current = (await get("/settings/drawer")).json() as { value: Record<string, unknown> };
    const r = await api.inject({
      method: "PUT",
      url: `/v1/venues/${venueId}/settings/drawer`,
      headers: { "idempotency-key": `tray-${++n}` },
      payload: {
        value: {
          ...current.value,
          drawer: "perPerson",
          perPerson: { who: "bartenders", countLater: true },
        },
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(((await panel()) as unknown as { model: string }).model).toBe("house");
    // Friday's two house drawers are counted at its close.
    as("andy", "manager", "passkey", "dev_phone_andy");
    for (const d of (await panel()).drawers) {
      const s = d.sessions.find((x) => x.state === "open")!;
      expect(
        (await post(`/drawer-sessions/${s.id}/count`, { counted_cents: 30000 })).statusCode,
      ).toBe(200);
    }
    // Saturday evening: the sweep opens nothing, since each person counts in their own bank.
    clock.set(Temporal.Instant.from("2026-09-26T20:00:00-04:00"));
    expect(await sweepDrawers(owner, clock.now())).toBe(0);
    const sat = (await panel()) as unknown as Panel & { model: string; business_date: string };
    expect(sat.model).toBe("per_person");
    expect(sat.business_date).toBe(SAT);
    expect(sat.drawers.every((d) => d.sessions.length === 0)).toBe(true);
  });

  it("lets Maya count in $300.00 at the bar, and keeps everyone else's cash out of her session", async () => {
    const drawer = await bar();
    as("maya", "bartender", "badge", "dev_bar_computer");
    const noCount = await post(`/drawers/${drawer.id}/open`, {});
    expect(noCount.statusCode).toBe(400);
    expect(noCount.json().error.details.reason).toBe("count_in");
    const opened = await post(`/drawers/${drawer.id}/open`, { counted_cents: 30000, pin: "4071" });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toMatchObject({ opened: true, model: "per_person" });
    const s = (await bar()).sessions[0] as TraySession;
    expect(s).toMatchObject({
      model: "per_person",
      owner: "Maya S.",
      opened_with_cents: 30000,
      state: "open",
    });

    // Diego, covering the bar, can't ring into Maya's drawer or open it.
    as("diego", "front_desk", "pin", "dev_bar_computer");
    const noSale = await post(`/drawer-sessions/${s.id}/no-sale`, {
      reason: "change",
      pin: "6358",
    });
    expect(noSale.statusCode).toBe(403);
    expect(
      (await post(`/drawers/${drawer.id}/open`, { counted_cents: 30000, pin: "6358" })).statusCode,
    ).toBe(409);
    // A runner has no drawer of their own.
    as("andy", "manager", "pin", "dev_bar_computer");
    const managerOpen = await post(`/drawers/${drawer.id}/open`, {
      counted_cents: 30000,
      pin: "730915",
    });
    expect(managerOpen.statusCode).toBe(403);
    // Andy (a manager, not her) can't take cash into it either.
    const andyMove = await post(`/drawer-sessions/${s.id}/no-sale`, {
      reason: "change",
      pin: "730915",
    });
    expect(andyMove.statusCode).toBe(400);
    expect(andyMove.json().error.details).toMatchObject({
      reason: "not_your_drawer",
      owner: "Maya",
    });
  });

  it("pulls Maya's tray at clock-out, lets Diego count in a fresh bank, and won't close the night until the tray is counted", async () => {
    const drawer = await bar();
    as("diego", "front_desk", "pin", "dev_bar_computer");
    expect((await post(`/drawers/${drawer.id}/pull`, {})).statusCode).toBe(403);
    as("maya", "bartender", "pin", "dev_bar_computer");
    const pulled = await post(`/drawers/${drawer.id}/pull`, {});
    expect(pulled.statusCode, pulled.body).toBe(200);
    expect(pulled.json()).toMatchObject({ state: "pulled", tray_label: "Bar · Maya S." });
    as("diego", "front_desk", "pin", "dev_bar_computer");
    const fresh = await post(`/drawers/${drawer.id}/open`, { counted_cents: 30000, pin: "6358" });
    expect(fresh.statusCode, fresh.body).toBe(200);
    const sessions = (await bar()).sessions as TraySession[];
    expect(sessions.map((x) => [x.owner, x.state, x.tray_label])).toEqual([
      ["Diego R.", "open", null],
      ["Maya S.", "pulled", "Bar · Maya S."],
    ]);

    const close = () =>
      withVenue(app, { venueId }, (c) =>
        recordNightClose(c, venueId, {
          businessDate: SAT,
          closedAt: clock.now().toString(),
          closedBy: ids["andy"]!,
        }),
      );
    await expect(close()).rejects.toThrow("a pulled tray is still uncounted");

    // Counted blind at close; the $5.00 short stays on Maya's session.
    as("andy", "manager", "passkey", "dev_phone_andy");
    const tray = sessions[1]!;
    const counted = await post(`/drawer-sessions/${tray.id}/count`, { counted_cents: 29500 });
    expect(counted.statusCode, counted.body).toBe(200);
    expect(counted.json()).toMatchObject({ over_short_cents: -500 });
    const after = ((await bar()).sessions as TraySession[]).find((x) => x.id === tray.id)!;
    expect(after).toMatchObject({
      owner: "Maya S.",
      state: "counted",
      count: { over_short_cents: -500 },
    });
    await expect(close()).resolves.toMatchObject({ business_date: SAT });
  });
});

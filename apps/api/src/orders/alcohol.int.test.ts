import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, seedHostToken } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M3-20: every route that creates an alcohol line, with the window closed and with a cut-off. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const FOUR_AM = Temporal.Instant.from("2026-09-26T04:00:00-04:00");
let n = 0;
const cookieOf = (h: string | string[] | undefined) =>
  String(Array.isArray(h) ? h[0] : h).split(";")[0]!;
const staff = (method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const guest = (cookie: string, method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({
    method,
    url: `/v1/public/room-session${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
const host = async (session: string) =>
  cookieOf(
    (
      await app.inject({
        method: "POST",
        url: "/v1/public/room-session/host",
        payload: { token: seedHostToken(session) },
      })
    ).headers["set-cookie"],
  );
const friend = async () =>
  cookieOf(
    (
      await app.inject({
        method: "POST",
        url: `/v1/public/venues/west4karaoke/rooms/${ids["room_9"]}/join`,
        payload: { code: "KX4M7" },
      })
    ).headers["set-cookie"],
  );
const bud = () => ({
  client_order_id: `alcohol-test-${++n}-xyz`,
  lines: [{ variant_id: ids["menu_bud_regular"], qty: 1 }],
});
const refusals = async (reason: string) =>
  (
    await raw.query<{ n: number }>(
      "select count(*)::int as n from alcohol_refusals where reason = $1",
      [reason],
    )
  ).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  const maya: Principal = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async (r) => (r.url.startsWith("/v1/venues/") ? maya : undefined)],
    moduleCacheMs: 0,
  });
  await app.ready();
  await raw.query("update orders set status = 'delivered', delivered_at = now() where id = $1", [
    ids["order_o3"],
  ]);
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("with the alcohol window closed at 4:00 AM", () => {
  it("a guest's, the host's, a staff order from DeskRoom, Same again and Accept all answer 409 alcohol_closed, each logged", async () => {
    const f = await friend();
    const marcus = await host("sess_room9");
    const room3 = await host("sess_room3");
    clock.set(FOUR_AM);
    const tries = [
      await guest(f, "POST", "/orders", bud()),
      await guest(marcus, "POST", "/orders", bud()),
      await staff("POST", `/checks/${ids["chk_room9"]}/orders`, {
        lines: [{ variant_id: ids["menu_bud_regular"], qty: 1 }],
      }),
      await guest(room3, "POST", "/same-again", {
        order_id: ids["order_o3"],
        client_order_id: "again-at-4am-01",
      }),
      await staff("POST", `/orders/${ids["order_o2"]}/accept`, {}),
    ];
    for (const r of tries) {
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("alcohol_closed");
    }
    expect(await refusals("window_closed")).toBe(1 + 1 + 1 + 2 + 1);
    const byGuest = await raw.query<{ n: number }>(
      "select count(*)::int as n from alcohol_refusals where reason = 'window_closed' and room_guest_id is not null",
    );
    expect(byGuest.rows[0]!.n).toBe(4);
  });

  it("an order of only a Red Bull still goes through", async () => {
    const r = await staff("POST", `/checks/${ids["chk_room9"]}/orders`, {
      lines: [{ variant_id: ids["menu_redbull_regular"], qty: 1 }],
    });
    expect(r.statusCode).toBe(201);
  });

  it("every screen reads the window closed: the menus, the board and the guest's room", async () => {
    const menu = (await staff("GET", "/menu")).json();
    expect(menu.alcohol).toMatchObject({ state: "closed" });
    expect(Temporal.Instant.from(menu.alcohol.changes_at).toString()).toBe(
      Temporal.Instant.from("2026-09-26T08:00:00-04:00").toString(),
    );
    const pub = (
      await app.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/menu" })
    ).json();
    expect(pub.alcohol).toMatchObject({ state: "closed" });
    const board = await staff("GET", "/board");
    expect(board.json().alcohol).toMatchObject({ state: "closed" });
    expect((await guest(await host("sess_room9"), "GET", "")).json()).toMatchObject({
      alcohol_blocked: "window_closed",
    });
  });
});

describe("with a cut-off at 10:41 PM", () => {
  it("a room's cut-off refuses its alcohol orders with 409 cut_off; a guest's refuses only that guest", async () => {
    clock.set(SEED_NOW);
    await raw.query("update room_sessions set alcohol_cut_off_at = now() where id = $1", [
      ids["sess_room5"],
    ]);
    const r = await staff("POST", `/checks/${ids["chk_room5"]}/orders`, {
      lines: [{ variant_id: ids["menu_bud_regular"], qty: 1 }],
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("cut_off");
    expect(await refusals("cut_off")).toBe(1);
    expect(
      (await staff("GET", `/menu?session_id=${ids["sess_room5"]}`)).json().alcohol.blocked,
    ).toBe("cut_off");

    const cut = await friend();
    const fine = await friend();
    const token = cut.split("=")[1]!;
    await raw.query("update room_guests set alcohol_cut_off_at = now() where token_hash = $1", [
      createHash("sha256").update(token).digest("hex"),
    ]);
    const a = await guest(cut, "POST", "/orders", bud());
    const b = await guest(fine, "POST", "/orders", bud());
    expect(a.statusCode).toBe(409);
    expect(a.json().error.code).toBe("cut_off");
    expect(b.statusCode).toBe(201);
  });
});

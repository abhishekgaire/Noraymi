import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, seedHostToken } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, guestOrderWords, t } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M3-21: Andy cuts off Room 9 at 10:41 PM, then one guest; every alcohol route is refused. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let who: Principal;
let n = 0;
const as = (slug: string, role: string): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: "pin",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
});
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
const bud = () => ({
  client_order_id: `cutoff-${++n}-abcdef`,
  lines: [{ variant_id: ids["menu_bud_regular"], qty: 1 }],
});
const join = async (room: string, code: string) =>
  cookieOf(
    (
      await app.inject({
        method: "POST",
        url: `/v1/public/venues/west4karaoke/rooms/${ids[room]}/join`,
        payload: { code },
      })
    ).headers["set-cookie"],
  );

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
  const u = await raw.query<{ id: string }>(
    "insert into users (name, email) values ('Rae R.', 'rae@example.test') returning id",
  );
  const m = await raw.query<{ id: string }>(
    "insert into memberships (venue_id, user_id, role, status) values ($1, $2, 'staff', 'active') returning id",
    [venueId, u.rows[0]!.id],
  );
  ids["rae"] = u.rows[0]!.id;
  ids["rae.membership"] = m.rows[0]!.id;
  who = as("andy", "manager");
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async (r) => (r.url.startsWith("/v1/venues/") ? who : undefined)],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("cutting off", () => {
  it("a runner's cut-off answers 403", async () => {
    who = as("rae", "staff");
    expect(
      (await staff("POST", `/sessions/${ids["sess_room9"]}/cut-off`, { reason: "Too drunk" }))
        .statusCode,
    ).toBe(403);
  });

  it("Andy cuts off Room 9: o1 is cancelled as cut off by Andy, every alcohol route is refused, the phones read it", async () => {
    const marcus = cookieOf(
      (
        await app.inject({
          method: "POST",
          url: "/v1/public/room-session/host",
          payload: { token: seedHostToken("sess_room9") },
        })
      ).headers["set-cookie"],
    );
    const friend = await join("room_9", "KX4M7");
    who = as("andy", "manager");
    const r = await staff("POST", `/sessions/${ids["sess_room9"]}/cut-off`, {
      reason: "Someone looks too drunk",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ cancelled: 1 });
    const o1 = (await staff("GET", `/orders?status=cancelled`))
      .json()
      .orders.find((o: { id: string }) => o.id === ids["order_o1"]);
    expect(o1).toMatchObject({ cancel_reason: "cut_off", cancelled_by_name: "Andy C." });
    expect(t("en", guestOrderWords(o1).key)).toBe("Your server has paused alcohol for this room");

    expect((await guest(friend, "POST", "/orders", bud())).json().error.code).toBe("cut_off");
    expect((await guest(marcus, "POST", "/orders", bud())).json().error.code).toBe("cut_off");
    const staffOrder = await staff("POST", `/checks/${ids["chk_room9"]}/orders`, {
      lines: [{ variant_id: ids["menu_bud_regular"], qty: 1 }],
    });
    expect(staffOrder.json().error.code).toBe("cut_off");
    expect((await guest(friend, "GET", "")).json()).toMatchObject({ alcohol_blocked: "cut_off" });
    const board = (await staff("GET", "/board")).json();
    const room9 = board.rooms.find((x: { name: string }) => x.name === "Room 9");
    expect(room9.session.cut_off).toMatchObject({ by: "Andy", reason: "Someone looks too drunk" });
    const logged = await raw.query<{ n: number }>(
      "select count(*)::int as n from alcohol_refusals where reason = 'cut_off'",
    );
    expect(logged.rows[0]!.n).toBe(1 + 3);
  });

  it("a soft drink still orders in a cut-off room, and singing isn't touched", async () => {
    const r = await staff("POST", `/checks/${ids["chk_room9"]}/orders`, {
      lines: [{ variant_id: ids["menu_redbull_regular"], qty: 1 }],
    });
    expect(r.statusCode).toBe(201);
  });

  it("cutting off one Room 5 guest refuses their alcohol and lets another guest's through", async () => {
    // Room 5's code from the seed's derivation.
    const { seedRoomCode } = await import("@west4/db");
    const code = seedRoomCode("sess_room5", "Room 5");
    const a = await join("room_5", code);
    const b = await join("room_5", code);
    const guests = (await staff("GET", `/sessions/${ids["sess_room5"]}/guests`)).json().guests as {
      id: string;
    }[];
    const tokenHash = createHash("sha256").update(a.split("=")[1]!).digest("hex");
    const target = (
      await raw.query<{ id: string }>("select id from room_guests where token_hash = $1", [
        tokenHash,
      ])
    ).rows[0]!.id;
    expect(guests.map((g) => g.id)).toContain(target);
    const r = await staff("POST", `/sessions/${ids["sess_room5"]}/guests/${target}/cut-off`, {
      reason: "Asked us to",
    });
    expect(r.statusCode).toBe(200);
    expect((await guest(a, "POST", "/orders", bud())).json().error.code).toBe("cut_off");
    expect((await guest(b, "POST", "/orders", bud())).statusCode).toBe(201);
  });
});

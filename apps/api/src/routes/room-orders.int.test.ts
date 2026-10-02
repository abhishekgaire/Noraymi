import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, seedHostToken } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, guestOrderWords, t } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M3-09: ordering from a Room 9 phone, each step in the guest's words, cancel rules, 86. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let host = "";
let friend = "";
let n = 0;
const cookieOf = (h: string | string[] | undefined) =>
  String(Array.isArray(h) ? h[0] : h).split(";")[0]!;
const asGuest = (cookie: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const bar = (order: string, step: string, payload: object = {}) =>
  app.inject({ method: "POST", url: `/v1/venues/${venueId}/orders/${order}/${step}`, payload });
const words = async (cookie: string, orderId: string) => {
  const o = (await asGuest(cookie, "GET", "/v1/public/room-session/orders"))
    .json<{
      orders: { id: string; status: string; cancel_reason: string | null; can_cancel: boolean }[];
    }>()
    .orders.find((x) => x.id === orderId)!;
  return { text: t("en", guestOrderWords(o).key, { room: "Room 9" }), can_cancel: o.can_cancel };
};
const peach = async () =>
  (
    await raw.query<{ id: string }>(
      "select o.id from menu_options o join menu_items i on i.id = o.item_id where i.name = 'Margarita' and o.name = 'Peach'",
    )
  ).rows[0]!.id;
const order = async (cookie: string) =>
  asGuest(cookie, "POST", "/v1/public/room-session/orders", {
    client_order_id: `phone-order-${++n}-abcdef`,
    lines: [{ variant_id: ids["menu_marg_regular"], qty: 2, option_ids: [await peach()] }],
  });

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
  host = cookieOf(
    (
      await app.inject({
        method: "POST",
        url: "/v1/public/room-session/host",
        payload: { token: seedHostToken("sess_room9") },
      })
    ).headers["set-cookie"],
  );
  friend = cookieOf(
    (
      await app.inject({
        method: "POST",
        url: `/v1/public/venues/west4karaoke/rooms/${ids["room_9"]}/join`,
        payload: { code: "KX4M7" },
      })
    ).headers["set-cookie"],
  );
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("ordering from the room page", () => {
  it("2 × Margarita · Peach rings at the bar and reads Sent to the bar · you can still cancel", async () => {
    const r = await order(friend);
    expect(r.statusCode).toBe(201);
    expect(r.json().order).toMatchObject({
      status: "ringing",
      mine: true,
      can_cancel: true,
      amount_cents: 2600,
    });
    expect((await words(friend, r.json().order.id)).text).toBe(
      "Sent to the bar · you can still cancel",
    );
    const waiting = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/orders?status=ringing,held` })
    ).json<{ orders: { id: string; source: string }[] }>().orders;
    expect(waiting.find((o) => o.id === r.json().order.id)).toMatchObject({ source: "room" });
    // Not on the tab until the bar accepts it.
    const check = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/checks/${ids["chk_room9"]}` })
    ).json();
    expect(check.lines_cents).toBe(15800);
  });

  it("a retry with the same client_order_id doesn't order twice", async () => {
    const body = {
      client_order_id: "phone-retry-0001",
      lines: [{ variant_id: ids["menu_bud_regular"], qty: 1 }],
    };
    const a = await asGuest(friend, "POST", "/v1/public/room-session/orders", body);
    const b = await asGuest(friend, "POST", "/v1/public/room-session/orders", body);
    expect(b.json().order.id).toBe(a.json().order.id);
  });

  it("the guest's words follow each step; Cancel shows while ringing or asked to wait", async () => {
    const o = (await order(friend)).json().order.id as string;
    expect(await words(friend, o)).toEqual({
      text: "Sent to the bar · you can still cancel",
      can_cancel: true,
    });
    await bar(o, "hold");
    expect(await words(friend, o)).toEqual({
      text: "The bar needs a few minutes",
      can_cancel: true,
    });
    await bar(o, "accept");
    expect(await words(friend, o)).toEqual({ text: "Being made · on your tab", can_cancel: false });
    await bar(o, "ready");
    expect((await words(friend, o)).text).toBe("Being made · on your tab");
    await bar(o, "claim");
    expect((await words(friend, o)).text).toBe("On its way to Room 9");
    await bar(o, "deliver");
    expect((await words(friend, o)).text).toBe("Delivered");
  });

  it("the guest who placed it or the host can cancel, not another friend, and not once accepted", async () => {
    const mine = (await order(host)).json().order.id as string;
    const theirs = (await order(friend)).json().order.id as string;
    // The friend can't cancel the host's order; the host can cancel the friend's.
    expect((await words(friend, mine)).can_cancel).toBe(false);
    expect(
      (await asGuest(friend, "POST", `/v1/public/room-session/orders/${mine}/cancel`)).statusCode,
    ).toBe(403);
    const r = await asGuest(host, "POST", `/v1/public/room-session/orders/${theirs}/cancel`);
    expect(r.statusCode).toBe(200);
    expect((await words(friend, theirs)).text).toBe("Cancelled · nothing charged");
    await bar(mine, "accept");
    expect(
      (await asGuest(host, "POST", `/v1/public/room-session/orders/${mine}/cancel`)).statusCode,
    ).toBe(409);
  });

  it("a decline shows the guest the reason", async () => {
    const o = (await order(friend)).json().order.id as string;
    await bar(o, "decline", { reason: "Out of peach" });
    const list = (await asGuest(friend, "GET", "/v1/public/room-session/orders")).json<{
      orders: { id: string; decline_reason: string; status: string; cancel_reason: string }[];
    }>().orders;
    const mine = list.find((x) => x.id === o)!;
    expect(t("en", guestOrderWords(mine).key)).toBe(
      "The bar couldn't take this order · nothing charged",
    );
    expect(mine.decline_reason).toBe("Out of peach");
  });

  it("Hoegaarden is 86'd tonight and can't be ordered", async () => {
    const r = await asGuest(friend, "POST", "/v1/public/room-session/orders", {
      client_order_id: "phone-hoe-00001",
      lines: [{ variant_id: ids["menu_hoe_regular"], qty: 1 }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toMatchObject({ reason: "out_tonight" });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M2-25 acceptance on the demo seed at 10:41 PM. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let slug = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const staff = (method: "GET" | "POST" | "PATCH", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const pub = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { authorization: "" },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
type Entry = {
  id: string;
  name: string;
  party_size: number;
  joined_at: string;
  quoted_min: number | null;
  waited_min: number;
  bills_as: number;
  status: string;
};
const list = async () => (await staff("GET", "/waitlist")).json<{ entries: Entry[] }>().entries;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  slug = (await raw.query<{ slug: string }>("select slug from venues where id = $1", [venueId]))
    .rows[0]!.slug;
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  const diego: Principal = {
    kind: "user",
    userId: ids["diego"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["diego.membership"]!, role: "front_desk" }],
  };
  // Staff calls carry Diego; the guest's calls carry nobody.
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async (request) => (request.headers.authorization === "" ? undefined : diego)],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("the waitlist", () => {
  it("the drawer lists Amara B. (7, 10:15 PM, quoted 25, waited 26), Nadia K. (6) and Chris P. (3, bills as 4)", async () => {
    const entries = await list();
    expect(
      entries.map((e) => [e.name, e.party_size, e.quoted_min, e.waited_min, e.bills_as]),
    ).toEqual([
      ["Amara B.", 7, 25, 26, 7],
      ["Nadia K.", 6, 20, 20, 6],
      ["Chris P.", 3, 40, 4, 4],
    ]);
    expect(Temporal.Instant.from(entries[0]!.joined_at).toString()).toBe(
      Temporal.Instant.from("2026-09-25T22:15:00-04:00").toString(),
    );
  });

  let token = "";
  it("a guest who joins from the door QR as a party of 4 is fourth: 3 parties ahead", async () => {
    const r = await pub("POST", `/v1/public/venues/${slug}/waitlist`, {
      name: "Jordan L.",
      phone: "+12125550145",
      party_size: 4,
    });
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json<{
      token: string;
      spot: { ahead: number; quoted_min: number | null; party_size: number };
    }>();
    token = body.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.spot).toMatchObject({ ahead: 3, quoted_min: null, party_size: 4 });
    const page = await pub("GET", `/v1/public/waitlist/${token}`);
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.json()).toMatchObject({
      spot: { venue_name: "West 4 Boho Karaoke", ahead: 3, status: "waiting" },
    });
    expect((await pub("GET", "/v1/public/waitlist/not-a-real-token-at-all")).statusCode).toBe(404);
    const hashed = await raw.query<{ link_token_hash: string }>(
      "select link_token_hash from waitlist_entries where source = 'door'",
    );
    expect(hashed.rows[0]!.link_token_hash).not.toContain(token);
    // A party of 3 joins too: allowed, and it bills as 4 on Friday.
    const three = await pub("POST", `/v1/public/venues/${slug}/waitlist`, {
      name: "Kim S.",
      phone: "+12125550146",
      party_size: 3,
    });
    expect(three.json()).toMatchObject({ spot: { bills_as: 4, day_of_week: 5, ahead: 4 } });
    expect(
      (
        await pub("POST", `/v1/public/venues/${slug}/waitlist`, {
          name: "Kim S.",
          phone: "+12125550146",
          party_size: 3,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await pub("POST", "/v1/public/venues/nowhere/waitlist", {
          name: "A",
          phone: "+12125550147",
          party_size: 2,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("Remove takes a party off every screen at once", async () => {
    const amara = (await list()).find((e) => e.name === "Amara B.")!;
    const before = await raw.query<{ n: number }>(
      "select count(*)::int as n from venue_events where type = 'waitlist.updated'",
    );
    expect((await staff("POST", `/waitlist/${amara.id}/remove`)).statusCode).toBe(200);
    expect((await list()).map((e) => e.name)).not.toContain("Amara B.");
    const after = await raw.query<{ n: number }>(
      "select count(*)::int as n from venue_events where type = 'waitlist.updated'",
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);
    expect((await pub("GET", `/v1/public/waitlist/${token}`)).json()).toMatchObject({
      spot: { ahead: 2 },
    });
  });

  it("staff add a party with a quote and set quotes; the guest leaves from the page", async () => {
    const r = await staff("POST", "/waitlist", {
      name: "Lee H.",
      phone: "+12125550150",
      party_size: 5,
      quoted_min: 30,
    });
    expect(r.statusCode, r.body).toBe(201);
    const quoted = await staff("PATCH", `/waitlist/${ids["wl_3"]}`, { quoted_min: 35 });
    expect(quoted.json()).toMatchObject({ entry: { quoted_min: 35 } });
    const left = await pub("PATCH", `/v1/public/waitlist/${token}`, { action: "leave" });
    expect(left.json()).toMatchObject({ spot: { status: "left", ahead: null } });
    expect((await list()).map((e) => e.name)).not.toContain("Jordan L.");
    expect(
      (await pub("PATCH", `/v1/public/waitlist/${token}`, { action: "decline" })).statusCode,
    ).toBe(400);
  });

  it("Text opens the entry's conversation", async () => {
    const r = await staff("POST", `/waitlist/${ids["wl_2"]}/text`);
    expect(r.statusCode, r.body).toBe(200);
    const conv = await raw.query(
      "select context_kind, context_id from conversations where id = $1",
      [r.json<{ conversation_id: string }>().conversation_id],
    );
    expect(conv.rows[0]).toEqual({ context_kind: "waitlist", context_id: ids["wl_2"] });
  });
});

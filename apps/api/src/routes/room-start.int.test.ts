import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { packageLineShares, prepaidBlockCents } from "@west4/rules";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  cents,
  newYorkCounty,
  newYorkCountyTaxed,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Starting a room (P-04; spec 05 · rule 3, Prepaid block), on the demo seed and the simulated clock.
 * A walk-in on Room 11 with 4 guests bills $40.00 an hour (Friday's minimum of 4 at $10.00). A note
 * shows on the board; a prepaid 2 h block bills $80.00 even after 75 minutes and the minutes past
 * it as today; a package with a length sets the room's time, puts its lines on the tab and its
 * room-time share is the block. A package with a length isn't added to a running tab, and with
 * Packages & specials off the server refuses one at the start. The packages are test data.
 */
const at = (hhmm: string, day = "2026-09-25") => Temporal.Instant.from(`${day}T${hhmm}:00-04:00`);

let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new SimulatedClock(SEED_NOW);
const pkg: Record<string, string> = {};

const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
interface BoardSession {
  id: string;
  check_id: string;
  note: string | null;
  prepaid: { minutes: number; package_name: string | null } | null;
  room_time_cents: number;
  booked_end_at: string;
}
const boardSession = async (room: string) => {
  const r = await req("GET", "/board");
  expect(r.statusCode, r.body).toBe(200);
  const found = (
    r.json() as { rooms: { room_id: string; session: BoardSession | null }[] }
  ).rooms.find((x) => x.room_id === room);
  return found!.session!;
};
/** Ends a session and marks its room clean, so the next test can take it. */
const endSession = async (id: string, room: string) => {
  const ended = await req("POST", `/sessions/${id}/end`);
  expect((await req("POST", `/rooms/${room}/clean`)).statusCode).toBeLessThan(300);
  return ended;
};
/** A room free now for `minutes` and a cleaning after, so a walk-in never meets a booking. */
const roomFor = async (minutes: number) => {
  const board = (await req("GET", "/board")).json() as {
    rooms: {
      room_id: string;
      free_now: boolean;
      state: string;
      session: object | null;
      free_until: string | null;
      words: { kind: string };
    }[];
  };
  const need = clock.now().add({ minutes });
  const room = board.rooms.find(
    (r) =>
      r.free_now &&
      r.state === "available" &&
      r.session === null &&
      (r.words.kind === "free_all_night" ||
        (r.free_until !== null &&
          Temporal.Instant.compare(Temporal.Instant.from(r.free_until), need) >= 0)),
  );
  expect(room, "a free room").toBeDefined();
  return room!.room_id;
};

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
  const one = async (sql: string, params: unknown[]) =>
    (await raw.query<{ id: string }>(sql, params)).rows[0]!.id;
  const cat = await one(
    "insert into menu_categories (venue_id, name, sort, tax_category) values ($1, 'TEST Soda', 900, 'drink') returning id",
    [venueId],
  );
  const soda = await one(
    "insert into menu_items (venue_id, category_id, name) values ($1, $2, 'TEST soda') returning id",
    [venueId, cat],
  );
  await raw.query(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Can', 300)",
    [venueId, soda],
  );
  pkg["party"] = await one(
    `insert into packages (venue_id, name, price_cents, contents, minutes, checked_pack_version)
       values ($1, 'TEST Party pack', 9000, $2, 90, 'unchecked') returning id`,
    [venueId, JSON.stringify([{ item_id: soda, qty: 2 }])],
  );
  pkg["hour"] = await one(
    `insert into packages (venue_id, name, price_cents, contents, minutes, checked_pack_version)
       values ($1, 'TEST Happy hour room', 3000, '[]', 60, 'unchecked') returning id`,
    [venueId],
  );
  pkg["plain"] = await one(
    `insert into packages (venue_id, name, price_cents, contents, checked_pack_version)
       values ($1, 'TEST Soda pair', 500, $2, 'unchecked') returning id`,
    [venueId, JSON.stringify([{ item_id: soda, qty: 2 }])],
  );
  const m = (
    await raw.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'front_desk'",
      [venueId],
    )
  ).rows[0]!;
  const diego: Principal = {
    kind: "user",
    userId: m.user_id,
    session: "pin",
    memberships: [{ venueId, membershipId: m.id, role: "front_desk" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => diego],
    moduleCacheMs: 0,
  });
  await app.ready();
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(raw as never, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
});

afterAll(async () => {
  await app?.close();
  await raw?.end();
  await db?.drop();
});

describe("starting a room (P-04)", () => {
  // The night runs forward: each test starts after the one before it ended.
  it("a booking's check-in takes a note too", async () => {
    clock.set(at("22:44"));
    const r = await req("POST", `/bookings/${ids["bk_sam"]}/check-in`, {
      party_size: 3,
      ids_checked: 3,
      note: "Allergic to peanuts",
    });
    expect(r.statusCode, r.body).toBe(201);
    const s = await boardSession(ids["room_2"]!);
    expect(s.note).toBe("Allergic to peanuts");
    expect(s.prepaid).toBeNull();
  });

  it("a prepaid 2 h block with a note: $80.00 after 75 min, the 13 min past it as today", async () => {
    clock.set(at("22:45"));
    const room = await roomFor(120);
    const r = await req("POST", `/rooms/${room}/sessions`, {
      party_size: 4,
      ids_checked: 4,
      minutes: 120,
      time: "prepaid",
      note: "  Nia's birthday · cake at 11  ",
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ hourly_cents: 4000 });
    const row = (
      await raw.query(
        "select note, prepaid_minutes, prepaid_cents, package_id from room_sessions where id = $1",
        [r.json().session_id],
      )
    ).rows[0];
    expect(row).toEqual({
      note: "Nia's birthday · cake at 11",
      prepaid_minutes: 120,
      prepaid_cents: 8000,
      package_id: null,
    });
    let s = await boardSession(room);
    expect(s.note).toBe("Nia's birthday · cake at 11");
    expect(s.prepaid).toEqual({ minutes: 120, package_name: null });
    expect(s.room_time_cents).toBe(8000);
    clock.set(at("22:45").add({ minutes: 75 })); // pay as you go would be $50.00
    expect((await boardSession(room)).room_time_cents).toBe(8000);
    clock.set(at("22:45").add({ minutes: 133 }));
    s = await boardSession(room);
    expect(s.room_time_cents).toBe(8867);
    expect((await endSession(s.id, room)).statusCode).toBeLessThan(300);
  });

  it("pay as you go is the default: no block, today's billing", async () => {
    clock.set(at("22:45").add({ minutes: 140 }));
    const room = await roomFor(90);
    const r = await req("POST", `/rooms/${room}/sessions`, {
      party_size: 4,
      ids_checked: 4,
      minutes: 90,
    });
    expect(r.statusCode, r.body).toBe(201);
    const hourly = (r.json() as { hourly_cents: number }).hourly_cents;
    const row = (
      await raw.query(
        "select note, prepaid_minutes, prepaid_cents from room_sessions where id = $1",
        [r.json().session_id],
      )
    ).rows[0];
    expect(row).toEqual({ note: null, prepaid_minutes: null, prepaid_cents: null });
    clock.set(clock.now().add({ minutes: 75 }));
    const s = await boardSession(room);
    expect(s.prepaid).toBeNull();
    expect(s.room_time_cents).toBe(Math.floor((hourly * 75 + 30) / 60));
    expect((await endSession(s.id, room)).statusCode).toBeLessThan(300);
  });

  it("the start's package menu lists only packages with a length; a tab's lists none of them", async () => {
    const start = await req("GET", "/package-menu?at_start=1");
    expect(start.statusCode, start.body).toBe(200);
    const names = (start.json() as { packages: { name: string; minutes: number }[] }).packages;
    expect(names.map((p) => [p.name, p.minutes]).sort()).toEqual([
      ["TEST Happy hour room", 60],
      ["TEST Party pack", 90],
    ]);
    const tab = await req("GET", "/package-menu");
    const tabNames = (tab.json() as { packages: { name: string }[] }).packages.map((p) => p.name);
    expect(tabNames).toContain("TEST Soda pair");
    expect(tabNames).not.toContain("TEST Party pack");
    expect(tabNames).not.toContain("TEST Happy hour room");
  });

  it("a package with a length sets the room's time, puts its lines on the tab, and its share is the block", async () => {
    clock.set(clock.now().add({ minutes: 5 }));
    const start = clock.now();
    const room = await roomFor(90);
    const r = await req("POST", `/rooms/${room}/sessions`, {
      party_size: 4,
      ids_checked: 4,
      minutes: 60, // the package's length wins
      package_id: pkg["party"],
    });
    expect(r.statusCode, r.body).toBe(201);
    const seated = r.json() as { session_id: string; check_id: string; hourly_cents: number };
    // 9000 over the block (90 min at the room's rate) and two sodas at 300, largest remainder.
    const shares = packageLineShares(cents(9000), [
      { regularCents: prepaidBlockCents(90, cents(seated.hourly_cents)) },
      { regularCents: 300 },
      { regularCents: 300 },
    ]);
    const row = (
      await raw.query(
        `select prepaid_minutes, prepaid_cents, package_id, to_json(booked_end_at) #>> '{}' as end
           from room_sessions where id = $1`,
        [seated.session_id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      prepaid_minutes: 90,
      prepaid_cents: shares[0],
      package_id: pkg["party"],
    });
    const startMinute = start.round({ smallestUnit: "minute", roundingMode: "floor" });
    expect(Temporal.Instant.from(row.end).equals(startMinute.add({ minutes: 90 }))).toBe(true);
    const check = await req("GET", `/checks/${seated.check_id}`);
    expect(check.statusCode, check.body).toBe(200);
    const items = (
      check.json() as {
        lines: { kind: string; amount_cents: number; package?: { name: string } }[];
      }
    ).lines.filter((l) => l.kind === "item" && l.package);
    expect(items.map((l) => l.amount_cents)).toEqual([shares[1], shares[2]]);
    expect(items[0]!.package!.name).toBe("TEST Party pack");
    const s = await boardSession(room);
    expect(s.prepaid).toEqual({ minutes: 90, package_name: "TEST Party pack" });
    expect(s.room_time_cents).toBe(shares[0]);
    // Gone after 30 minutes: the package's price, all of it.
    clock.set(clock.now().add({ minutes: 30 }));
    const after = await boardSession(room);
    expect(after.room_time_cents + items[0]!.amount_cents + items[1]!.amount_cents).toBe(9000);
    // A package with a length is never added to a running tab.
    const onTab = await req("POST", `/checks/${seated.check_id}/packages`, {
      package_id: pkg["hour"],
    });
    expect(onTab.statusCode, onTab.body).toBe(400);
    expect(onTab.json().error.details.reason).toBe("starts_room");
    expect((await endSession(s.id, room)).statusCode).toBeLessThan(300);
  });

  it("a package of room time alone is the whole block", async () => {
    clock.set(clock.now().add({ minutes: 5 }));
    const room = await roomFor(60);
    const r = await req("POST", `/rooms/${room}/sessions`, {
      party_size: 4,
      ids_checked: 4,
      minutes: 120,
      package_id: pkg["hour"],
    });
    expect(r.statusCode, r.body).toBe(201);
    const row = (
      await raw.query("select prepaid_minutes, prepaid_cents from room_sessions where id = $1", [
        r.json().session_id,
      ])
    ).rows[0];
    expect(row).toEqual({ prepaid_minutes: 60, prepaid_cents: 3000 });
    const s = await boardSession(room);
    expect(s.room_time_cents).toBe(3000);
    expect((await endSession(s.id, room)).statusCode).toBeLessThan(300);
  });

  it("refuses a package without a length at the start, a note over 200 characters, and a package while Packages & specials is off", async () => {
    clock.set(clock.now().add({ minutes: 5 }));
    const room = await roomFor(60);
    const body = { party_size: 4, ids_checked: 4, minutes: 60 };
    const plain = await req("POST", `/rooms/${room}/sessions`, {
      ...body,
      package_id: pkg["plain"],
    });
    expect(plain.statusCode, plain.body).toBe(400);
    expect(plain.json().error.details.reason).toBe("no_length");
    const long = await req("POST", `/rooms/${room}/sessions`, {
      ...body,
      note: "x".repeat(201),
    });
    expect(long.statusCode).toBe(400);
    await raw.query(
      "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'packages'",
      [venueId],
    );
    try {
      const off = await req("POST", `/rooms/${room}/sessions`, {
        ...body,
        package_id: pkg["party"],
      });
      expect(off.statusCode, off.body).toBe(404);
      expect(off.json().error.code).toBe("module_off");
      // Nobody was seated.
      expect(
        (
          await raw.query("select 1 from room_sessions where room_id = $1 and ended_at is null", [
            room,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await raw.query(
        "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'packages'",
        [venueId],
      );
    }
  });
});

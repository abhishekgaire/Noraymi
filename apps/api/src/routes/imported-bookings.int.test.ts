import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyDeposits,
  checkMapping,
  generateSigningKey,
  loadDemoSeed,
  prepareImport,
  publishRulePack,
  resolveVenue,
  runImport,
  withVenue,
  type ImportResult,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * M9-02 through the API: imported bookings still to come show on the
 * Calendar and the board with their deposits, check in like any booking
 * (the old system's deposit applied), reproduce the worked example, never
 * show as Unmatched payments or as deposits taken tonight, and the one that
 * fits no room is on the manager's list. The export is made up for the test.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let imported: ImportResult;
const clock = new FrozenClock(SEED_NOW);
const oct2 = (hhmm: string) =>
  Temporal.ZonedDateTime.from(`2026-10-02T${hhmm}:00[America/New_York]`).toInstant();
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });

const FILES: Record<string, string> = {
  "mapping.json": JSON.stringify({
    mapping_version: 1,
    source: "test-future-bookings",
    files: {
      guests: { file: "guests.csv", columns: { legacy_ref: "id", name: "name", phone: "phone" } },
      policies: {
        file: "terms.csv",
        columns: { legacy_ref: "id", text: "text", refund_hours: "hours" },
      },
      bookings: {
        file: "bookings.csv",
        columns: {
          legacy_ref: "id",
          guest_ref: "guest",
          room: "room",
          party_size: "party",
          starts_at: "start",
          ends_at: "end",
          deposit: "deposit",
          policy_ref: "terms",
          accepted_at: "agreed",
        },
        defaults: { status: "confirmed" },
      },
    },
  }),
  "guests.csv": "id,name,phone\nG1,Marcus T.,(212) 555-0109\nG2,Big Party,(212) 555-0140\n",
  "terms.csv": 'id,text,hours\nT1,"Test terms (made up): cancel 24 hours ahead for a refund.",24\n',
  "bookings.csv":
    "id,guest,room,party,start,end,deposit,terms,agreed\n" +
    "OLD-9,G1,Room 8,12,2026-10-02 21:00,2026-10-03 00:00,$120.00,T1,2026-09-20 14:00\n" +
    "OLD-40,G2,Room 1,41,2026-10-02 21:00,2026-10-02 23:00,$400.00,T1,\n",
};

const manager = (): Principal => ({
  kind: "user",
  userId: ids["andy"]!,
  session: "passkey",
  memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
});

/** The first value under a key anywhere in a JSON body. */
function find(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  if (key in body) return (body as Record<string, unknown>)[key];
  for (const v of Object.values(body)) {
    const f = find(v, key);
    if (f !== undefined) return f;
  }
  return undefined;
}

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
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => manager()],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("imported bookings through the API (M9-02)", () => {
  let reportBefore: unknown;
  let unmatchedBefore: unknown;

  it("imports into West 4 without touching tonight's deposits taken or Unmatched payments", async () => {
    clock.set(SEED_NOW);
    reportBefore = find(
      (await req("GET", "/nights/2026-09-25/report")).json(),
      "deposits_taken_cents",
    );
    unmatchedBefore = (await req("GET", "/payments/unmatched")).json().payments;
    const venue = await resolveVenue(owner, venueId);
    const mapping = checkMapping(JSON.parse(FILES["mapping.json"]!)).mapping!;
    imported = await runImport({
      pool: owner,
      venue,
      prepared: prepareImport(mapping, (f) => FILES[f]!, venue.timeZone),
      dryRun: false,
      cutoverDate: "2026-09-25",
    });
    expect(imported.reconciles).toBe(true);
    expect(imported.deposits).toMatchObject({
      held_cents: 52000,
      payments_cents: 12000,
      on_list_cents: 40000,
    });
    expect(reportBefore).toEqual(expect.any(Number));
    expect(
      find((await req("GET", "/nights/2026-09-25/report")).json(), "deposits_taken_cents"),
    ).toBe(reportBefore);
    expect((await req("GET", "/payments/unmatched")).json().payments).toEqual(unmatchedBefore);
  });

  it("shows the booking on the Calendar with its deposit, its terms and its refund cut-off", async () => {
    const r = await req("GET", "/bookings?business_date=2026-10-02");
    expect(r.statusCode, r.body).toBe(200);
    const b = (r.json().bookings as Record<string, unknown>[]).find(
      (x) => x["legacy_ref"] === "OLD-9" || x["guest_name"] === "Marcus T.",
    );
    expect(b).toMatchObject({ deposit_cents: 12000, party_size: 12, status: "confirmed" });
    const row = await owner.query(
      `select r.name as room, b.source, b.accepted_at = '2026-09-20T18:00:00Z' as accepted,
              b.refund_cutoff_at = '2026-10-02T01:00:00Z' as cutoff, p.kind
         from bookings b join rooms r on r.id = b.room_id join policy_versions p on p.id = b.policy_version_id
        where b.venue_id = $1 and b.legacy_ref = 'OLD-9'`,
      [venueId],
    );
    expect(row.rows[0]).toEqual({
      room: "Room 8",
      source: "import",
      accepted: true,
      cutoff: true,
      kind: "imported_terms",
    });
  });

  it("puts the booking that fits no room on the manager's list, never dropped", async () => {
    const r = await req("GET", "/bookings/no-room");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().bookings).toEqual([
      expect.objectContaining({
        legacy_ref: "OLD-40",
        guest_name: "Big Party",
        party_size: 41,
        room_named: "Room 1",
        deposit_cents: 40000,
        reason: "no_room",
        business_date: "2026-10-02",
      }),
    ]);
  });

  it("shows the booking on its night's board, and check-in applies the old system's deposit", async () => {
    clock.set(oct2("20:30"));
    const board = await req("GET", "/board");
    expect(board.statusCode, board.body).toBe(200);
    const room8 = (board.json().rooms as Record<string, unknown>[]).find(
      (x) => x["name"] === "Room 8",
    );
    expect(room8?.["next"]).toMatchObject({ name: "Marcus T.", party_size: 12 });
    clock.set(oct2("21:05"));
    const id = (
      await owner.query<{ id: string }>(
        "select id from bookings where venue_id = $1 and legacy_ref = 'OLD-9'",
        [venueId],
      )
    ).rows[0]!.id;
    const preview = await req("GET", `/check-in/preview?booking=${id}`);
    expect(preview.json().deposit_cents).toBe(12000);
    const seated = await req("POST", `/bookings/${id}/check-in`, {
      party_size: 12,
      ids_checked: 12,
    });
    expect(seated.statusCode, seated.body).toBe(201);
    expect(seated.json()).toMatchObject({ deposit_applied_cents: 12000 });
    const tile = ((await req("GET", "/board")).json().rooms as Record<string, unknown>[]).find(
      (x) => x["name"] === "Room 8",
    );
    expect(find(tile, "deposit_cents")).toBe(12000);
  });

  it("a rehearsal copy of Marcus's $120.00 deposit on the worked example's check: −$120.00 and $498.60 to pay", async () => {
    clock.set(SEED_NOW);
    // The copy: an imported booking for Room 9 tonight, carrying the old system's $120.00.
    const venue = await resolveVenue(owner, venueId);
    const mapping = checkMapping(JSON.parse(FILES["mapping.json"]!)).mapping!;
    const files = {
      ...FILES,
      "bookings.csv":
        "id,guest,room,party,start,end,deposit,terms,agreed\n" +
        "OLD-MARCUS,G1,Room 9,12,2026-09-30 20:00,2026-09-30 23:00,$120.00,T1,\n",
    };
    await runImport({
      pool: owner,
      venue,
      prepared: prepareImport(mapping, (f) => files[f as keyof typeof files]!, venue.timeZone),
      dryRun: false,
      cutoverDate: "2026-09-25",
    });
    const copy = (
      await owner.query<{ id: string }>(
        "select id from bookings where venue_id = $1 and legacy_ref = 'OLD-MARCUS'",
        [venueId],
      )
    ).rows[0]!.id;
    // Room 9's check as in the worked example, with the copy's deposit in place of the seed's card one:
    // the same step check-in runs (applyDeposits).
    const check = ids["chk_room9"]!;
    await owner.query(
      `update payment_allocations set state = 'released'
        where venue_id = $1 and check_id = $2 and state = 'captured'
          and payment_id in (select id from payments where booking_id is not null)`,
      [venueId, check],
    );
    expect(
      await withVenue(app, { venueId }, (c) =>
        applyDeposits(c, venueId, { bookingId: copy, checkId: check }),
      ),
    ).toBe(12000);
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    expect((await req("POST", `/checks/${check}/present`)).statusCode).toBe(200);
    const r = await req("GET", `/checks/${check}`);
    expect(r.json()).toMatchObject({
      deposit_cents: 12000,
      amount_due_cents: 49860,
      totals: { total_cents: 61860 },
    });
  });
});

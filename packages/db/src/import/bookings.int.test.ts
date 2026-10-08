import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isBalanced } from "@west4/rules";
import { readSeedFile } from "../seed.js";
import { createTestDatabase, seedTwoVenues, type TestDatabase } from "../test-helpers.js";
import { formatReport, resolveVenue, runImport, type ImportResult, type Venue } from "./load.js";
import { checkMapping } from "./mapping.js";
import { prepareImport } from "./prepare.js";

/**
 * M9-02: the rehearsal's 11 bookings imported as bookings still to come (the
 * export taken before the night, so "Arrived" reads as confirmed), each with
 * a real room, its old terms, its deposit as an `external` payment, a manage
 * link, and an opening journal that puts the deposits in customer deposits.
 */
const dir = join(import.meta.dirname, "../../test-fixtures/import/rehearsal");
let db: TestDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let venue: Venue;
let venueB: string;
let first: ImportResult;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The rehearsal export as taken before the night, plus two bookings the venue can't seat as named. */
function futureExport(extra = "") {
  const mapping = checkMapping(
    JSON.parse(readFileSync(join(dir, "mapping.json"), "utf8")),
  ).mapping!;
  return prepareImport(
    mapping,
    (f) => {
      const text = readFileSync(join(dir, f), "utf8");
      return f !== "reservations.csv"
        ? text
        : text.replaceAll(",Arrived,", ",Confirmed,") +
            // Room 9 is Marcus's at that time: this party of 6 gets the smallest free room that fits.
            "BK-ROOM9-TOO,G-SAM,Room 9,6,2026-09-25 20:00,2026-09-25 22:00,$60.00,Confirmed,TERMS-1\n" +
            // No room seats 40: on the manager's list, deposit and all.
            "BK-FORTY,G-DANA,Room 1,40,2026-09-25 20:00,2026-09-25 23:00,$400.00,Confirmed,TERMS-1\n" +
            extra;
    },
    venue.timeZone,
  );
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  pool = new pg.Pool({ connectionString: db.url, max: 3 });
  const v = await seedTwoVenues(db.url);
  venueB = v.venueB;
  for (const r of readSeedFile().rooms) {
    await owner.query(
      `insert into rooms (venue_id, name, size_tier, capacity_min, capacity_max, is_vip) values ($1, $2, $3, $4, $5, $6)`,
      [v.venueA, r.name, r.size_tier, r.capacity_min, r.capacity_max, r.is_vip],
    );
  }
  venue = await resolveVenue(owner, v.venueA);
  first = await runImport({
    pool,
    venue,
    prepared: futureExport(),
    dryRun: false,
    cutoverDate: "2026-09-24",
    batchSize: 4,
  });
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("imported bookings still to come (M9-02)", () => {
  it("gives each a real room by the assignment rules, and lists the one that fits none", async () => {
    expect(first.reconciles).toBe(true);
    expect(first.kinds.bookings).toMatchObject({
      in_files: 13,
      loaded: 13,
      in_db: 13,
      cents_in_files: 99000 + 6000 + 40000,
      cents_in_db: 99000 + 6000 + 40000,
      by: { named_room: 11, another_room: 1, no_room: 1 },
    });
    const blocks = await owner.query<{ legacy_ref: string; room: string; ok: boolean }>(
      `select b.legacy_ref, r.name as room, (lower(k.period) = b.starts_at and upper(k.period) >= b.ends_at) as ok
         from bookings b join room_blocks k on k.venue_id = b.venue_id and k.ref_id = b.id and k.kind = 'booking'
         join rooms r on r.id = b.room_id and r.id = k.room_id
        where b.venue_id = $1 order by b.legacy_ref`,
      [venue.id],
    );
    expect(blocks.rows).toHaveLength(12);
    expect(blocks.rows.every((x) => x.ok)).toBe(true);
    expect(blocks.rows.find((x) => x.legacy_ref === "BK-MARCUS")!.room).toBe("Room 9");
    expect(blocks.rows.find((x) => x.legacy_ref === "BK-ROOM9-TOO")!.room).not.toBe("Room 9");
    const listed = await owner.query(
      "select legacy_ref, party_size, room_named, deposit_legacy_cents, reason from import_unplaced where venue_id = $1",
      [venue.id],
    );
    expect(listed.rows).toEqual([
      {
        legacy_ref: "BK-FORTY",
        party_size: 40,
        room_named: "Room 1",
        deposit_legacy_cents: 40000,
        reason: "no_room",
      },
    ]);
    expect(first.no_room).toEqual([{ legacy_ref: "BK-FORTY", file: "reservations.csv", line: 14 }]);
    expect(formatReport(first)).toContain(
      "fits no room, on the manager's list: reservations.csv:14 BK-FORTY",
    );
  });

  it("keeps each deposit as an external payment of the booking, captured, never a Stripe charge", async () => {
    const r = await owner.query<{ n: number; cents: string; external: boolean; no_pi: boolean }>(
      `select count(*)::int as n, sum(p.amount_cents)::text as cents, bool_and(p.method = 'external' and p.status = 'captured'
                and p.business_date = '2026-09-24' and b.deposit_cents = p.amount_cents
                and b.deposit_legacy_cents = p.amount_cents) as external,
              bool_and(p.stripe_pi_id is null) as no_pi
         from payments p join bookings b on b.venue_id = p.venue_id and b.id = p.booking_id
        where p.venue_id = $1`,
      [venue.id],
    );
    expect(r.rows[0]).toEqual({ n: 12, cents: String(99000 + 6000), external: true, no_pi: true });
    const events = await owner.query(
      "select distinct source from payment_events where venue_id = $1",
      [venue.id],
    );
    expect(events.rows).toEqual([{ source: "import" }]);
  });

  it("keeps the old terms as their own policy version, with each booking's refund cut-off from them", async () => {
    const terms = readFileSync(join(dir, "terms.csv"), "utf8");
    const pv = await owner.query<{ kind: string; version: number; text: string; hash: string }>(
      "select kind, version, text, hash from policy_versions where venue_id = $1",
      [venue.id],
    );
    expect(pv.rows).toHaveLength(1);
    expect(pv.rows[0]).toMatchObject({ kind: "imported_terms", version: 1 });
    expect(terms).toContain(pv.rows[0]!.text);
    expect(pv.rows[0]!.hash).toBe(sha(pv.rows[0]!.text));
    const cut = await owner.query<{ n: number; ok: boolean }>(
      `select count(*)::int as n,
              bool_and(policy_version_id is not null and refund_cutoff_at = starts_at - interval '24 hours') as ok
         from bookings where venue_id = $1`,
      [venue.id],
    );
    expect(cut.rows[0]).toEqual({ n: 12, ok: true });
  });

  it("gives each booking a manage link, kept only as its hash", async () => {
    expect(first.manage_links).toHaveLength(12);
    const marcus = first.manage_links.find((l) => l.legacy_ref === "BK-MARCUS")!;
    const hash = createHash("sha256").update(marcus.token).digest("hex");
    const r = await owner.query("select legacy_ref from bookings where manage_token_hash = $1", [
      hash,
    ]);
    expect(r.rows).toEqual([{ legacy_ref: "BK-MARCUS" }]);
    const stored = await owner.query<{ report: string }>(
      "select report::text from import_runs where id = $1",
      [first.run_id],
    );
    expect(stored.rows[0]!.report).not.toContain(marcus.token);
  });

  it("puts the imported deposits in customer deposits in an opening journal that balances", async () => {
    expect(first.deposits).toEqual({
      cutover_date: "2026-09-24",
      held_cents: 145000,
      payments_cents: 105000,
      on_list_cents: 40000,
    });
    expect(isBalanced(first.opening_journal)).toBe(true);
    expect(first.opening_journal).toMatchObject({
      kind: "opening",
      date: "2026-09-24",
      lines: expect.arrayContaining([
        { account: "customer_deposits", debit_cents: 0, credit_cents: 145000 },
        { account: "legacy_deposits", debit_cents: 145000, credit_cents: 0 },
      ]),
    });
    const run = await owner.query(
      "select cutover_date::text, opening_journal from import_runs where id = $1",
      [first.run_id],
    );
    expect(run.rows[0]).toEqual({
      cutover_date: "2026-09-24",
      opening_journal: first.opening_journal,
    });
  });

  it("running it again adds no booking, block, payment or journal money; the delta's new booking gets its own", async () => {
    const counts = async () =>
      (
        await owner.query(
          `select (select count(*) from bookings where venue_id = $1)::int as bookings,
                  (select count(*) from room_blocks where venue_id = $1)::int as blocks,
                  (select count(*) from payments where venue_id = $1)::int as payments,
                  (select count(*) from import_unplaced where venue_id = $1)::int as listed`,
          [venue.id],
        )
      ).rows[0];
    const before = await counts();
    const again = await runImport({
      pool,
      venue,
      prepared: futureExport(),
      dryRun: false,
      cutoverDate: "2026-09-24",
    });
    expect(again.kinds.bookings).toMatchObject({ loaded: 0, already: 13 });
    expect(again.deposits.held_cents).toBe(0);
    expect(again.manage_links).toEqual([]);
    expect(await counts()).toEqual(before);
    const delta = await runImport({
      pool,
      venue,
      prepared: futureExport(
        "BK-LATE,G-JAE,Room 2,4,2026-10-02 21:00,2026-10-02 23:00,$40.00,Confirmed,TERMS-1\n",
      ),
      dryRun: false,
      cutoverDate: "2026-09-25",
    });
    expect(delta.deposits).toMatchObject({ held_cents: 4000, payments_cents: 4000 });
    expect(delta.opening_journal.date).toBe("2026-09-25");
    expect(await counts()).toEqual({
      ...before,
      bookings: before!.bookings + 1,
      blocks: before!.blocks + 1,
      payments: before!.payments + 1,
    });
  });

  it("writes only its own venue", async () => {
    for (const t of ["bookings", "room_blocks", "payments", "import_unplaced", "policy_versions"]) {
      const r = await owner.query(`select count(*)::int as n from ${t} where venue_id = $1`, [
        venueB,
      ]);
      expect(r.rows[0].n, t).toBe(0);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import {
  addScanCheck,
  encryptSecret,
  idCounts,
  loadDemoSeed,
  withVenue,
  type JobRow,
} from "@west4/db";
import {
  appPool,
  copyTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { runRetention } from "../jobs/retention.js";
import { makeS3 } from "../s3.js";
import { ensureNightKey, objectStoreKeys, openScan, type IdKeyStore } from "./store.js";

/**
 * M8-14 on the demo seed's clock: a scan taken in Room 9 on Fri Sep 25 is
 * sealed with that night's key, which lives in the key store (the local
 * object store), not in the database. The nightly retention job destroys it
 * on Fri Oct 2, 7 days after the night: the scan reads before and not after,
 * Room 9 still reads "ID ✓ 12 of 12", and a copy of the database taken while
 * the key was alive (a backup restored to a scratch database) can't read the
 * scan either. Another venue's key from the same night is untouched.
 */
let db: TestDatabase;
let scratch: TestDatabase | null = null;
let raw: pg.Client;
let pool: pg.Pool;
let venueId = "";
let otherVenue = "";
let room9 = "";
let scanId = "";
let keyRef = "";
let otherRef = "";
let store: IdKeyStore;
const clock = new SimulatedClock(SEED_NOW);
const sealKey = Buffer.from("d".repeat(64), "hex");
const fields = {
  name: "Marcus Thompson",
  dateOfBirth: "1990-04-02",
  idNumber: "123456789",
  expiration: "2030-04-02",
};
const at = (iso: string) => Temporal.ZonedDateTime.from(`${iso}[America/New_York]`).toInstant();

const inVenue =
  (p: pg.Pool, venue = venueId) =>
  <T>(work: (c: pg.PoolClient) => Promise<T>) =>
    withVenue(p, { venueId: venue, requestId: "test:id-keys" }, work);
const run = (venue = venueId) =>
  runRetention(
    {
      job: { id: "test", venue_id: venue } as JobRow,
      clock,
      step: (work) => inVenue(pool, venue)(work),
    },
    { idKeys: store },
  );
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await raw.query(sql, params)).rows[0] as T;

async function connect(): Promise<void> {
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  const s3 = makeS3();
  await s3.client.send(new CreateBucketCommand({ Bucket: s3.bucketIdKeys })).catch(() => {});
  store = objectStoreKeys(s3.client, s3.bucketIdKeys, sealKey);
  await connect();

  // Room 9 (Marcus T., party of 12) has 12 visual checks; one becomes a scan taken at 10:41 PM.
  room9 = (
    await one<{ id: string }>(
      `select s.id from room_sessions s join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
        where s.venue_id = $1 and r.name = 'Room 9' and s.ended_at is null`,
      [venueId],
    )
  ).id;
  const checker = await one<{ checked_by: string }>(
    "select checked_by from id_checks where venue_id = $1 and session_id = $2 limit 1",
    [venueId, room9],
  );
  await raw.query(
    "delete from id_checks where id = (select id from id_checks where venue_id = $1 and session_id = $2 limit 1)",
    [venueId, room9],
  );
  const key = await ensureNightKey(inVenue(pool), store, sealKey, venueId, "2026-09-25");
  scanId = (
    await inVenue(pool)((c) =>
      addScanCheck(c, venueId, {
        sessionId: room9,
        sealed: encryptSecret(key.key, JSON.stringify(fields)),
        keyId: key.id,
        checkedBy: checker.checked_by,
        at: SEED_NOW.toString(),
        businessDate: "2026-09-25",
        keepDays: 7,
      }),
    )
  ).id;
  keyRef = (
    await one<{ key_ref: string }>("select key_ref from id_scan_keys where id = $1", [key.id])
  ).key_ref;

  // Another venue scanned the same night: its key is behind its own wall.
  const org = await one<{ id: string }>(
    "insert into organizations (legal_name) values ('Other ID Venue LLC') returning id",
  );
  otherVenue = (
    await one<{ id: string }>(
      "insert into venues (org_id, name, slug) values ($1, 'Other', 'other-id-keys') returning id",
      [org.id],
    )
  ).id;
  await ensureNightKey(inVenue(pool, otherVenue), store, sealKey, otherVenue, "2026-09-25");
  otherRef = (
    await one<{ key_ref: string }>(
      "select key_ref from id_scan_keys where venue_id = $1 and business_date = '2026-09-25'",
      [otherVenue],
    )
  ).key_ref;
});

afterAll(async () => {
  await raw?.end();
  await pool?.end();
  await scratch?.drop();
  await db?.drop();
});

describe("M8-14: each night's ID-scan key is destroyed 7 days after the night", () => {
  it("the key is in the key store, never in the database", async () => {
    const row = await one<{ wrapped_key: string | null; key_ref: string }>(
      "select wrapped_key, key_ref from id_scan_keys where venue_id = $1 and business_date = '2026-09-25'",
      [venueId],
    );
    expect(row.wrapped_key).toBeNull();
    expect(row.key_ref).toBe(keyRef);
    expect(await store.get(keyRef)).not.toBeNull();
  });

  it("before the job runs on Fri Oct 2, the Fri Sep 25 scan decrypts", async () => {
    expect(await openScan(inVenue(pool), store, sealKey, venueId, scanId)).toEqual(fields);
    // Thursday's run (Oct 1, 5:15 AM) is a day early: nothing is destroyed.
    clock.set(at("2026-10-01T05:15:00"));
    const thu = await run();
    expect(thu.removed["id_scan_keys"]).toBe(0);
    expect(await openScan(inVenue(pool), store, sealKey, venueId, scanId)).toEqual(fields);
  });

  it("after Friday's run the scan can't be read, the count stays and the destruction is logged", async () => {
    // The backup: a whole copy of the database while the key is still alive.
    await raw.end();
    await pool.end();
    scratch = await copyTestDatabase(db);
    await connect();

    clock.set(at("2026-10-02T05:15:00"));
    const fri = await run();
    expect(fri.skipped["id_scan_keys"]).toBeUndefined();
    expect(fri.removed["id_scan_keys"]).toBe(1);
    expect(await store.get(keyRef)).toBeNull();
    expect(await openScan(inVenue(pool), store, sealKey, venueId, scanId)).toBeNull();
    await expect(
      ensureNightKey(inVenue(pool), store, sealKey, venueId, "2026-09-25"),
    ).rejects.toThrow("destroyed");

    // Room 9 still reads "ID ✓ 12 of 12": the rows keep who checked, when and how.
    const counts = await inVenue(pool)((c) => idCounts(c, venueId, [room9]));
    expect(counts.get(room9)).toBe(12);
    const scan = await one<{ method: string; checked_by: string | null; scanned_fields: string }>(
      "select method, checked_by, scanned_fields from id_checks where id = $1",
      [scanId],
    );
    expect(scan.method).toBe("scan");
    expect(scan.checked_by).not.toBeNull();

    const key = await one<{ destroyed_at: string | null; wrapped_key: string | null }>(
      "select destroyed_at::text, wrapped_key from id_scan_keys where venue_id = $1 and business_date = '2026-09-25'",
      [venueId],
    );
    expect(key.destroyed_at).not.toBeNull();
    const audit = await one<{ changed_fields: string[]; old_values: unknown; new_values: unknown }>(
      `select changed_fields, old_values, new_values from audit_log
        where venue_id = $1 and action = 'id_scan_keys.update' order by id desc limit 1`,
      [venueId],
    );
    expect(audit.changed_fields).toContain("destroyed_at");
    expect(JSON.stringify(audit.new_values ?? {})).not.toContain(keyRef);
    const log = await one<{ removed: Record<string, number> }>(
      "select removed from retention_runs where venue_id = $1 order by ran_at desc limit 1",
      [venueId],
    );
    expect(log.removed["id_scan_keys"]).toBe(1);

    // A rerun destroys nothing new.
    expect((await run()).removed["id_scan_keys"]).toBe(0);
  });

  it("the backup restored to a scratch copy can't read that night's scan either", async () => {
    const copy = appPool(scratch!.url);
    try {
      const inCopy = await withVenue(
        copy,
        { venueId },
        async (c) =>
          (
            await c.query<{ wrapped_key: string | null; destroyed_at: string | null }>(
              "select wrapped_key, destroyed_at::text from id_scan_keys where business_date = '2026-09-25'",
            )
          ).rows[0],
      );
      expect(inCopy?.destroyed_at).toBeNull(); // the copy still thinks the key is alive
      expect(inCopy?.wrapped_key).toBeNull(); // but it never held the key
      expect(await openScan(inVenue(copy), store, sealKey, venueId, scanId)).toBeNull();
    } finally {
      await copy.end();
    }
  });

  it("another venue's key from the same night is untouched by West 4's run", async () => {
    expect(await store.get(otherRef)).not.toBeNull();
    const other = await one<{ destroyed_at: string | null }>(
      "select destroyed_at from id_scan_keys where venue_id = $1",
      [otherVenue],
    );
    expect(other.destroyed_at).toBeNull();
  });
});

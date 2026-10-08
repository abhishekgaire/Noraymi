import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LOCAL_DEV_AUTH_KEY,
  loadDemoSeed,
  parseAuthSecretKey,
  pinVerifier,
  readSeedFile,
  withVenue,
} from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { DEMO_PINS, pinEvidence, pinReport } from "./pins-check.js";

/**
 * M9-08: the production PIN check. On the demo seed every PIN is a demo PIN written by the
 * seed, so it fails naming everyone; a PIN each person sets on their own invite passes.
 */
let db: TestDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let venueId: string;
const pepper = parseAuthSecretKey(process.env["AUTH_SECRET_KEY"] ?? LOCAL_DEV_AUTH_KEY);

const check = () =>
  withVenue(pool, { venueId, requestId: "test" }, (c) => pinEvidence(c, venueId, pepper));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  pool = new pg.Pool({ connectionString: db.url, max: 2 });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("the production PIN check (M9-08)", () => {
  it("knows exactly the seed's demo PINs", () => {
    const seeded = readSeedFile()
      .team.map((p) => (p as { demo_pin?: string }).demo_pin)
      .filter(Boolean)
      .sort();
    expect([...DEMO_PINS].sort()).toEqual(seeded);
  });

  it("fails on the demo seed: every PIN is a demo PIN the seed wrote, never its person", async () => {
    const e = await check();
    expect(e.ok).toBe(false);
    expect(e.checked).toBe(4);
    expect(e.findings.filter((f) => f.why === "demo_pin")).toHaveLength(4);
    expect(e.findings.filter((f) => f.why === "not_set_by_self")).toHaveLength(4);
    const report = pinReport("west4karaoke", e);
    // Names people, never a PIN.
    for (const pin of DEMO_PINS) expect(report).not.toContain(pin);
    expect(report).toContain("a demo PIN from the seed verifies: send a PIN reset");
  });

  it("passes once each person has set a new PIN of their own, and catches one set by someone else", async () => {
    const people = await owner.query<{ id: string; user_id: string; pin_digits: number }>(
      "select id, user_id, pin_digits from memberships where venue_id = $1 and pin_verifier is not null",
      [venueId],
    );
    const ownerUser = (
      await owner.query<{ user_id: string }>(
        "select user_id from memberships where venue_id = $1 and role = 'owner'",
        [venueId],
      )
    ).rows[0]!.user_id;
    for (const p of people.rows) {
      // A reset clears the PIN (as the owner); the person's own Set your PIN writes the new one.
      await withVenue(pool, { venueId, userId: ownerUser, requestId: "test" }, (c) =>
        c.query("update memberships set pin_verifier = null where id = $1", [p.id]),
      );
      const pin = p.pin_digits === 6 ? "482913" : "5827";
      const verifier = await pinVerifier(pepper, venueId, p.id, pin);
      await withVenue(pool, { venueId, userId: p.user_id, requestId: "test" }, (c) =>
        c.query("update memberships set pin_verifier = $2 where id = $1", [p.id, verifier]),
      );
    }
    const passed = await check();
    expect(passed.findings).toEqual([]);
    expect(pinReport("west4karaoke", passed)).toContain(
      "No demo PIN verifies for anyone, and every PIN was set by its own person.",
    );

    // A PIN written by anyone but its person (here the owner, for someone else) fails.
    const other = people.rows.find((p) => p.user_id !== ownerUser)!;
    const v = await pinVerifier(
      pepper,
      venueId,
      other.id,
      other.pin_digits === 6 ? "482913" : "5827",
    );
    await withVenue(pool, { venueId, userId: ownerUser, requestId: "test" }, (c) =>
      c.query("update memberships set pin_verifier = $2 where id = $1", [other.id, v]),
    );
    const caught = await check();
    expect(caught.findings).toEqual([
      expect.objectContaining({
        why: "not_set_by_self",
        detail: "someone other than this person set the PIN: send a PIN reset",
      }),
    ]);
  });
});

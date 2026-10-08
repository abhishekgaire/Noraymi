import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { Temporal } from "@west4/shared";
import {
  applyShift,
  checkCoverage,
  gateWindows,
  rotaFileSchema,
  type RotaFile,
} from "./oncall-coverage.js";
import { readRota } from "./paging.js";

/**
 * The gate's on-call rota (M9-16) against West 4's own hours on the demo seed: a rota that covers
 * every opening hour through each night's close passes; a missing hour, a missing second responder
 * or someone who isn't our staff fails; the committed rota is still empty and fails; the shift on
 * now goes into the pager's two slots.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let venueId: string;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
  await owner.query(
    `insert into console_staff (name, email) values ('Ana', 'ana@oncall.test'), ('Ben', 'ben@oncall.test'),
       ('Cy', 'cy@oncall.test'), ('Dee', 'dee@oncall.test')`,
  );
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await db.drop();
});

/** One shift per night from its opening to the cutover, alternating two pairs. */
async function fullRota(startsOn: string): Promise<RotaFile> {
  const windows = await withVenue(app, { venueId }, (c) => gateWindows(c, venueId, startsOn, 4));
  const wall = (i: Temporal.Instant) =>
    i.toZonedDateTimeISO("America/New_York").toPlainDateTime().toString().slice(0, 16);
  return {
    venue: "west4karaoke",
    starts_on: startsOn,
    weeks: 4,
    shifts: windows.map((w, i) => ({
      from: wall(w.from),
      to: wall(w.to),
      first: i % 2 ? "cy@oncall.test" : "ana@oncall.test",
      second: i % 2 ? "dee@oncall.test" : "ben@oncall.test",
      first_phone: null,
      second_phone: null,
    })),
  };
}

describe("the gate's on-call rota (M9-16)", () => {
  it("West 4's nights run from its opening (4 PM weekdays, 2 PM weekends) to the 6 AM cutover", async () => {
    const w = await withVenue(app, { venueId }, (c) => gateWindows(c, venueId, "2026-10-12", 4));
    expect(w).toHaveLength(28);
    const local = (i: Temporal.Instant) =>
      i.toZonedDateTimeISO("America/New_York").toPlainTime().toString();
    expect(local(w[0]!.from)).toBe("16:00:00"); // Monday
    expect(local(w[5]!.from)).toBe("14:00:00"); // Saturday
    expect(local(w[0]!.to)).toBe("06:00:00");
  });

  it("a rota covering every opening hour with two people per shift passes", async () => {
    const r = await checkCoverage(owner, venueId, await fullRota("2026-10-12"));
    expect(r).toMatchObject({ ok: true, nights: 28, gaps: [], unknown: [], problems: [] });
  });

  it("a missing hour, a missing second responder and someone not on our staff each fail", async () => {
    const rota = await fullRota("2026-10-12");
    const shifts = [...rota.shifts];
    shifts[3] = { ...shifts[3]!, from: shifts[3]!.from.replace(/T\d\d:\d\d$/, "T17:00") };
    shifts[4] = { ...shifts[4]!, second: shifts[4]!.first };
    shifts[5] = { ...shifts[5]!, second: "stranger@else.test" };
    const r = await checkCoverage(owner, venueId, { ...rota, shifts });
    expect(r.ok).toBe(false);
    expect(r.gaps.map((g) => [g.businessDate, g.why])).toEqual([
      ["2026-10-15", "uncovered"],
      ["2026-10-16", "same_person"],
    ]);
    expect(r.unknown).toEqual(["stranger@else.test"]);
  });

  it("the committed rota is still empty, so the check fails until the founder fills it", async () => {
    const file = rotaFileSchema.parse(
      JSON.parse(readFileSync(join(ROOT, "docs/gate/oncall-rota.json"), "utf8")),
    );
    const r = await checkCoverage(owner, venueId, file);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/starts_on is empty/);
  });

  it("at a handover, the shift on now goes into the pager's first and second slots", async () => {
    const rota = await fullRota("2026-10-12");
    const tuesday = Temporal.Instant.from("2026-10-13T23:00:00Z"); // 7 PM on the second night
    const set = await applyShift(owner, rota, "America/New_York", tuesday, "test");
    expect(set?.map((r) => r.email)).toEqual(["cy@oncall.test", "dee@oncall.test"]);
    expect((await readRota(owner)).map((r) => [r.slot, r.email])).toEqual([
      ["first", "cy@oncall.test"],
      ["second", "dee@oncall.test"],
    ]);
  });
});

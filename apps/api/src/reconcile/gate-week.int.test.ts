import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { Temporal } from "@west4/shared";
import { gateCount, sendGateWeek } from "./gate-week.js";

/**
 * The gate's count and weekly summary (M9-17) from money_audits, as West 4's rows: nothing before a
 * live night; Mondays only; an error night (even one a rerun found clean) restarts the run.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let venueId: string;
const allowAll = { allowList: null };
const monday = Temporal.Instant.from("2026-11-16T13:30:00Z"); // Mon Nov 16, 8:30 AM in New York

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await db.drop();
});

const audit = (night: string, ok: boolean, trigger = "morning") =>
  owner.query(
    `insert into money_audits (venue_id, night, ran_at, trigger, ok, covered)
     values ($1, $2::date, now(), $3, $4, '{}')`,
    [venueId, night, trigger, ok],
  );
const mails = async () =>
  (
    await owner.query<{ to: string; data: Record<string, unknown> }>(
      `select payload ->> 'to' as to, payload -> 'data' as data from jobs
        where kind = 'email.send' and payload ->> 'template' = 'gate_week' order by created_at`,
    )
  ).rows;

describe("the gate's weekly summary (M9-17)", () => {
  it("before any live night, it sends nothing", async () => {
    const r = await withVenue(app, { venueId }, (c) =>
      sendGateWeek(c, venueId, monday, allowAll, ["founder@example.test"]),
    );
    expect(r).toEqual({ sent: 0, streak: null });
  });

  it("on a Monday it sends the run to the owner and the founder; on other days nothing", async () => {
    for (let d = 2; d <= 15; d++) await audit(`2026-11-${String(d).padStart(2, "0")}`, true);
    const tuesday = monday.add({ hours: 24 });
    expect(
      (await withVenue(app, { venueId }, (c) => sendGateWeek(c, venueId, tuesday, allowAll, [])))
        .sent,
    ).toBe(0);
    const r = await withVenue(app, { venueId }, (c) =>
      sendGateWeek(c, venueId, monday, allowAll, ["founder@example.test"]),
    );
    expect(r.streak).toMatchObject({
      cleanNights: 14,
      runStartedOn: "2026-11-02",
      daysToGo: 14,
      met: false,
    });
    const sent = await mails();
    expect(sent.map((m) => m.to)).toContain("founder@example.test");
    expect(sent.length).toBe(r.sent);
    expect(sent[0]!.data).toMatchObject({
      weekEnding: "2026-11-15",
      cleanNights: 14,
      errorsThisWeek: 0,
    });
  });

  it("an error night counts as one even after a clean rerun, and starts the 4 weeks again", async () => {
    await audit("2026-11-16", false);
    await audit("2026-11-16", true, "manual");
    await audit("2026-11-17", true);
    const streak = await withVenue(app, { venueId }, (c) => gateCount(c, venueId));
    expect(streak).toMatchObject({
      lastErrorOn: "2026-11-16",
      runStartedOn: "2026-11-17",
      cleanNights: 1,
      daysToGo: 27,
    });
  });
});

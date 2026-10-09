import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { sweepHolds } from "../jobs/hold-sweep.js";

/** Online booking, the Pick step (M5-07): availability, the quote, the 10-minute hold, More time, the lapse. */
let db: TestDatabase;
let owner: pg.Pool;
let pool: pg.Pool;
let api: FastifyInstance;
const clock = new SimulatedClock(SEED_NOW);
const availability = (q: string) =>
  api.inject({ method: "GET", url: `/v1/public/venues/west4karaoke/availability?${q}` });
const hold = (payload: object) =>
  api.inject({ method: "POST", url: "/v1/public/venues/west4karaoke/bookings", payload });
// The next Friday: tonight (Sep 25) every small room is taken from 11 PM, so a hold would get a medium one.
const jae = { business_date: "2026-10-02", time: "23:00", hours: 2, party_size: 5 };

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } });
  owner = new pg.Pool({ connectionString: db.url });
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  pool = appPool(db.url);
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("availability and the quote", () => {
  it("Jae & co. (5, Fri Sep 25, 11:00 PM, 2 hours): $100.00, $8.88 tax, $20.00 gratuity, $128.88, $50.00 deposit", async () => {
    const r = await availability("date=2026-09-25&guests=5&hours=2");
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    // Tonight the small rooms are all booked from 11 PM: the smallest free room that fits is medium.
    expect(a.slots.find((s: { time: string }) => s.time === "23:00")).toMatchObject({
      free: true,
      size_tier: "medium",
    });
    // Tonight starts from the venue's clock: nothing before 10:41 PM.
    expect(a.slots[0].time).toBe("23:00");
    expect(a.quote).toMatchObject({
      room_time_cents: 10000,
      tax_cents: 888,
      gratuity_cents: 2000,
      total_cents: 12888,
      deposit_cents: 5000,
    });
  });

  it("a party of 3 on a Friday bills as 4 and pays $40.00; 25 go to the enquiry form", async () => {
    const a = (await availability("date=2026-09-25&guests=3&hours=1")).json();
    expect(a).toMatchObject({ min_guests: 4, billable_guests: 4 });
    expect(a.quote.deposit_cents).toBe(4000);
    expect((await availability("date=2026-09-25&guests=25&hours=2")).json()).toMatchObject({
      too_big: true,
      slots: [],
    });
  });

  it("Nov 1, 2026 shows 1:00 AM EDT and 1:00 AM EST; Mar 14, 2027 has no 2:30 AM", async () => {
    const fall = (await availability("date=2026-10-31&guests=4&hours=1")).json();
    expect(
      fall.slots
        .filter((s: { time: string }) => s.time === "01:00")
        .map((s: { zone: string }) => s.zone),
    ).toEqual(["EDT", "EST"]);
    const spring = (await availability("date=2027-03-13&guests=4&hours=1")).json();
    expect(spring.slots.map((s: { time: string }) => s.time)).not.toContain("02:30");
    const refused = await hold({
      business_date: "2027-03-13",
      time: "02:30",
      hours: 1,
      party_size: 4,
    });
    expect(refused.json().error.details).toEqual({ reason: "does_not_exist" });
  });
});

describe("the hold", () => {
  let token = "";

  it("picking the slot holds a small room for 10 minutes with the exact quote", async () => {
    const r = await hold(jae);
    expect(r.statusCode, r.body).toBe(201);
    token = r.json().token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(r.json().booking).toMatchObject({
      status: "pending",
      size_tier: "small",
      seconds_left: 600,
      more_time_left: 10,
      quote: { total_cents: 12888, deposit_cents: 5000 },
    });
    const block = await owner.query(
      `select b.kind, abs(extract(epoch from b.expires_at - $1::timestamptz)) < 5 as lapses_in_10 from room_blocks b
        join bookings k on k.id = b.ref_id where k.manage_token_hash is not null and k.source = 'web'`,
      [SEED_NOW.add({ minutes: 10 }).toString()],
    );
    expect(block.rows).toEqual([{ kind: "hold", lapses_in_10: true }]);
    const view = await api.inject({ method: "GET", url: `/v1/public/bookings/${token}/hold` });
    expect(view.headers["referrer-policy"]).toBe("no-referrer");
    expect(view.headers["cache-control"]).toBe("no-store");
  });

  it("no two guests hold one room for an overlapping time: parallel holds each get their own room", async () => {
    const tries = await Promise.all(
      Array.from({ length: 14 }, () => hold({ ...jae, party_size: 6 })),
    );
    const won = tries.filter((t) => t.statusCode === 201).length;
    expect(won).toBeGreaterThan(0);
    for (const t of tries.filter((x) => x.statusCode !== 201))
      expect(t.json().error, t.body).toMatchObject({ details: { reason: "no_room" } });
    const overlap = await owner.query(`
      select count(*)::int as n from room_blocks a join room_blocks b
        on a.room_id = b.room_id and a.id < b.id and a.period && b.period`);
    expect(overlap.rows[0].n).toBe(0);
  });

  it("More time adds 10 minutes, ten times; the eleventh is refused", async () => {
    const more = () =>
      api.inject({ method: "POST", url: `/v1/public/bookings/${token}/more-time` });
    clock.set(SEED_NOW.add({ minutes: 9 }));
    const first = await more();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ seconds_left: 600, more_time_left: 9 });
    for (let i = 0; i < 9; i++) expect((await more()).statusCode).toBe(200);
    const eleventh = await more();
    expect(eleventh.statusCode).toBe(400);
    expect(eleventh.json().error.details).toEqual({ reason: "hold_over" });
  });

  it("a lapsed hold frees the room within a minute and the booking is cancelled", async () => {
    clock.set(SEED_NOW.add({ minutes: 9 + 11 }));
    await sweepHolds(pool, clock.now());
    const view = (
      await api.inject({ method: "GET", url: `/v1/public/bookings/${token}/hold` })
    ).json();
    expect(view.status).toBe("cancelled");
    const left = await owner.query("select count(*)::int as n from room_blocks where ref_id = $1", [
      view.id,
    ]);
    expect(left.rows[0].n).toBe(0);
  });

  it("is off with Online booking & deposits: 404 module_off, and a hold already made goes no further", async () => {
    const token = (await hold(jae)).json().token as string;
    const more = () =>
      api.inject({ method: "POST", url: `/v1/public/bookings/${token}/more-time` });
    const details = () =>
      api.inject({
        method: "POST",
        url: `/v1/public/bookings/${token}/details`,
        payload: { name: "Jae", phone: "+12125550188", email: "jae@example.com", marketing: false },
      });
    for (const state of ["off", "stopping"]) {
      await owner.query("update venue_modules set state = $1 where module_id = 'online_booking'", [
        state,
      ]);
      for (const r of [
        await availability("date=2026-09-25&guests=5&hours=2"),
        await hold(jae),
        await more(),
        await details(),
      ]) {
        expect(r.statusCode).toBe(404);
        expect(r.json().error.code).toBe("module_off");
      }
    }
    await owner.query("update venue_modules set state = 'on' where module_id = 'online_booking'");
    expect((await more()).statusCode).toBe(200);
  });
});

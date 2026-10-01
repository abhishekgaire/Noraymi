import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { Worker, addBlock, loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { TEXT_TRIGGER_KIND, makeTextTriggerHandler, sweepTextTriggers } from "./triggers.js";

/** M2-24 acceptance: the automatic texts on their triggers, on the simulated clock. */
const MARCUS = "+19175550187";
const DANA = "+16465550122";
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const at = (hhmm: string, day = "2026-09-25") => Temporal.Instant.from(`${day}T${hhmm}:00-04:00`);
const run = async (now: Temporal.Instant) => {
  clock.set(now);
  const planned = await sweepTextTriggers(pool, now);
  const worker = new Worker(pool, {
    pool: "normal",
    clock,
    handlers: { [TEXT_TRIGGER_KIND]: makeTextTriggerHandler({ allowList: null }) },
  });
  while ((await worker.tick()) > 0);
  return planned.flatMap((p) => p.keys);
};
const textsTo = async (phone: string) =>
  (
    await raw.query<{ body: string; key: string | null }>(
      `select m.body, t.key from messages m join conversations cv on cv.id = m.conversation_id
         left join message_templates t on t.id = m.template_id
        where cv.phone_e164 = $1 and m.direction = 'outbound' and m.created_at > now() - interval '1 hour'
        order by m.created_at`,
      [phone],
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
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
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => diego],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("the automatic texts on their triggers", () => {
  it("at 10:50 PM Marcus T. gets Booked time ending, once", async () => {
    expect(await run(at("22:49"))).not.toContain(
      `text:wrap:${ids["sess_room9"]}:${at("23:00").epochMilliseconds}`,
    );
    expect(await textsTo(MARCUS)).toEqual([]);
    await run(at("22:50"));
    await run(at("22:51"));
    expect(await textsTo(MARCUS)).toEqual([
      {
        key: "booked_time_ending",
        body: "Your booked time in Room 9 ends at 11:00 PM. Nobody's booked after you, so you can stay on by the minute until we close at 4 AM.",
      },
    ]);
  });

  it("with a booking in Room 1 at 11:30 PM, Dana K. gets Please wrap up at 11:20 PM instead", async () => {
    await withVenue(pool, { venueId }, (c) =>
      addBlock(c, {
        venueId,
        roomId: ids["room_1"]!,
        kind: "booking",
        from: at("23:30"),
        to: at("00:30", "2026-09-26"),
      }),
    );
    await run(at("23:19"));
    expect(await textsTo(DANA)).toEqual([]);
    await run(at("23:20"));
    expect(await textsTo(DANA)).toEqual([
      {
        key: "please_wrap_up",
        body: "10 minutes left in Room 1. The next party is here, so please start wrapping up. Thank you!",
      },
    ]);
  });

  it("while messages.reminderAt is empty no Reminder goes out; once it's set, each confirmed booking gets one", async () => {
    await run(at("23:21"));
    expect(
      (await raw.query("select 1 from jobs where dedupe_key like 'text:reminder:%'")).rowCount,
    ).toBe(0);
    await raw.query(
      "update venue_settings set value = jsonb_set(value, '{reminderAt}', '\"16:00\"') where venue_id = $1 and key = 'messages'",
      [venueId],
    );
    // At 4 PM, before tonight's bookings start: one Reminder each, and never a second.
    const keys = await run(at("16:00"));
    expect(keys).toContain(`text:reminder:${ids["bk_parks"]}`);
    expect((await run(at("16:01"))).filter((k) => k.startsWith("text:reminder:"))).toEqual([]);
  });

  it("a text switched off in Admin → Texts isn't sent", async () => {
    await raw.query(
      "update message_templates set \"on\" = false where venue_id = $1 and key = 'booked_time_ending'",
      [venueId],
    );
    // Room 10 (Tanya, nothing booked next) ends at 10:45 PM tomorrow-style: move its end into the window.
    await raw.query("update room_sessions set booked_end_at = $2 where id = $1", [
      ids["sess_room10"],
      at("23:35").toString(),
    ]);
    const keys = await run(at("23:26"));
    expect(keys).toContain(`text:wrap:${ids["sess_room10"]}:${at("23:35").epochMilliseconds}`);
    const tanya = await raw.query<{ phone: string }>(
      `select g.phone_e164 as phone from room_sessions s join bookings b on b.id = s.booking_id
         join guests g on g.id = b.guest_id where s.id = $1`,
      [ids["sess_room10"]],
    );
    expect(await textsTo(tanya.rows[0]!.phone)).toEqual([]);
  });

  it("the board's button sends Please wrap up by hand", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/sessions/${ids["sess_room7"]}/wrap-up-text`,
    });
    expect(r.statusCode, r.body).toBe(201);
    const body = await raw.query<{ body: string }>("select body from messages where id = $1", [
      r.json<{ message_id: string }>().message_id,
    ]);
    expect(body.rows[0]!.body).toBe(
      "10 minutes left in Room 7. The next party is here, so please start wrapping up. Thank you!",
    );
  });
});

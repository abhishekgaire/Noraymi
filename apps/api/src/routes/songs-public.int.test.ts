import pg from "pg";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

/**
 * The singer's queue page routes (M6-20): Ben T. signs in again on his confirmed number and reads
 * "2 singers before you"; Sofia R.'s song needs a drink credit; a new singer joins with a code and
 * queues "Valerie" typed by hand with no songbook; a wrong code is counted; no answer carries a phone
 * number; the token is stored only hashed and reaches nobody else's songs or another venue.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
const clock = new SimulatedClock(SEED_NOW);
const base = "/v1/public/venues/west4karaoke";

const codeFor = async (phone: string) =>
  (
    await owner.query<{ code: string }>(
      `select payload->'data'->>'code' as code from jobs where kind = 'text.send'
         and payload->>'to' = $1 order by created_at desc limit 1`,
      [phone],
    )
  ).rows[0]!.code;

/** Joins (or signs in) with a code; answers the singer cookie. */
async function signIn(name: string, phone: string): Promise<string> {
  const asked = await api.inject({
    method: "POST",
    url: `${base}/singers`,
    payload: { display_name: name, phone_e164: phone },
  });
  expect(asked.statusCode, asked.body).toBe(202);
  const ok = await api.inject({
    method: "POST",
    url: `${base}/singers/verify`,
    payload: { phone_e164: phone, code: await codeFor(phone) },
  });
  expect(ok.statusCode, ok.body).toBe(200);
  const cookie = String(ok.headers["set-cookie"]);
  expect(cookie).toMatch(/^west4_singer=[A-Za-z0-9_-]{22}; Path=\/; HttpOnly; SameSite=Lax/);
  return cookie.split(";")[0]!;
}
type Page = {
  open: boolean;
  singing: { singer: string; title: string } | null;
  up_next: { place: number; singer: string }[];
  me: {
    display_name: string;
    credits: number;
    singers_before: number | null;
    songs: { title: string; flag: string | null; status: string }[];
  } | null;
};
const page = async (cookie?: string) => {
  const r = await api.inject({
    method: "GET",
    url: `${base}/queue`,
    ...(cookie ? { headers: { cookie } } : {}),
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.body).not.toMatch(/\+1\d{10}|phone/);
  return r.json() as Page;
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    eventsPollMs: 200,
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("the queue page", () => {
  it("shows anyone who's singing and the next names, with no phone number and no singer of their own", async () => {
    const q = await page();
    expect(q.open).toBe(true);
    expect(q.singing).toMatchObject({ singer: "Luis M.", title: "Mr. Brightside" });
    expect(q.up_next.map((s) => s.singer)).toEqual([
      "Jess P.",
      "Kira",
      "Ben T.",
      "Tariq A.",
      "Hana K.",
    ]);
    expect(q.me).toBeNull();
  });

  it("signs Ben T. in again on his confirmed number: 2 singers before you, one credit, no second singer", async () => {
    const before = await owner.query("select count(*)::int as n from singers");
    const cookie = await signIn("Ben", "+16465550163");
    const q = await page(cookie);
    expect(q.me).toMatchObject({ display_name: "Ben T.", credits: 1, singers_before: 2 });
    expect(q.me!.songs).toEqual([
      expect.objectContaining({ title: "Livin' on a Prayer", status: "queued", flag: null }),
    ]);
    const after = await owner.query("select count(*)::int as n from singers");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    // Only the token's hash is stored.
    const stored = await owner.query<{ token_hash: string }>(
      "select token_hash from singers where phone_e164 = '+16465550163'",
    );
    expect(stored.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).not.toContain(stored.rows[0]!.token_hash);
  });

  it("shows Sofia R.'s song as needing a drink credit", async () => {
    const q = await page(await signIn("Sofia R.", "+13475550195"));
    expect(q.me).toMatchObject({ credits: 0, singers_before: 5 });
    expect(q.me!.songs[0]).toMatchObject({
      title: "Bohemian Rhapsody",
      flag: "needs_drink_credit",
    });
  });

  it("joins a new singer with a code, counting a wrong one, and queues Valerie typed by hand", async () => {
    const phone = "+16465550177";
    const asked = await api.inject({
      method: "POST",
      url: `${base}/singers`,
      payload: { display_name: "Priya", phone_e164: phone, locale: "es" },
    });
    expect(asked.statusCode, asked.body).toBe(202);
    const code = await codeFor(phone);
    const wrong = await api.inject({
      method: "POST",
      url: `${base}/singers/verify`,
      payload: { phone_e164: phone, code: code === "000000" ? "111111" : "000000" },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.details).toMatchObject({ reason: "wrong_code", tries_left: 4 });
    const ok = await api.inject({
      method: "POST",
      url: `${base}/singers/verify`,
      payload: { phone_e164: phone, code },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const cookie = String(ok.headers["set-cookie"]).split(";")[0]!;
    const songs = await api.inject({ method: "GET", url: `${base}/songs?q=valerie` });
    expect(songs.json()).toMatchObject({ catalog: false, songs: [] });
    const queued = await api.inject({
      method: "POST",
      url: `${base}/queue`,
      headers: { cookie },
      payload: { title: "Valerie", artist: "Amy Winehouse" },
    });
    expect(queued.statusCode, queued.body).toBe(201);
    expect(queued.json()).toMatchObject({ round: 3, flag: "needs_drink_credit" });
    const q = await page(cookie);
    expect(q.me).toMatchObject({ display_name: "Priya", credits: 0, singers_before: 6 });
    expect(q.me!.songs.map((s) => s.title)).toEqual(["Valerie"]);
    const events = await owner.query(
      "select 1 from venue_events where type = 'song_queue.updated' and venue_id = $1",
      [venueId],
    );
    expect(events.rowCount).toBeGreaterThan(0);
  });

  it("follows song_queue.updated on the live channel with the singer cookie, and a made-up cookie is refused", async () => {
    const url = (await api.listen({ port: 0, host: "127.0.0.1" })).replace("http", "ws");
    const cookie = await signIn("Ben", "+16465550163");
    const ws = new WebSocket(`${url}/v1/venues/${venueId}/events`, { headers: { cookie } });
    const frames: string[] = [];
    ws.on("message", (d) => frames.push(String(d)));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const kira = await signIn("Kira", "+19295550152");
    await api.inject({
      method: "POST",
      url: `${base}/queue`,
      headers: { cookie: kira },
      payload: { title: "Rehab" },
    });
    await expect
      .poll(() => frames.some((f) => f.includes("song_queue.updated")), { timeout: 5000 })
      .toBe(true);
    expect(frames.join("")).not.toMatch(/\+1\d{10}/);
    ws.close();
    const bad = new WebSocket(`${url}/v1/venues/${venueId}/events`, {
      headers: { cookie: "west4_singer=AAAAAAAAAAAAAAAAAAAAAA" },
    });
    const code = await new Promise<number>((resolve) => bad.once("close", (c) => resolve(c)));
    expect(code).toBe(4403);
  });

  it("refuses queuing without a singer cookie, or with a made-up one", async () => {
    for (const headers of [{}, { cookie: "west4_singer=AAAAAAAAAAAAAAAAAAAAAA" }]) {
      const r = await api.inject({
        method: "POST",
        url: `${base}/queue`,
        headers,
        payload: { title: "Jolene" },
      });
      expect(r.statusCode).toBe(403);
    }
  });

  it("closes joining and queuing while bar mode is off", async () => {
    await owner.query(
      "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'bar_mode'",
      [venueId],
    );
    try {
      const r = await api.inject({
        method: "POST",
        url: `${base}/singers`,
        payload: { display_name: "Late", phone_e164: "+16465550178" },
      });
      expect(r.statusCode).toBe(404);
      expect((await api.inject({ method: "GET", url: `${base}/queue` })).statusCode).toBe(404);
    } finally {
      await owner.query(
        "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'bar_mode'",
        [venueId],
      );
    }
  });
});

import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  makeDeviceKey,
  newYorkCounty,
  newYorkCountyTaxed,
  signDeviceRequest,
  signDeviceSocketPath,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * The Up next TV (M6-22; Devices, printing and offline · Up next display; Tenancy and access · Up
 * next display): a paired `up_next_display` reads Luis M. singing, the next five and the venue's slug
 * for the join QR code; its live channel, opened with a signed socket URL, carries only
 * `song_queue.updated`; Maya's Started reaches it at once; and no answer or frame on it carries a
 * phone number.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let base: string;
let venueId: string;
let ids: Record<string, string>;
let phones: string[];
let who: Principal | undefined;
let n = 0;
let tv: { deviceId: string; privateKey: CryptoKey };
const clock = new SimulatedClock(SEED_NOW);

const maya = (): Principal => ({
  kind: "user",
  userId: ids["maya"]!,
  session: "pin",
  memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" } as never],
});

/** Every phone number in any shape the seed holds it: +1…, the ten digits, or 555-01xx. */
const carriesPhone = (text: string) =>
  phones.some((p) => {
    const ten = p.replace(/^\+1/, "");
    return (
      text.includes(p) || text.includes(ten) || text.includes(`${ten.slice(3, 6)}-${ten.slice(6)}`)
    );
  }) || /\+\d{8,15}/.test(text);

const signed = async (path: string) =>
  api.inject({
    method: "GET",
    url: path,
    headers: await signDeviceRequest({ ...tv, method: "GET", path }),
  });

async function pairTv(): Promise<void> {
  const code = randomBytes(4).toString("hex").toUpperCase();
  await owner.query(
    `insert into device_pairing_codes (venue_id, code_hash, kind, name, expires_at)
     values ($1, $2, 'up_next_display', 'Up next TV', now() + interval '1 hour')`,
    [venueId, createHash("sha256").update(code).digest("hex")],
  );
  const key = await makeDeviceKey();
  const claimed = await api.inject({
    method: "POST",
    url: "/v1/devices/claim",
    payload: { code, public_key: key.publicJwk },
  });
  expect(claimed.statusCode, claimed.body).toBe(201);
  expect(claimed.json().kind).toBe("up_next_display");
  tv = { deviceId: claimed.json().device_id, privateKey: key.privateKey };
}

interface Socket {
  ws: WebSocket;
  frames: string[];
  until: (pred: (f: Record<string, unknown>) => boolean, ms: number) => Promise<void>;
}

async function openSocket(path: string): Promise<Socket> {
  const ws = new WebSocket(`${base}${path}`);
  const frames: string[] = [];
  ws.on("message", (d) => frames.push(String(d)));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  const until = async (pred: (f: Record<string, unknown>) => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (frames.some((f) => pred(JSON.parse(f) as Record<string, unknown>))) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no such frame within ${ms} ms: ${frames.join(" ")}`);
  };
  return { ws, frames, until };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
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
  phones = (
    await owner.query<{ phone_e164: string }>(
      "select phone_e164 from singers where venue_id = $1 and phone_e164 is not null",
      [venueId],
    )
  ).rows.map((r) => r.phone_e164);
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    eventsPollMs: 100,
    authenticators: [async () => who],
  });
  base = (await api.listen({ port: 0, host: "127.0.0.1" })).replace("http", "ws");
  await pairTv();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("the Up next TV", () => {
  it("shows Luis M. singing, the next five and the slug for the join QR code, and no phone number", async () => {
    expect(phones.length).toBeGreaterThanOrEqual(7);
    const r = await signed(`/v1/venues/${venueId}/up-next`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as {
      slug: string;
      open: boolean;
      singing: { singer: string; title: string } | null;
      up_next: { place: number; singer: string }[];
    };
    expect(body.singing).toMatchObject({ singer: "Luis M.", title: "Mr. Brightside" });
    expect(body.up_next.map((s) => s.singer)).toEqual([
      "Jess P.",
      "Kira",
      "Ben T.",
      "Tariq A.",
      "Hana K.",
    ]);
    expect(body.slug).toBe("west4karaoke");
    expect(body.open).toBe(true);
    expect(carriesPhone(r.body)).toBe(false);
    // Names and the song only: no credits, flags, tabs or singer ids.
    expect(r.body).not.toMatch(/credit|flag|tab|singer_id/);
  });

  it("shows barMode.upNextCount singers", async () => {
    const setting = await owner.query<{ value: Record<string, unknown> }>(
      "select value from venue_settings where venue_id = $1 and key = 'barMode' order by version desc limit 1",
      [venueId],
    );
    expect(setting.rows[0]!.value["upNextCount"]).toBe(5);
    await owner.query(
      "update venue_settings set value = jsonb_set(value, '{upNextCount}', '3') where venue_id = $1 and key = 'barMode'",
      [venueId],
    );
    try {
      const r = await signed(`/v1/venues/${venueId}/up-next`);
      expect((r.json() as { up_next: unknown[] }).up_next).toHaveLength(3);
    } finally {
      await owner.query(
        "update venue_settings set value = jsonb_set(value, '{upNextCount}', '5') where venue_id = $1 and key = 'barMode'",
        [venueId],
      );
    }
  });

  it("is the TV's alone: staff and an unsigned caller are refused", async () => {
    who = maya();
    const staff = await api.inject({ method: "GET", url: `/v1/venues/${venueId}/up-next` });
    who = undefined;
    expect(staff.statusCode).toBe(403);
    const nobody = await api.inject({ method: "GET", url: `/v1/venues/${venueId}/up-next` });
    expect(nobody.statusCode).toBe(403);
  });

  it("its channel carries only song_queue.updated, Started reaches it within 3 seconds, and no frame carries a phone number", async () => {
    who = undefined;
    const path = await signDeviceSocketPath({ ...tv, path: `/v1/venues/${venueId}/events` });
    const socket = await openSocket(path);
    await socket.until((f) => f["type"] === "hello", 2000);
    // A signed socket URL works once: its nonce is spent.
    await expect(openSocket(path)).rejects.toThrow(/403/);

    who = maya();
    const startedAt = Date.now();
    const r = await api.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/song-queue/${ids["song_sg_jess"]}/start`,
      headers: { "idempotency-key": `up-next-${++n}` },
    });
    who = undefined;
    expect(r.statusCode, r.body).toBe(200);
    await socket.until((f) => f["type"] === "song_queue.updated", 3000);
    expect(Date.now() - startedAt).toBeLessThan(3000);
    const after = (await signed(`/v1/venues/${venueId}/up-next`)).json() as {
      singing: { singer: string };
      up_next: { singer: string }[];
    };
    expect(after.singing.singer).toBe("Jess P.");
    expect(after.up_next.map((s) => s.singer)).toEqual([
      "Kira",
      "Ben T.",
      "Tariq A.",
      "Hana K.",
      "Sofia R.",
    ]);

    // The start also wrote tab.updated and check.updated, which the TV never hears.
    await new Promise((res) => setTimeout(res, 400));
    const types = socket.frames
      .map((f) => JSON.parse(f) as { type: string })
      .filter((f) => !["hello", "caught_up", "cursor"].includes(f.type))
      .map((f) => f.type);
    expect(types.length).toBeGreaterThan(0);
    expect(new Set(types)).toEqual(new Set(["song_queue.updated"]));
    for (const frame of socket.frames) expect(carriesPhone(frame), frame).toBe(false);
    socket.ws.close();
  });

  it("a socket URL signed by the TV for another venue's channel is refused", async () => {
    const other = "00000000-0000-4000-8000-000000000000";
    const path = await signDeviceSocketPath({ ...tv, path: `/v1/venues/${other}/events` });
    const ws = new WebSocket(`${base}${path}`);
    const code = await new Promise<number>((resolve) => {
      ws.once("close", (c) => resolve(c));
      ws.once("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
    });
    expect([403, 4403]).toContain(code);
  });
});

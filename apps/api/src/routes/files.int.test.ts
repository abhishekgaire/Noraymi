import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makeS3 } from "../s3.js";
import { attachFile, downloadLink, sweepUnattachedFiles } from "../files/storage.js";

/** M2-13 acceptance against the local S3 store (docker compose up -d). */
const MB = 1024 * 1024;
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
const clock = new SimulatedClock(SEED_NOW);
const s3 = makeS3();

const ask = (kind: string, contentType: string, bytes: number) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/files`,
    payload: { kind, content_type: contentType, bytes },
  });
const upload = async (
  answer: { upload: { url: string; fields: Record<string, string> } },
  bytes: number,
  contentType: string,
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(answer.upload.fields))
    form.set(k, k === "Content-Type" ? contentType : v);
  form.set("file", new Blob([new Uint8Array(bytes)], { type: contentType }), "photo");
  return fetch(answer.upload.url, { method: "POST", body: form });
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  const m = (
    await raw.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'front_desk'",
      [venueId],
    )
  ).rows[0]!;
  const diego: Principal = {
    kind: "user",
    userId: m.user_id,
    session: "pin",
    memberships: [{ venueId, membershipId: m.id, role: "front_desk" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => diego],
    moduleCacheMs: 0,
    logger: true,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("files", () => {
  let photo = "";

  it("a 4 MB JPEG damage photo uploads, and its link downloads it", async () => {
    const r = await ask("damage_photo", "image/jpeg", 4 * MB);
    expect(r.statusCode, r.body).toBe(201);
    const answer = r.json() as {
      file_id: string;
      upload: { url: string; fields: Record<string, string> };
      max_bytes: number;
    };
    expect(answer.max_bytes).toBe(10 * MB);
    const put = await upload(answer, 4 * MB, "image/jpeg");
    expect(put.status, await put.text()).toBeLessThan(300);
    photo = answer.file_id;
    const link = await app.inject({ method: "GET", url: `/v1/venues/${venueId}/files/${photo}` });
    expect(link.statusCode, link.body).toBe(200);
    const got = await fetch((link.json() as { url: string }).url);
    expect(got.status).toBe(200);
    expect((await got.arrayBuffer()).byteLength).toBe(4 * MB);
  });

  it("a 12 MB photo, or a PDF sent as a damage photo, is refused, and storage itself refuses them too", async () => {
    expect((await ask("damage_photo", "image/jpeg", 12 * MB)).statusCode).toBe(400);
    expect((await ask("damage_photo", "application/pdf", MB)).statusCode).toBe(400);
    // A client that asks for a small JPEG and then sends something else is stopped by storage's own conditions.
    const answer = (await ask("damage_photo", "image/jpeg", 4 * MB)).json() as {
      upload: { url: string; fields: Record<string, string> };
    };
    expect((await upload(answer, 12 * MB, "image/jpeg")).status).toBeGreaterThanOrEqual(400);
    const again = (await ask("damage_photo", "image/jpeg", MB)).json() as {
      upload: { url: string; fields: Record<string, string> };
    };
    expect((await upload(again, MB, "application/pdf")).status).toBeGreaterThanOrEqual(400);
  });

  it("a license copy: a 20 MB PDF is asked for, but a 25 MB one or a Word file is refused, by the API and by storage (M8-09)", async () => {
    expect((await ask("license_copy", "application/pdf", 20 * MB)).statusCode).toBe(201);
    expect((await ask("license_copy", "image/png", 5 * MB)).statusCode).toBe(201);
    expect((await ask("license_copy", "application/pdf", 25 * MB)).statusCode).toBe(400);
    const word = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect((await ask("license_copy", word, MB)).statusCode).toBe(400);
    expect((await ask("license_copy", "application/msword", MB)).statusCode).toBe(400);
    // Storage's own conditions stop a client that asks small and sends 25 MB, or sends a Word file.
    const small = (await ask("license_copy", "application/pdf", MB)).json() as {
      upload: { url: string; fields: Record<string, string> };
    };
    expect((await upload(small, 25 * MB, "application/pdf")).status).toBeGreaterThanOrEqual(400);
    const again = (await ask("license_copy", "application/pdf", MB)).json() as {
      upload: { url: string; fields: Record<string, string> };
    };
    expect((await upload(again, MB, word)).status).toBeGreaterThanOrEqual(400);
  });

  it("an upload nothing attaches is gone 24 hours later on the simulated clock; an attached one stays", async () => {
    const kept = (await ask("lost_item_photo", "image/png", MB)).json() as {
      file_id: string;
      upload: { url: string; fields: Record<string, string> };
    };
    expect((await upload(kept, MB, "image/png")).status).toBeLessThan(300);
    await withVenue(pool, { venueId }, (c) => attachFile(c, venueId, kept.file_id, SEED_NOW));
    expect(await sweepUnattachedFiles(pool, s3, clock.now().add({ hours: 23 }))).toEqual([]);
    const removed = await sweepUnattachedFiles(pool, s3, clock.now().add({ hours: 24 }));
    expect(removed).toContain(photo);
    expect(removed).not.toContain(kept.file_id);
    expect(
      (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/files/${photo}` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/files/${kept.file_id}` }))
        .statusCode,
    ).toBe(200);
  });

  it("a download link stops working when it expires, and venue B can't get one for venue A's file", async () => {
    const f = (await ask("license_copy", "application/pdf", MB)).json() as {
      file_id: string;
      upload: { url: string; fields: Record<string, string> };
    };
    expect((await upload(f, MB, "application/pdf")).status).toBeLessThan(300);
    const short = await withVenue(pool, { venueId }, (c) =>
      downloadLink(c, s3, venueId, f.file_id, 1),
    );
    expect((await fetch(short.url)).status).toBe(200);
    await new Promise((done) => setTimeout(done, 2200));
    expect((await fetch(short.url)).status).toBe(403);

    const venueB = (
      await raw.query<{ id: string }>(
        "insert into venues (org_id, name, slug, address, time_zone) select org_id, 'B', 'b-files', '{}', 'America/New_York' from venues limit 1 returning id",
      )
    ).rows[0]!.id;
    const fileB = (
      await raw.query<{ id: string }>(
        "insert into files (venue_id, kind, storage_key, content_type, bytes, uploaded_at) values ($1::uuid, 'damage_photo', $1::text || '/x.jpg', 'image/jpeg', 1, now()) returning id",
        [venueB],
      )
    ).rows[0]!.id;
    expect(
      (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/files/${fileB}` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/v1/venues/${venueB}/files/${fileB}` })).statusCode,
    ).toBe(403);
  });
});

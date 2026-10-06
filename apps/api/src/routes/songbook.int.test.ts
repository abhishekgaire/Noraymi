import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * The songbook (M6-23): Andy uploads a CSV through POST /files and POST /songbook/uploads; searching
 * "brightside" on the queue page's route finds "Mr. Brightside · The Killers"; a second upload
 * replaces the first; a file with a missing title on line 12 reports line 12 and keeps the last
 * upload; the website's song section gets its search box once a catalog exists.
 */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const search = async (q: string) => {
  const r = await app.inject({
    method: "GET",
    url: `/v1/public/venues/west4karaoke/songs?q=${encodeURIComponent(q)}`,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json<{
    catalog: boolean;
    songs: { id: string; title: string; artist: string | null }[];
  }>();
};

async function upload(csv: string): Promise<string> {
  const bytes = new TextEncoder().encode(csv);
  const answer = (
    await req("POST", "/files", { kind: "songbook", content_type: "text/csv", bytes: bytes.length })
  ).json<{ file_id: string; upload: { url: string; fields: Record<string, string> } }>();
  const form = new FormData();
  for (const [k, v] of Object.entries(answer.upload.fields)) form.set(k, v);
  form.set("file", new Blob([bytes], { type: "text/csv" }), "songbook.csv");
  const sent = await fetch(answer.upload.url, { method: "POST", body: form });
  expect(sent.status).toBeLessThan(300);
  return answer.file_id;
}
const load = (fileId: string) => req("POST", "/songbook/uploads", { file_id: fileId });

const FIRST = [
  "Title,Artist,Code",
  "Mr. Brightside,The Killers,WK-1001",
  "Valerie,Amy Winehouse,WK-1002",
  "\"Don't Stop Believin'\",Journey,WK-1003",
  "Dancing Queen,ABBA,WK-1004",
].join("\n");

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async (r) => (r.url.startsWith("/v1/venues/") ? andy : undefined)],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("the songbook", () => {
  it("before any upload: no catalog, no search box on the site", async () => {
    expect(await search("brightside")).toMatchObject({ catalog: false, songs: [] });
    expect((await req("GET", "/songbook")).json()).toMatchObject({
      songs: 0,
      file_id: null,
      loaded_at: null,
    });
    const site = await app.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/site" });
    expect(site.json<{ songs: { search: boolean } }>().songs.search).toBe(false);
  });

  it('a CSV loads, and searching "brightside" finds Mr. Brightside · The Killers', async () => {
    const file = await upload(FIRST);
    const r = await load(file);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ songs: 4, file_id: file });
    const found = await search("brightside");
    expect(found.catalog).toBe(true);
    expect(found.songs.map((s) => [s.title, s.artist])).toEqual([
      ["Mr. Brightside", "The Killers"],
    ]);
    // By artist, and a near spelling.
    expect((await search("winehouse")).songs.map((s) => s.title)).toEqual(["Valerie"]);
    expect((await search("dancing qeen")).songs.map((s) => s.title)).toContain("Dancing Queen");
    const row = await raw.query(
      "select vendor, vendor_code, source_file_id from song_catalog where title = 'Mr. Brightside'",
    );
    expect(row.rows).toEqual([
      { vendor: "songbook", vendor_code: "WK-1001", source_file_id: file },
    ]);
    const attached = await raw.query("select attached_at from files where id = $1", [file]);
    expect(attached.rows[0].attached_at).not.toBeNull();
    expect((await req("GET", "/songbook")).json()).toMatchObject({ songs: 4, file_id: file });
  });

  it("the website's song section shows its search box once a catalog exists", async () => {
    const site = await app.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/site" });
    expect(site.json<{ songs: { search: boolean } }>().songs.search).toBe(true);
  });

  it("a second upload replaces the first", async () => {
    const r = await load(
      await upload(
        "title,artist,code\nSomebody Told Me,The Killers,WK-2001\nHuman,The Killers,WK-2002\n",
      ),
    );
    expect(r.statusCode, r.body).toBe(201);
    expect((await search("brightside")).songs).toEqual([]);
    expect((await search("killers")).songs.map((s) => s.title).sort()).toEqual([
      "Human",
      "Somebody Told Me",
    ]);
    expect((await req("GET", "/songbook")).json()).toMatchObject({ songs: 2 });
  });

  it("a file with a missing title on line 12 reports line 12 and keeps the last upload", async () => {
    const rows = ["title,artist,code"];
    for (let i = 2; i <= 11; i++) rows.push(`Song ${i},Artist,C${i}`);
    rows.push(",The Killers,WK-3012");
    const r = await load(await upload(rows.join("\n")));
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json()).toMatchObject({
      error: {
        details: { reason: "rows", count: 1, errors: [{ line: 12, problem: "missing_title" }] },
      },
    });
    expect((await req("GET", "/songbook")).json()).toMatchObject({ songs: 2 });
  });

  it("refuses a file that isn't a songbook, or one never sent to storage", async () => {
    const photo = (
      await req("POST", "/files", { kind: "damage_photo", content_type: "image/jpeg", bytes: 3 })
    ).json<{ file_id: string }>();
    expect((await load(photo.file_id)).statusCode).toBe(404);
    const unsent = (
      await req("POST", "/files", { kind: "songbook", content_type: "text/csv", bytes: 3 })
    ).json<{ file_id: string }>();
    const r = await load(unsent.file_id);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: { details: { reason: "not_uploaded" } } });
  });

  it("a short or empty search finds nothing, and a percent sign is plain text", async () => {
    expect((await search("h")).songs).toEqual([]);
    expect((await search("%%")).songs).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { sweepUnattachedFiles } from "../files/storage.js";
import type { Principal } from "../http/principal.js";
import { makeS3 } from "../s3.js";

/** M2-21 acceptance on the demo seed: Room 9's damage fee, only with a photo and a reason. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const s3 = makeS3();
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
type View = {
  tab_so_far_cents: number;
  lines: {
    kind: string;
    amount_cents: number;
    tax_category: string | null;
    reason: string | null;
    file_id: string | null;
  }[];
};

async function photo(kind = "damage_photo"): Promise<string> {
  const answer = (
    await req("POST", "/files", { kind, content_type: "image/jpeg", bytes: 3 })
  ).json<{ file_id: string; upload: { url: string; fields: Record<string, string> } }>();
  const form = new FormData();
  for (const [k, v] of Object.entries(answer.upload.fields)) form.set(k, v);
  form.set("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "photo");
  const sent = await fetch(answer.upload.url, { method: "POST", body: form });
  expect(sent.status).toBeLessThan(300);
  return answer.file_id;
}

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

describe("the damage fee", () => {
  it("is refused without a photo, or with a photo that isn't a damage photo", async () => {
    const none = await req("POST", `/checks/${ids["chk_room9"]}/lines`, {
      kind: "damage",
      reason: "Broken mic stand",
    });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ error: { message: expect.stringMatching(/photo/) } });
    const lost = await photo("lost_item_photo");
    expect(
      (
        await req("POST", `/checks/${ids["chk_room9"]}/lines`, {
          kind: "damage",
          file_id: lost,
          reason: "x",
        })
      ).statusCode,
    ).toBe(400);
    const noReason = await photo();
    expect(
      (
        await req("POST", `/checks/${ids["chk_room9"]}/lines`, {
          kind: "damage",
          file_id: noReason,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("with a photo and a reason, $150.00 goes on Room 9 and the tab so far goes from $480.00 to $630.00", async () => {
    clock.set(SEED_NOW);
    const before = (await req("GET", `/checks/${ids["chk_room9"]}`)).json<View>();
    expect(before.tab_so_far_cents).toBe(48000);
    const file = await photo();
    clock.set(SEED_NOW);
    const r = await req("POST", `/checks/${ids["chk_room9"]}/lines`, {
      kind: "damage",
      file_id: file,
      reason: "Broken mic stand",
    });
    expect(r.statusCode, r.body).toBe(201);
    const after = r.json<View>();
    expect(after.tab_so_far_cents).toBe(63000);
    expect(after.lines.at(-1)).toMatchObject({
      kind: "damage",
      amount_cents: 15000,
      tax_category: "damage",
      reason: "Broken mic stand",
      file_id: file,
    });
    // The thumbnail: the line's photo opens through a short-lived link.
    const link = await req("GET", `/files/${file}`);
    expect(link.statusCode).toBe(200);
  });

  it("the attached photo survives the 24-hour cleanup of unattached uploads", async () => {
    const line = await raw.query<{ file_id: string }>(
      "select file_id from check_lines where check_id = $1 and kind = 'damage'",
      [ids["chk_room9"]],
    );
    const removed = await sweepUnattachedFiles(pool, s3, clock.now().add({ hours: 25 }));
    const removedIds = removed.flatMap((v: { files?: string[] }) => v.files ?? []);
    expect(removedIds).not.toContain(line.rows[0]!.file_id);
    const row = await raw.query("select removed_at, attached_at from files where id = $1", [
      line.rows[0]!.file_id,
    ]);
    expect(row.rows[0]).toMatchObject({ removed_at: null });
    expect(row.rows[0]!.attached_at).not.toBeNull();
  });
});

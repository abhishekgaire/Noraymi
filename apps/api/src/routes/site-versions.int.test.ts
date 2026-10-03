import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** Admin → Website (M5-02): the draft, Publish, republishing an earlier version, photos and sections. */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
const as = (slug: string, role: string, session: "passkey" | "pin" = "passkey") => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session,
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "PUT" | "POST", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const homepage = async () =>
  (await api.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/site" })).json();

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock: new FrozenClock(SEED_NOW),
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("Admin → Website", () => {
  it("publishes new hero words to the live homepage, and the previous version can be published again", async () => {
    as("abhishek", "owner");
    const start = (await call("GET", "/site-versions")).json();
    expect(start.draft).toBeNull();
    expect(start.live_version).toBe(1);
    const before = start.content.hero.headline;
    const saved = await call("PUT", "/site-versions/draft", {
      ...start.content,
      hero: { ...start.content.hero, headline: "Sing it like you mean it." },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().draft).toMatchObject({ version: 2 });
    // The draft doesn't show until it's published.
    expect((await homepage()).content.hero.headline).toBe(before);

    expect((await call("POST", "/site-versions/draft/publish")).json()).toMatchObject({
      version: 2,
    });
    expect((await homepage()).content.hero.headline).toBe("Sing it like you mean it.");
    const events = await owner.query(
      "select 1 from venue_events where type = 'settings.changed' and entity_id = 'site'",
    );
    expect(events.rowCount).toBe(1);

    expect((await call("POST", "/site-versions/1/republish")).json()).toMatchObject({ version: 3 });
    expect((await homepage()).content.hero.headline).toBe(before);
    const list = (await call("GET", "/site-versions")).json();
    expect(
      list.versions.map((v: { version: number; live: boolean }) => [v.version, v.live]),
    ).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
    expect(list.versions[0].published_by).toMatch(/^Abhishek/);
    expect((await call("POST", "/site-versions/99/republish")).statusCode).toBe(404);
    expect((await call("POST", "/site-versions/draft/publish")).statusCode).toBe(404);
  });

  it("won't save a photo without alt text, and shows a saved one with its alt text", async () => {
    as("abhishek", "owner");
    const { content } = (await call("GET", "/site-versions")).json();
    const file = (
      await owner.query<{ id: string }>(
        "insert into files (venue_id, kind, storage_key, content_type, bytes, uploaded_at) values ($1::uuid, 'site_photo', $1::text || '/site/room9.jpg', 'image/jpeg', 2000, now()) returning id",
        [venueId],
      )
    ).rows[0]!.id;
    const noAlt = await call("PUT", "/site-versions/draft", {
      ...content,
      photos: [{ file_id: file, alt: "  ", place: "rooms" }],
    });
    expect(noAlt.statusCode).toBe(400);
    expect(noAlt.json().error.message).toMatch(/alt text/);

    const damage = (
      await owner.query<{ id: string }>(
        "insert into files (venue_id, kind, storage_key, content_type, bytes, uploaded_at) values ($1::uuid, 'damage_photo', $1::text || '/x/dmg.jpg', 'image/jpeg', 1, now()) returning id",
        [venueId],
      )
    ).rows[0]!.id;
    const wrongKind = await call("PUT", "/site-versions/draft", {
      ...content,
      photos: [{ file_id: damage, alt: "A dent", place: "rooms" }],
    });
    expect(wrongKind.statusCode).toBe(400);

    const ok = await call("PUT", "/site-versions/draft", {
      ...content,
      photos: [{ file_id: file, alt: "Room 9's two screens and disco floor", place: "rooms" }],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().photos[0]).toMatchObject({ alt: "Room 9's two screens and disco floor" });
    await call("POST", "/site-versions/draft/publish");
    const site = await homepage();
    expect(site.photos).toEqual([
      {
        url: expect.stringContaining("room9.jpg"),
        alt: "Room 9's two screens and disco floor",
        place: "rooms",
      },
    ]);
  });

  it("won't switch on a section whose module is off, and says why", async () => {
    as("abhishek", "owner");
    await owner.query("update venue_modules set state = 'off' where module_id = 'packages'");
    const got = (await call("GET", "/site-versions")).json();
    expect(got.sections.find((s: { id: string }) => s.id === "packages")).toMatchObject({
      module_on: false,
      shown: false,
      why: "Turn on Packages & specials in Features first.",
    });
    // Hiding it is fine; switching it back on isn't while Packages is off.
    expect(
      (await call("PUT", "/site-versions/draft", { ...got.content, hidden: ["packages"] }))
        .statusCode,
    ).toBe(200);
    const on = await call("PUT", "/site-versions/draft", { ...got.content, hidden: [] });
    expect(on.statusCode).toBe(400);
    expect(on.json().error).toMatchObject({
      message: "Turn on Packages & specials in Features first.",
      details: { reason: "module_off", section: "packages" },
    });
    // A section the owner hides comes off the live site.
    await call("PUT", "/site-versions/draft", { ...got.content, hidden: ["packages", "rooms"] });
    await call("POST", "/site-versions/draft/publish");
    const site = await homepage();
    expect(site.sections).toMatchObject({ rooms: false, packages: false, numbers: true });
    expect(site.modules.rooms).toBe(false);
    await owner.query("update venue_modules set state = 'on' where module_id = 'packages'");
  });

  it("opens only in a passkey session: a PIN session can't read or change it", async () => {
    as("abhishek", "owner", "pin");
    expect((await call("GET", "/site-versions")).statusCode).toBe(403);
    expect((await call("POST", "/site-versions/draft/publish")).statusCode).toBe(403);
    as("andy", "manager");
    expect((await call("GET", "/site-versions")).statusCode).toBe(200);
  });
});

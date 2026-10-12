import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Set up your venue's step 8, the menu (O-10), on a venue our Console made: Sing Sing's menu
 * file (docs/venues/sing-sing/import) goes through the importer as a dry run that saves nothing,
 * then saves on "Looks right", with its open points kept for the owner; the step is done with
 * one item with a price; a PDF sent to our team saves nothing to the menu and shows in the
 * Console until our team marks it done.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance;
let venueId: string;
const clock = new FrozenClock(SEED_NOW);
const people: Record<string, Principal> = {};
const DIR = join(import.meta.dirname, "../../../../docs/venues/sing-sing/import");
const singSing = ["mapping.json", "items.csv", "choices.csv"].map((name) => ({
  name,
  text: readFileSync(join(DIR, name), "utf8"),
}));

const call = (who: string, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({
    method,
    url: url.startsWith("/v1/console") ? url : `/v1/venues/${venueId}${url}`,
    headers: { "x-test-as": who },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const variants = async () =>
  (
    await owner.query<{ n: number }>(
      "select count(*)::int as n from menu_variants where venue_id = $1",
      [venueId],
    )
  ).rows[0]!.n;

const menuMark = async () =>
  (
    (await call("owner", "GET", "/setup")).json() as {
      checklist: { steps: { id: string; mark: string }[] };
    }
  ).checklist.steps.find((s) => s.id === "menu")?.mark;

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
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [
      async (request) => {
        const who = request.headers["x-test-as"];
        return typeof who === "string" ? people[who] : undefined;
      },
    ],
    moduleCacheMs: 0,
  });
  await app.ready();

  const org = await owner.query<{ id: string }>(
    "insert into organizations (legal_name) values ('Menu Step LLC') returning id",
  );
  venueId = (
    await owner.query<{ id: string }>(
      `insert into venues (org_id, name, slug, rule_pack_id)
         values ($1, 'Menu Step', 'menu-step', 'us-ny-new-york-county') returning id`,
      [org.rows[0]!.id],
    )
  ).rows[0]!.id;
  const u = await owner.query<{ id: string }>(
    "insert into users (name, email) values ('Rae Kim', 'rae@example.com') returning id",
  );
  const m = await owner.query<{ id: string }>(
    "insert into memberships (venue_id, user_id, role, status, pin_digits) values ($1, $2, 'owner', 'active', 6) returning id",
    [venueId, u.rows[0]!.id],
  );
  people["owner"] = {
    kind: "user",
    userId: u.rows[0]!.id,
    session: "passkey",
    memberships: [{ venueId, membershipId: m.rows[0]!.id, role: "owner" }],
  };
  const staff = await owner.query<{ id: string }>(
    "insert into console_staff (name, email) values ('Ana', 'ana@ops.test') returning id",
  );
  people["console"] = {
    kind: "console",
    staffId: staff.rows[0]!.id,
    name: "Ana",
    email: "ana@ops.test",
  } as Principal;
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await db?.drop();
});

describe("Step 8: the menu by hand, by spreadsheet or by request (O-10)", () => {
  it("starts with no menu: the step isn't done", async () => {
    expect(await variants()).toBe(0);
    expect(await menuMark()).not.toBe("done");
  });

  it("checks Sing Sing's menu file as a dry run that saves nothing, listing its open points", async () => {
    const r = await call("owner", "POST", "/setup/menu-sheet", { files: singSing, save: false });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as {
      mode: string;
      menu_lines: number;
      choices: number;
      open_points: { kind: string; item: string; group: string | null }[];
    };
    expect(body).toMatchObject({ mode: "dry_run", menu_lines: 179, choices: 295 });
    const kinds = new Set(body.open_points.map((p) => p.kind));
    expect([...kinds].sort()).toEqual(["draft", "extra_price", "included_choice", "pour"]);
    expect(body.open_points).toContainEqual({
      kind: "extra_price",
      item: expect.any(String),
      group: "Sauce",
    });
    expect(await variants()).toBe(0);
    expect(await menuMark()).not.toBe("done");
  });

  it("saves on Looks right: every line in the menu, the step done, the open points kept", async () => {
    const r = await call("owner", "POST", "/setup/menu-sheet", { files: singSing, save: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ mode: "live", menu_lines: 179, new_lines: 179 });
    expect(await variants()).toBe(179);
    expect(await menuMark()).toBe("done");
    const step = (await call("owner", "GET", "/setup/menu")).json() as {
      open_points: unknown[];
    };
    expect(step.open_points.length).toBeGreaterThan(0);
    // The same file again adds nothing.
    const again = await call("owner", "POST", "/setup/menu-sheet", { files: singSing, save: true });
    expect(again.json()).toMatchObject({ new_lines: 0, already: 179 });
    expect(await variants()).toBe(179);
  });

  it("CSVs in the importer's own columns work without a mapping; a broken one names its line", async () => {
    const ok = await call("owner", "POST", "/setup/menu-sheet", {
      files: [
        {
          name: "menu.csv",
          text: "legacy_ref,name,category,price,alcohol,tax_category\nX1,House Lager,Beer,$7.00,Y,drink\n",
        },
      ],
      save: false,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ menu_lines: 1, open_points: [] });
    const bad = await call("owner", "POST", "/setup/menu-sheet", {
      files: [
        {
          name: "menu.csv",
          text: "legacy_ref,name,category,price,alcohol,tax_category\nX2,Free Beer,Beer,$0.00,Y,drink\n",
        },
      ],
      save: true,
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (bad.json() as { error: { details: { problems: string[] } } }).error.details.problems[0],
    ).toMatch(/^menu\.csv:2 /);
    const card = await call("owner", "POST", "/setup/menu-sheet", {
      files: [
        {
          name: "menu.csv",
          text: "legacy_ref,name,category,price,alcohol,tax_category\nX3,4242 4242 4242 4242,Beer,$7.00,Y,drink\n",
        },
      ],
      save: false,
    });
    expect(card.statusCode).toBe(400);
    expect(card.body).toContain("card number");
    expect(await variants()).toBe(179);
  });

  it("a PDF sent to our team saves nothing to the menu and shows in the Console until done", async () => {
    const upload = await call("owner", "POST", "/files", {
      kind: "menu_source",
      content_type: "application/pdf",
      bytes: 2048,
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const fileId = (upload.json() as { file_id: string }).file_id;
    const sent = await call("owner", "POST", "/setup/requests", {
      kind: "menu",
      file_id: fileId,
      note: "Our drinks list, page 2 is the food",
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({
      kind: "menu",
      state: "open",
      requested_by_name: "Rae Kim",
    });
    expect(await variants()).toBe(179);

    const list = await call("console", "GET", `/v1/console/venues/${venueId}/setup-requests`);
    expect(list.statusCode, list.body).toBe(200);
    const requests = (list.json() as { requests: { id: string; state: string }[] }).requests;
    expect(requests).toHaveLength(1);
    const venues = (await call("console", "GET", "/v1/console/venues")).json() as {
      venues: { id: string; open_requests: number }[];
    };
    expect(venues.venues.find((v) => v.id === venueId)?.open_requests).toBe(1);
    const file = await call(
      "console",
      "GET",
      `/v1/console/venues/${venueId}/setup-requests/${requests[0]!.id}/file`,
    );
    expect(file.statusCode, file.body).toBe(200);
    const done = await call(
      "console",
      "POST",
      `/v1/console/venues/${venueId}/setup-requests/${requests[0]!.id}/done`,
    );
    expect(done.statusCode, done.body).toBe(200);
    expect((done.json() as { requests: { state: string }[] }).requests[0]!.state).toBe("done");

    // Another kind of file isn't a menu request.
    const photo = await call("owner", "POST", "/files", {
      kind: "damage_photo",
      content_type: "image/jpeg",
      bytes: 10,
    });
    const wrong = await call("owner", "POST", "/setup/requests", {
      kind: "menu",
      file_id: (photo.json() as { file_id: string }).file_id,
    });
    expect(wrong.statusCode).toBe(400);
  });
});

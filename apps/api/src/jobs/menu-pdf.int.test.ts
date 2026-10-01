import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { generateSigningKey, loadDemoSeed, publishRulePack, Worker } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makeS3 } from "../s3.js";
import { MENU_PDF_KIND, makeMenuPdfHandler } from "./menu-pdf.js";

/** M3-05: the menu PDF re-renders on a menu change, once per burst, tagged, matching the menu API. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let worker: Worker;
let venueId = "";
const clock = new SimulatedClock(SEED_NOW);
const s3 = makeS3();
const req = (method: "GET" | "PATCH", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });

interface Tree {
  categories: {
    name: string;
    items: { id: string; name: string; variants: { id: string; price_cents: number }[] }[];
  }[];
}
const money = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const queued = async () =>
  (
    await raw.query<{ n: number }>(
      "select count(*)::int as n from jobs where kind = 'menu.pdf' and status = 'queued'",
    )
  ).rows[0]!.n;

/** Waits past the job's few seconds, runs the bulk worker, and reads the current PDF. */
async function renderAndRead() {
  clock.set(clock.now().add({ seconds: 10 }));
  expect(await worker.tick()).toBe(1);
  const link = await req("GET", "/menu/pdf");
  expect(link.statusCode).toBe(200);
  const bytes = new Uint8Array(await (await fetch(link.json().url)).arrayBuffer());
  const doc = await getDocument({ data: bytes }).promise;
  let text = "";
  const roles = new Set<string>();
  const walk = (node: { role?: string; children?: unknown[] } | null) => {
    if (!node) return;
    if (node.role) roles.add(node.role);
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : " ") : "")).join("");
    walk((await page.getStructTree()) as never);
  }
  return {
    text: text.replace(/\s+/g, " "),
    roles,
    fileId: link.json().file_id,
  };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  await publishRulePack(raw, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  const owner = await raw.query<{ user_id: string; id: string }>(
    "select m.user_id, m.id from memberships m where m.venue_id = $1 and m.role = 'owner'",
    [venueId],
  );
  const who: Principal = {
    kind: "user",
    userId: owner.rows[0]!.user_id,
    session: "passkey",
    memberships: [{ venueId, membershipId: owner.rows[0]!.id, role: "owner" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => who],
    moduleCacheMs: 0,
  });
  await app.ready();
  pool = appPool(db.url);
  worker = new Worker(pool, {
    pool: "bulk",
    clock,
    handlers: { [MENU_PDF_KIND]: makeMenuPdfHandler(s3.client, s3.bucketFiles) },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("the menu PDF", () => {
  it("isn't there before the first render", async () => {
    expect((await req("GET", "/menu/pdf")).statusCode).toBe(404);
  });

  it("ten saves in a row queue one render", async () => {
    const tree = (await req("GET", "/menu")).json<Tree>();
    const marg = tree.categories.flatMap((c) => c.items).find((i) => i.name === "Margarita")!;
    for (let n = 0; n < 10; n++)
      expect(
        (await req("PATCH", `/menu/items/${marg.id}`, { button_name: `Marg ${n}` })).statusCode,
      ).toBe(200);
    expect(await queued()).toBe(1);
  });

  it("lists the same items and prices as the menu API, with headings, and leaves a hidden item out", async () => {
    const tree = (await req("GET", "/menu")).json<Tree>();
    const bud = tree.categories.flatMap((c) => c.items).find((i) => i.name === "Bud Light")!;
    await req("PATCH", `/menu/items/${bud.id}`, { shown: false });
    const shown = (await req("GET", "/menu")).json<Tree>();
    const pdf = await renderAndRead();
    // Tagged: a structure tree with the document, its headings and the item lists.
    for (const role of ["Document", "H1", "H2", "L", "LI", "P"]) expect(pdf.roles).toContain(role);
    for (const c of shown.categories) {
      expect(pdf.text).toContain(c.name);
      for (const item of c.items) {
        expect(pdf.text, item.name).toContain(item.name);
        expect(pdf.text, item.name).toContain(money(item.variants[0]!.price_cents));
      }
    }
    expect(pdf.text).not.toContain("Bud Light");
    // Sections read in menu order.
    expect(pdf.text.indexOf("Beer")).toBeLessThan(pdf.text.indexOf("Cocktails"));
    expect(pdf.text.indexOf("Cocktails")).toBeLessThan(pdf.text.indexOf("Buckets"));
  });

  it("shows a new price after the next render, and the old PDF is replaced", async () => {
    const first = await req("GET", "/menu/pdf");
    const tree = (await req("GET", "/menu")).json<Tree>();
    const marg = tree.categories.flatMap((c) => c.items).find((i) => i.name === "Margarita")!;
    expect(
      (await req("PATCH", `/menu/variants/${marg.variants[0]!.id}`, { price_cents: 1400 }))
        .statusCode,
    ).toBe(200);
    const pdf = await renderAndRead();
    expect(pdf.text).toMatch(/Margarita \$14\.00/);
    expect(pdf.fileId).not.toBe(first.json().file_id);
    const files = await raw.query<{ n: number }>(
      "select count(*)::int as n from files where kind = 'menu_pdf' and removed_at is null",
    );
    expect(files.rows[0]!.n).toBe(1);
  });
});

import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * The break-glass card (M8-06): Night prints it, it names Andy and Abhishek once both go-live
 * checks are confirmed for each, says to take cash if Stripe is down too, and the short version
 * goes to the front-desk receipt printer. The golden test reads the real PDF's words back with
 * pdf.js and compares them with fixtures/break-glass-card.golden.txt (UPDATE_GOLDEN=1 rewrites it).
 */
const GOLDEN = new URL("../payments/fixtures/break-glass-card.golden.txt", import.meta.url);
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
const as = (slug: string, role: string) => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "POST", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });

async function pdfPages(base64: string): Promise<string[]> {
  const doc = await getDocument({ data: new Uint8Array(Buffer.from(base64, "base64")) }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    pages.push(
      content.items
        .map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : " ") : ""))
        .join("")
        // Line breaks depend on the fonts installed, so the golden text keeps only the words.
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return pages;
}

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

describe("the break-glass card", () => {
  it("names nobody as ready until the go-live checks are confirmed, and says where to confirm them", async () => {
    as("andy", "manager");
    const card = await call("GET", "/break-glass-card");
    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({ venue: "West 4 Boho Karaoke", ready: [] });
    expect(card.json().not_ready).toEqual(expect.arrayContaining(["Abhishek G.", "Andy C."]));
  });

  it("Night prints the card, it names Andy and Abhishek as ready for Tap to Pay, and says to take cash if Stripe is down too", async () => {
    as("abhishek", "owner");
    for (const slug of ["abhishek", "andy"])
      for (const check of ["dashboard_login", "tap_to_pay"])
        expect(
          (await call("POST", `/go-live/people/${ids[slug]}`, { check, confirmed: true }))
            .statusCode,
        ).toBe(200);
    as("andy", "manager");
    const r = await call("GET", "/break-glass-card/pdf");
    expect(r.statusCode).toBe(200);
    expect(r.json().filename).toBe("break-glass-card.pdf");
    const pages = await pdfPages(r.json().pdf);
    // One page each: English, then Spanish.
    expect(pages).toHaveLength(2);
    const [en, es] = pages as [string, string];
    expect(en).toContain("Ready for Tap to Pay");
    expect(en).toMatch(/Abhishek G\.[\s\S]*Andy C\./);
    expect(en).not.toContain("Not ready yet");
    expect(en).toContain("If Stripe is down too");
    expect(en).toContain("Take cash.");
    expect(en).toContain("Unmatched payments");
    expect(en).toContain("Review after outage");
    expect(es).toContain("Si Stripe tampoco funciona");
    expect(es).toContain("Cobra en efectivo.");
    expect(es).toMatch(/Abhishek G\.[\s\S]*Andy C\./);
    // One line per page, so a font change can't move the golden text.
    const text = pages.join("\n") + "\n";
    if (process.env["UPDATE_GOLDEN"]) writeFileSync(GOLDEN, text);
    expect(text).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("prints the short version on the front-desk receipt printer, 32 columns wide, in both languages", async () => {
    as("andy", "manager");
    const r = await call("POST", "/break-glass-card/print");
    expect(r.statusCode).toBe(200);
    const job = await owner.query<{ kind: string; station: string; payload: { lines: string[] } }>(
      "select kind, station, payload from print_jobs where id = $1",
      [r.json().print_job_id],
    );
    expect(job.rows[0]).toMatchObject({ kind: "break_glass", station: "front_desk" });
    const lines = job.rows[0]!.payload.lines;
    expect(lines.every((l) => l.length <= 32)).toBe(true);
    const text = lines.join(" ");
    expect(text).toContain("Take cash.");
    expect(text).toContain("Cobra en efectivo.");
    expect(text).toContain("- Abhishek G.");
    expect(text).toContain("- Andy C.");
  });

  it("is for owners and managers only", async () => {
    as("maya", "bartender");
    expect((await call("GET", "/break-glass-card")).statusCode).toBe(403);
  });
});

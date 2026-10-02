import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { decide } from "../approvals/service.js";
import type { Principal } from "../http/principal.js";
import { presentCheck } from "../rooms/present.js";

/** A lower party size after the gratuity applies (M4-23): Room 9 from 12 to 10. */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let who: Principal | undefined;

const person = (slug: string, role: string): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: "passkey",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
});
const as = (p: Principal, path: string, payload: object) => {
  who = p;
  return api
    .inject({ method: "POST", url: `/v1/venues/${venueId}${path}`, payload })
    .finally(() => {
      who = undefined;
    });
};
const segments = async (session: string) =>
  (
    await owner.query<{ billable_guests: number; started_at: string }>(
      `select billable_guests, to_json(started_at) #>> '{}' as started_at from session_segments
        where session_id = $1 order by started_at`,
      [session],
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
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
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("a lower party size", () => {
  it("Diego lowers Room 9 from 12 to 10: Waiting for Andy, still billing 12, then 10 from Andy's minute", async () => {
    const before = await segments(ids["sess_room9"]!);
    const r = await as(person("diego", "front_desk"), `/sessions/${ids["sess_room9"]}/party-size`, {
      party_size: 10,
    });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: expect.stringMatching(/^Andy/) },
    });
    expect(await segments(ids["sess_room9"]!)).toEqual(before);
    expect(
      (await owner.query("select party_size from room_sessions where id = $1", [ids["sess_room9"]]))
        .rows[0].party_size,
    ).toBe(12);
    // Raising never asks.
    expect(
      (
        await as(person("diego", "front_desk"), `/sessions/${ids["sess_room9"]}/party-size`, {
          party_size: 12,
        })
      ).statusCode,
    ).toBe(200);

    clock.set(SEED_NOW.add({ minutes: 4 }));
    await withVenue(app, { venueId }, (c) =>
      decide(c, venueId, r.json().approval_id, {
        decision: "approve",
        userId: ids["andy"]!,
        deviceId: randomUUID(),
        at: clock.now(),
      }),
    );
    const after = await segments(ids["sess_room9"]!);
    expect(after.at(-1)).toMatchObject({ billable_guests: 10 });
    expect(Date.parse(after.at(-1)!.started_at)).toBe(clock.now().epochMilliseconds);
    expect(after.at(-2)).toMatchObject({ billable_guests: 12 });
  });

  it("Andy's own request goes to Abhishek", async () => {
    const r = await as(person("andy", "manager"), `/sessions/${ids["sess_room9"]}/party-size`, {
      party_size: 9,
    });
    expect(r.statusCode).toBe(202);
    expect(r.json().waiting_for.name).toMatch(/^Abhishek/);
    await withVenue(app, { venueId }, (c) =>
      decide(c, venueId, r.json().approval_id, {
        decision: "decline",
        userId: ids["abhishek"]!,
        deviceId: randomUUID(),
        at: clock.now(),
      }),
    );
    expect(
      (await owner.query("select party_size from room_sessions where id = $1", [ids["sess_room9"]]))
        .rows[0].party_size,
    ).toBe(10);
  });

  it("after approval and Present, the revision's gratuity basis records a party of 10", async () => {
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    await withVenue(app, { venueId }, (c) =>
      presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
    );
    const rev = (
      await owner.query<{ gratuity_basis: { party_size: number } }>(
        "select gratuity_basis from check_revisions where check_id = $1 order by rev desc limit 1",
        [ids["chk_room9"]],
      )
    ).rows[0]!;
    expect(rev.gratuity_basis.party_size).toBe(10);
  });
});

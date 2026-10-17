import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/**
 * Keep the card behind the bar (O-08; D116): after a walk-in is seated, the name on the card and
 * its last 4 are saved on the room's check; no reader, no Stripe call, nothing charged; a full card
 * number is never accepted; the tile shows it until it's given back; a room moved keeps it; and
 * neither the name nor the last 4 ever reaches a log.
 */
const NAME = "Mariela Torresqx";
const LAST4 = "7319";

let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance;
let fake: FakeStripe;
let venueId = "";
let ids: Record<string, string> = {};
let who: Principal;
const logged: string[] = [];
const clock = new FrozenClock(SEED_NOW);

const person = (slug: string, role: string): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: role === "owner" || role === "manager" ? "passkey" : "pin",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
});
const as = (p: Principal, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
  who = p;
  return app.inject({
    method,
    url: `/v1/venues/${venueId}${url}`,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
};

interface BoardRoom {
  room_id: string;
  session: { check_id: string; held_card: { name: string; last4: string } | null } | null;
}
const boardRoom = async (roomId: string) =>
  (await as(person("diego", "front_desk"), "GET", "/board"))
    .json<{ rooms: BoardRoom[] }>()
    .rooms.find((r) => r.room_id === roomId)!;

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
  fake = new FakeStripe();
  const base = await fake.start();
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe: new StripeClient(fakeStripeSettings(base), fetch, 15_000),
    moduleCacheMs: 0,
    authenticators: [async () => who],
    logger: { level: "info", stream: { write: (line: string) => void logged.push(line) } },
  } as Parameters<typeof buildApp>[0]);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await fake?.stop();
  await owner?.end();
  await db?.drop();
});

describe("Keep the card behind the bar (O-08)", () => {
  it("a walk-in check-in saves the name and last 4 on the room's check, and nothing reaches Stripe", async () => {
    const abhishek = person("abhishek", "owner");
    const diego = person("diego", "front_desk");
    const value = (await as(abhishek, "GET", "/settings/deposit")).json<{
      value: Record<string, unknown>;
    }>().value;
    const set = await as(abhishek, "PUT", "/settings/deposit", {
      value: { ...value, walkIn: "cardBehindBar" },
    });
    expect(set.statusCode, set.body).toBe(200);
    const preview = await as(diego, "GET", `/check-in/preview?room=${ids["room_11"]}&party=4`);
    expect(preview.json().walk_in).toBe("cardBehindBar");

    const stripeBefore = fake.requests.length;
    const seated = await as(diego, "POST", `/rooms/${ids["room_11"]}/sessions`, {
      party_size: 4,
      ids_checked: 4,
      minutes: 120,
    });
    expect(seated.statusCode, seated.body).toBe(201);
    const { check_id: checkId, session_id: sessionId } = seated.json<{
      check_id: string;
      session_id: string;
    }>();

    // A field that isn't exactly 4 digits, a name with digits, or a full card number: refused,
    // and never echoed back.
    for (const body of [
      { name: NAME, last4: "731" },
      { name: NAME, last4: "73190" },
      { name: NAME, last4: "4242424242424242" },
      { name: "4242 4242 4242 4242", last4: LAST4 },
      { name: NAME, last4: LAST4, number: "4242424242424242" },
      { name: "", last4: LAST4 },
    ]) {
      const bad = await as(diego, "POST", `/checks/${checkId}/held-card`, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
      expect(bad.body).not.toContain("4242");
      expect(bad.body).not.toContain(LAST4);
    }
    // A bartender's shared work too, but not a bar tab's check.
    const tabCheck = (
      await owner.query<{ id: string }>(
        "select id from checks where venue_id = $1 and kind = 'bar' and status = 'open' limit 1",
        [venueId],
      )
    ).rows[0];
    if (tabCheck)
      expect(
        (
          await as(diego, "POST", `/checks/${tabCheck.id}/held-card`, {
            name: NAME,
            last4: LAST4,
          })
        ).statusCode,
      ).toBe(400);

    const ok = await as(diego, "POST", `/checks/${checkId}/held-card`, {
      name: NAME,
      last4: LAST4,
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().held_card).toMatchObject({ name: NAME, last4: LAST4, returned: false });
    // One card a check.
    expect(
      (await as(diego, "POST", `/checks/${checkId}/held-card`, { name: NAME, last4: LAST4 }))
        .statusCode,
    ).toBe(409);
    // No reader, no Stripe call, nothing charged.
    expect(fake.requests.length).toBe(stripeBefore);
    const payments = await owner.query(
      "select 1 from payment_allocations where check_id = $1 union all select 1 from payment_attempts where check_id = $1",
      [checkId],
    );
    expect(payments.rowCount).toBe(0);
    expect(
      (await owner.query("select 1 from check_cards where check_id = $1", [checkId])).rowCount,
    ).toBe(0);

    // The tile and the check show it.
    expect((await boardRoom(ids["room_11"]!)).session?.held_card).toEqual({
      name: NAME,
      last4: LAST4,
    });
    const check = await as(diego, "GET", `/checks/${checkId}`);
    expect(check.json().held_card).toMatchObject({ name: NAME, last4: LAST4, returned: false });

    // A room moved keeps its card (Room 6 cleaned first, so it's free).
    await owner.query(
      "update room_states set state = 'available' where venue_id = $1 and state = 'cleaning'",
      [venueId],
    );
    const options = (await as(diego, "GET", `/sessions/${sessionId}/move-options`)).json<{
      rooms: { ok: boolean; room_id?: string; id?: string }[];
    }>().rooms;
    const free = options.find((o) => o.ok)!;
    const to = free.room_id ?? free.id!;
    clock.set(SEED_NOW.add({ minutes: 5 }));
    const moved = await as(diego, "POST", `/sessions/${sessionId}/move`, { room_id: to });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await boardRoom(to)).session?.held_card).toEqual({ name: NAME, last4: LAST4 });

    // Close the night lists it until it's given back.
    const night = async () =>
      (await as(abhishek, "GET", "/nights/2026-09-25")).json<{
        checks: { id: string; count: number; blocking: boolean; names: string[] }[];
      }>().checks;
    const listed = (await night()).find((c) => c.id === "held_cards")!;
    expect(listed).toMatchObject({ count: 1, blocking: false });
    expect(listed.names[0]).toContain(`${NAME.toUpperCase()} ···· ${LAST4}`);

    // Give the card back: who and when; the tile drops it, the list empties.
    const back = await as(diego, "POST", `/checks/${checkId}/held-card/returned`);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().held_card).toMatchObject({ returned: true });
    expect((await boardRoom(to)).session?.held_card).toBeNull();
    expect((await night()).find((c) => c.id === "held_cards")!.count).toBe(0);
    const row = (
      await owner.query<{ returned_by: string; taken_by: string }>(
        "select returned_by, taken_by from check_held_cards where check_id = $1",
        [checkId],
      )
    ).rows[0]!;
    expect(row).toEqual({ returned_by: ids["diego"], taken_by: ids["diego"] });

    // The audit log keeps neither the name nor the last 4.
    const audit = await owner.query<{ row: string }>(
      "select row_to_json(a)::text as row from audit_log a where target like 'check_held_cards%'",
    );
    expect(audit.rowCount).toBeGreaterThan(0);
    for (const r of audit.rows) {
      // Ids and timestamps are random digits that can hold "7319" by chance: leave them out.
      const kept = r.row
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?/g, "")
        .replace(/"id":\d+/g, "");
      expect(kept).not.toContain(NAME);
      expect(kept).not.toContain(LAST4);
    }
  });

  it("the name and the last 4 never reach a log", () => {
    const log = logged.join("\n");
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(NAME);
    expect(log).not.toContain("Torresqx");
    expect(log).not.toContain(LAST4);
  });
});

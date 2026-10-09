import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
 * Training mode (M7-03): a new hire in training rings practice checks
 * numbered T-… from their own counter; the wall between practice and live
 * work; a practice session blocks nothing and only screens in training see
 * it; practice cash never opens a drawer; practice receipts print TRAINING
 * and never go by text or email; practice comps leave every reason-only
 * total alone; a device in training makes everything rung there practice;
 * and the live views every report reads leave practice out.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance;
let fake: FakeStripe;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new FrozenClock(SEED_NOW);
let who: Principal;
let device: string | null = null;
let n = 0;
let maya: Principal;
let nina: Principal;
let abhishek: Principal;
const NINA = "00000000-0000-4000-8000-00000000a7a1";
const NINA_M = "00000000-0000-4000-8000-00000000a7a2";

const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${url}`,
    headers: method === "GET" ? {} : { "idempotency-key": `training-${++n}` },
    ...(payload ? { payload } : {}),
  });
const as = <T>(p: Principal, at: string | null, work: () => Promise<T>) => {
  who = p;
  device = at;
  return work();
};
const v = (item: string) => ids[`menu_${item}_regular`]!;
const counter = async (name: string) =>
  (
    await owner.query<{ next: number }>(
      "select next::int as next from venue_counters where venue_id = $1 and name = $2",
      [venueId, name],
    )
  ).rows[0]?.next ?? null;
const sell = (lines: { variant_id: string; qty: number }[]) =>
  call("POST", "/quick-sales", { client_order_id: `training-sale-${++n}`, lines });

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
  // The new hire: a bartender, with training on (Admin → Team does this in team-admin.int.test.ts).
  await owner.query("insert into users (id, name, email) values ($1, 'Nina P.', null)", [NINA]);
  await owner.query(
    `insert into memberships (id, venue_id, user_id, role, status, pin_digits, locale, training)
     values ($1, $2, $3, 'bartender', 'active', 4, 'en', true)`,
    [NINA_M, venueId, NINA],
  );
  fake = new FakeStripe();
  const stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  maya = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  nina = {
    kind: "user",
    userId: NINA,
    session: "pin",
    memberships: [{ venueId, membershipId: NINA_M, role: "bartender" }],
  };
  abhishek = {
    kind: "user",
    userId: ids["abhishek"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["abhishek.membership"]!, role: "owner" }],
  };
  who = maya;
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      GUEST_APP_URL: "http://localhost:3001",
    }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [
      async (request: FastifyRequest) => {
        // The shared screen the request comes from, as its signature would say.
        if (device) request.signedDevice = { deviceId: device, venueId, kind: "front_desk" };
        return who;
      },
    ],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await owner.end();
  await db.drop();
});

describe("Training mode", () => {
  let practiceSession = "";
  let practiceCheck = "";
  let practiceRoom = "";

  it("a trainee's walk-in is a practice session on a free room: T-0001, no block, no room state, the live counter untouched", async () => {
    const liveBefore = await counter("check");
    const board = (await as(maya, null, () => call("GET", "/board"))).json();
    expect(board.counts).toMatchObject({ in_use: 8, open: 3, cleaning: 2, out_of_service: 1 });
    const free = board.rooms.find(
      (r: { session: unknown; state: string; free_now: boolean }) =>
        !r.session && r.state === "available" && r.free_now,
    );
    practiceRoom = free.room_id;
    const states = await owner.query("select * from room_states where room_id = $1", [
      practiceRoom,
    ]);
    const seated = await as(nina, null, () =>
      call("POST", `/rooms/${practiceRoom}/sessions`, {
        party_size: 2,
        ids_checked: 2,
        minutes: 60,
        guest: { name: "Practice party", phone_e164: "+12125550199" },
      }),
    );
    expect(seated.statusCode, seated.body).toBe(201);
    expect(seated.json()).toMatchObject({ check_number: 1, training: true, text: "no_phone" });
    practiceSession = seated.json().session_id;
    practiceCheck = seated.json().check_id;
    const k = await owner.query("select training, number::int from checks where id = $1", [
      practiceCheck,
    ]);
    expect(k.rows[0]).toEqual({ training: true, number: 1 });
    expect(await counter("check")).toBe(liveBefore);
    expect(await counter("check_training")).toBe(2);
    expect(
      (await owner.query("select 1 from room_blocks where ref_id = $1", [practiceSession]))
        .rowCount,
    ).toBe(0);
    expect(
      (await owner.query("select * from room_states where room_id = $1", [practiceRoom])).rows,
    ).toEqual(states.rows);
    // Practice never writes a real guest or texts one.
    expect((await owner.query("select 1 from guests where name = 'Practice party'")).rowCount).toBe(
      0,
    );
  });

  it("the live board still counts 8 in use, 3 open, 2 cleaning and 1 out of service; only a screen in training sees the practice session", async () => {
    const live = (await as(maya, null, () => call("GET", "/board"))).json();
    expect(live.counts).toMatchObject({ in_use: 8, open: 3, cleaning: 2, out_of_service: 1 });
    expect(live.rooms.find((r: { room_id: string }) => r.room_id === practiceRoom).session).toBe(
      null,
    );
    const practice = (await as(nina, null, () => call("GET", "/board"))).json();
    expect(
      practice.rooms.find((r: { room_id: string }) => r.room_id === practiceRoom).session,
    ).toMatchObject({ id: practiceSession, training: true });
    const sessions = (await as(maya, null, () => call("GET", "/sessions"))).json().sessions;
    expect(sessions.some((s: { id: string }) => s.id === practiceSession)).toBe(false);
  });

  it("the wall: a live caller can't see or touch practice work, and a trainee can't change live work", async () => {
    const seen = await as(maya, null, () => call("GET", `/sessions/${practiceSession}`));
    expect(seen.statusCode).toBe(403);
    expect(seen.json().error.details).toEqual({ reason: "training" });
    const end = await as(maya, null, () => call("POST", `/sessions/${practiceSession}/end`));
    expect(end.statusCode).toBe(403);
    // The trainee may look at Room 9, but not end it, check in a real booking or clean a room.
    expect(
      (await as(nina, null, () => call("GET", `/sessions/${ids["sess_room9"]}`))).statusCode,
    ).toBe(200);
    expect(
      (await as(nina, null, () => call("POST", `/sessions/${ids["sess_room9"]}/end`))).statusCode,
    ).toBe(403);
    const booking = (
      await owner.query<{ id: string }>(
        "select id from bookings where venue_id = $1 and status = 'confirmed' limit 1",
        [venueId],
      )
    ).rows[0]!.id;
    const checkIn = await as(nina, null, () =>
      call("POST", `/bookings/${booking}/check-in`, { party_size: 2, ids_checked: 2 }),
    );
    expect(checkIn.statusCode).toBe(403);
    // A trainee's tab can't be moved into a live room.
    const moved = await as(nina, null, () =>
      call("POST", `/tabs/${ids["tab_t1"]}/move-to-room`, { session_id: ids["sess_room9"] }),
    );
    expect(moved.statusCode).toBe(403);
    // The trainee ends the practice session: no cleaning, no room state.
    const ended = await as(nina, null, () => call("POST", `/sessions/${practiceSession}/end`));
    expect(ended.statusCode, ended.body).toBeLessThan(300);
    expect(
      (
        await owner.query("select 1 from room_blocks where room_id = $1 and kind = 'cleaning'", [
          practiceRoom,
        ])
      ).rowCount,
    ).toBe(0);
  });

  let sale = "";
  it("a practice cash sale shows the change, never kicks the drawer and writes no drawer move; its ticket prints TRAINING", async () => {
    const front = ids["dev_front_computer"]!;
    // A quick sale prints a bar ticket only while the venue asks for drink tickets (M6-29, D99).
    await owner.query(
      `update venue_settings set value = value || '{"printBarDrinkTickets": true}'::jsonb
        where key = 'pos'`,
    );
    const r = await as(nina, front, () => sell([{ variant_id: v("modelo"), qty: 4 }]));
    expect(r.statusCode, r.body).toBe(201);
    sale = r.json().check_id;
    expect(
      (await owner.query("select training, number::int from checks where id = $1", [sale])).rows[0],
    ).toEqual({ training: true, number: 2 });
    const ticket = await owner.query<{ payload: { training?: boolean } }>(
      `select j.payload from print_jobs j join orders o on o.id = j.order_id
        where o.check_id = $1 and j.kind = 'ticket'`,
      [sale],
    );
    expect(ticket.rows[0]?.payload.training).toBe(true);
    await owner.query(
      `update venue_settings set value = value || '{"printBarDrinkTickets": false}'::jsonb where key = 'pos'`,
    );
    const due = r.json().amount_due_cents as number;
    const cash = await as(nina, front, () =>
      call("POST", `/checks/${sale}/payments`, {
        method: "cash",
        amount_cents: due,
        tendered_cents: 10000,
      }),
    );
    expect(cash.statusCode, cash.body).toBe(201);
    expect(cash.json().change_cents).toBe(10000 - due);
    const pay = await owner.query<{ id: string; training: boolean; drawer_session_id: string }>(
      "select id, training, drawer_session_id from payments where id = $1",
      [cash.json().id],
    );
    expect(pay.rows[0]).toMatchObject({ training: true, drawer_session_id: null });
    expect(
      (await owner.query("select 1 from drawer_moves where payment_id = $1", [pay.rows[0]!.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await owner.query(
          "select 1 from print_jobs where kind = 'drawer' and payload->>'payment_id' = $1",
          [pay.rows[0]!.id],
        )
      ).rowCount,
    ).toBe(0);
    // The same sale rung live on the front-desk computer opens the drawer and logs the cash.
    const live = (await as(maya, front, () => sell([{ variant_id: v("bud"), qty: 1 }]))).json();
    const liveCash = await as(maya, front, () =>
      call("POST", `/checks/${live.check_id}/payments`, {
        method: "cash",
        amount_cents: live.amount_due_cents,
        tendered_cents: 2000,
      }),
    );
    expect(
      (await owner.query("select 1 from drawer_moves where payment_id = $1", [liveCash.json().id]))
        .rowCount,
    ).toBe(1);
  });

  it("a practice receipt prints TRAINING and can't be texted or emailed", async () => {
    const text = await as(nina, null, () =>
      call("POST", `/checks/${sale}/receipts`, { channel: "text", to: "+12125550123" }),
    );
    expect(text.statusCode).toBe(403);
    expect(text.json().error.details).toEqual({ reason: "training" });
    const email = await as(nina, null, () =>
      call("POST", `/checks/${sale}/receipts`, { channel: "email", to: "guest@example.com" }),
    );
    expect(email.statusCode).toBe(403);
    const print = await as(nina, null, () =>
      call("POST", `/checks/${sale}/receipts`, { channel: "print" }),
    );
    expect(print.statusCode, print.body).toBeLessThan(300);
    const job = await owner.query<{ payload: { lines: string[] } }>(
      "select payload from print_jobs where check_id = $1 and kind = 'receipt' order by created_at desc limit 1",
      [sale],
    );
    expect(job.rows[0]!.payload.lines[0]).toBe("TRAINING · not real money");
    expect(job.rows[0]!.payload.lines).toContain("Check T-0002");
  });

  let open = "";
  it("a practice comp leaves the trainee's reason-only total untouched, and Maya still has $63 left this shift", async () => {
    // A second practice session on the same free room, with four Modelos rung onto its check.
    const seated = (
      await as(nina, null, () =>
        call("POST", `/rooms/${practiceRoom}/sessions`, {
          party_size: 2,
          ids_checked: 2,
          minutes: 60,
        }),
      )
    ).json();
    open = seated.check_id;
    const rung = await as(nina, null, () =>
      call("POST", `/checks/${open}/orders`, {
        client_order_id: `training-round-${++n}`,
        lines: [{ variant_id: v("modelo"), qty: 4 }],
      }),
    );
    expect(rung.statusCode, rung.body).toBe(201);
    // Its order shows only on screens in training.
    const seenBy = async (p: Principal) =>
      (await as(p, null, () => call("GET", "/orders?status=accepted")))
        .json()
        .orders.some((o: { check_id: string }) => o.check_id === open);
    expect(await seenBy(nina)).toBe(true);
    expect(await seenBy(maya)).toBe(false);
    const line = (
      await owner.query<{ id: string }>(
        "select id from check_lines where check_id = $1 and kind = 'item' limit 1",
        [open],
      )
    ).rows[0]!.id;
    const comp = await as(nina, null, () =>
      call("POST", `/checks/${open}/lines/${line}/comp`, {
        reason: "practice",
        made: true,
        qty: 1,
      }),
    );
    expect(comp.statusCode, comp.body).toBeLessThan(300);
    const mine = (await as(nina, null, () => call("GET", "/reason-only"))).json();
    expect(mine.used_cents).toBe(0);
    const mayas = (await as(maya, null, () => call("GET", "/reason-only"))).json();
    expect(mayas.left_cents).toBe(6300);
  });

  it("an approval asked from a practice check is marked training", async () => {
    const line = (
      await owner.query<{ id: string }>(
        "select id from check_lines where check_id = $1 and kind = 'item' order by id limit 1",
        [open],
      )
    ).rows[0]!.id;
    // Three Modelos ($27) is past the $25 a comp may be on a reason alone: it asks the manager.
    const asked = await as(nina, null, () =>
      call("POST", `/checks/${open}/lines/${line}/comp`, {
        reason: "practice",
        made: true,
        qty: 3,
      }),
    );
    expect(asked.statusCode, asked.body).toBe(202);
    const rows = await owner.query<{ training: boolean }>(
      "select training from approvals where target_id = $1",
      [open],
    );
    expect(rows.rows).toEqual([{ training: true }]);
    const live = await owner.query("select 1 from approvals where training");
    expect(live.rowCount).toBe(rows.rowCount);
  });

  it("training on the bar computer makes everything rung there practice, whoever signs in", async () => {
    const bar = ids["dev_bar_computer"]!;
    const on = await as(abhishek, null, () => call("PATCH", `/devices/${bar}`, { training: true }));
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().training).toBe(true);
    const r = await as(maya, bar, () => sell([{ variant_id: v("bud"), qty: 1 }]));
    expect(
      (
        await owner.query("select training, number::int from checks where id = $1", [
          r.json().check_id,
        ])
      ).rows[0],
    ).toEqual({ training: true, number: 4 });
    await as(abhishek, null, () => call("PATCH", `/devices/${bar}`, { training: false }));
    const back = await as(maya, bar, () => sell([{ variant_id: v("bud"), qty: 1 }]));
    expect(
      (await owner.query("select training from checks where id = $1", [back.json().check_id]))
        .rows[0].training,
    ).toBe(false);
  });

  it("every report reads the live views, which leave every practice check, line and payment out", async () => {
    const q = async (sql: string) => (await owner.query<{ n: number }>(sql)).rows[0]!.n;
    const practice = await q("select count(*)::int as n from checks where training");
    expect(practice).toBe(4);
    expect(await q("select count(*)::int as n from checks")).toBe(
      (await q("select count(*)::int as n from live_checks")) + practice,
    );
    expect(await q("select count(*)::int as n from live_checks where training")).toBe(0);
    expect(
      await q(
        `select count(*)::int as n from live_check_lines l join checks k on k.id = l.check_id where k.training`,
      ),
    ).toBe(0);
    expect(await q("select count(*)::int as n from live_payments where training")).toBe(0);
    expect(await q("select count(*)::int as n from payments where training")).toBeGreaterThan(0);
  });
});

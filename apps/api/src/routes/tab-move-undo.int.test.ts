import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * U-12 (D133): a bar tab moved into a fresh room, and Undo. On the demo seed at 10:41 PM, as the API
 * runs (app_rw, row-level security forced): Maya seats a walk-in for Luis M. with the server's pick and
 * moves his tab there (his hold now guarantees the room), then Undo puts every drink back on his tab to
 * the cent, reopens it with its hold, and both moves are in the audit log as hers. Undo is refused once
 * something is added to the room, after the window, to anyone else, once the hold is being released,
 * and onto a cut-off tab.
 */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;
let who: Principal;
let maya: Principal;
let diego: Principal;

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
  maya = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  diego = {
    kind: "user",
    userId: ids["diego"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["diego.membership"]!, role: "bartender" }],
  };
  who = maya;
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url.replace("//west4:west4@", "//app_rw:app_rw@"),
    }),
    clock,
    authenticators: [async () => who],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${url}`,
    headers: method === "POST" ? { "idempotency-key": `u12-${++n}` } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
interface Listed {
  id: string;
  state: string;
  check_id: string;
  hold_cents: number;
  totals: { total_cents: number; subtotal_cents: number; tax_cents: number };
  amount_due_cents?: number;
}
const listed = async (tabId: string) =>
  (await call("GET", "/tabs")).json<{ tabs: Listed[] }>().tabs.find((t) => t.id === tabId);
interface View {
  lines: { id: number; kind: string; description: string; amount_cents: number; reason: string }[];
  amount_due_cents: number;
  totals: { subtotal_cents: number; tax_cents: number; total_cents: number };
}
const checkOf = async (checkId: string) => (await call("GET", `/checks/${checkId}`)).json<View>();
const sum = (v: View) => v.lines.reduce((s, l) => s + l.amount_cents, 0);
const tabRow = async (tabId: string) =>
  (
    await raw.query<{ payment_id: string | null; check_id: string }>(
      "select payment_id, check_id from tabs where id = $1",
      [tabId],
    )
  ).rows[0]!;
const allocationsOn = async (checkId: string, paymentId: string) =>
  (
    await raw.query<{ state: string; amount_cents: string }>(
      "select state, amount_cents from payment_allocations where check_id = $1 and payment_id = $2 order by created_at, id",
      [checkId, paymentId],
    )
  ).rows;
const move = (tabId: string, sessionId: string) =>
  call("POST", `/tabs/${tabId}/move-to-room`, { session_id: sessionId });
const undo = (tabId: string) => call("POST", `/tabs/${tabId}/undo-move`);

let fresh: { session_id: string; check_id: string; room_name: string };

describe("U-12 · Move to a new room, then Undo", () => {
  it("seats a walk-in in the server's pick and moves Luis M.'s tab there; Undo restores it to the cent", async () => {
    const preview = (await call("GET", "/check-in/preview?walk_in=1&party=2")).json<{
      suggested_room_id: string;
    }>();
    expect(preview.suggested_room_id).toBeTruthy();
    const seated = await call("POST", `/rooms/${preview.suggested_room_id}/sessions`, {
      party_size: 2,
      ids_checked: 2,
      minutes: 60,
      guest: { name: "Luis M." },
    });
    expect(seated.statusCode, seated.body).toBe(201);
    fresh = seated.json();
    expect(fresh.session_id).toBeTruthy();

    const tabId = ids["tab_t2"]!;
    const { check_id: tabCheck, payment_id: paymentId } = await tabRow(tabId);
    const before = (await listed(tabId))!;
    const beforeView = await checkOf(tabCheck);
    expect(before.state).toBe("open");
    expect(sum(beforeView)).toBeGreaterThan(0);

    const moved = await move(tabId, fresh.session_id);
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ room: fresh.room_name, undoable: true });
    const roomAfterMove = await checkOf(fresh.check_id);
    expect(sum(roomAfterMove)).toBe(sum(beforeView));
    if (paymentId)
      expect((await allocationsOn(fresh.check_id, paymentId)).map((a) => a.state)).toEqual([
        "in_progress",
      ]);

    const mark = (await raw.query<{ m: string }>("select max(id) as m from audit_log")).rows[0]!.m;
    const back = await undo(tabId);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ room: fresh.room_name, tab: { id: tabId, state: "open" } });

    // To the cent: the tab is what it was, and the room's check holds none of it.
    const after = (await listed(tabId))!;
    expect(after.state).toBe("open");
    expect(after.hold_cents).toBe(before.hold_cents);
    expect(after.totals).toEqual(before.totals);
    const afterView = await checkOf(tabCheck);
    const status = await raw.query<{ status: string }>("select status from checks where id = $1", [
      tabCheck,
    ]);
    expect(status.rows[0]!.status).toBe("open");
    expect(sum(afterView)).toBe(sum(beforeView));
    expect(afterView.totals).toEqual(beforeView.totals);
    expect(afterView.amount_due_cents).toBe(beforeView.amount_due_cents);
    expect(afterView.lines.filter((l) => l.kind === "transfer_in").map((l) => l.reason)).toContain(
      `Moved back from ${fresh.room_name}`,
    );
    expect(sum(await checkOf(fresh.check_id))).toBe(0);
    if (paymentId)
      expect((await allocationsOn(fresh.check_id, paymentId)).map((a) => a.state)).toEqual([
        "released",
      ]);
    const t = (
      await raw.query<{ moved: string | null; closed_at: string | null }>(
        "select moved_to_check_id as moved, closed_at from tabs where id = $1",
        [tabId],
      )
    ).rows[0]!;
    expect(t).toEqual({ moved: null, closed_at: null });

    // Audited like the move: the lines back and the tab's reopening are rows by Maya.
    const audit = await raw.query<{ action: string; actor: string }>(
      `select action, actor from audit_log
        where venue_id = $1 and id > $3
          and (target = 'tabs/' || $2 or new_values->>'reason' like 'Moved back%')`,
      [venueId, tabId, mark],
    );
    expect(audit.rows.filter((r) => r.action === "check_lines.insert").length).toBe(
      2 * afterView.lines.filter((l) => l.reason === `Moved back from ${fresh.room_name}`).length,
    );
    expect(audit.rows.every((r) => r.actor === ids["maya"])).toBe(true);
    expect(audit.rows.some((r) => r.action === "tabs.update")).toBe(true);

    // Twice is once: the tab isn't in a room any more.
    const again = await undo(tabId);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.details.reason).toBe("not_moved");
  });

  it("is refused once something is added to the room's check", async () => {
    const tabId = ids["tab_t2"]!;
    expect((await move(tabId, fresh.session_id)).statusCode).toBe(200);
    const variant = ids["menu_modelo_regular"]!;
    const order = await call("POST", `/checks/${fresh.check_id}/orders`, {
      client_order_id: `u12-order-${++n}`,
      lines: [{ variant_id: variant, qty: 1 }],
    });
    expect(order.statusCode, order.body).toBe(201);
    const r = await undo(tabId);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.reason).toBe("room_changed");
    expect((await listed(tabId))?.state ?? "closed").toBe("closed");
  });

  it("is only for whoever moved it, and only for a few seconds", async () => {
    const tabId = ids["tab_t1"]!;
    const moved = await move(tabId, fresh.session_id);
    expect(moved.statusCode, moved.body).toBe(200);
    who = diego;
    const notYours = await undo(tabId);
    who = maya;
    expect(notYours.statusCode).toBe(403);
    expect(notYours.json().error.details.reason).toBe("not_yours");
    clock.advance(Temporal.Duration.from({ seconds: 16 }));
    const late = await undo(tabId);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.details.reason).toBe("undo_expired");
  });

  it("can't bring back a hold that's being released (Room 9 has Marcus's card)", async () => {
    await raw.query(
      "update payments set stripe_pi_id = 'pi_seed_marcus' where booking_id = $1 and method = 'card_online'",
      [ids["bk_marcus"]],
    );
    const tabId = ids["tab_t3"]!;
    const moved = await move(tabId, ids["sess_room9"]!);
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ hold: "released", undoable: false });
    const r = await undo(tabId);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.reason).toBe("hold_released");
  });

  it("doesn't put alcohol back onto a cut-off tab (Hana K.)", async () => {
    const tabId = ids["tab_t4"]!;
    const { check_id: tabCheck } = await tabRow(tabId);
    const moved = await move(tabId, ids["sess_room5"]!);
    expect(moved.statusCode, moved.body).toBe(200);
    const r = await undo(tabId);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("cut_off");
    const refused = await raw.query("select 1 from alcohol_refusals where check_id = $1", [
      tabCheck,
    ]);
    expect(refused.rowCount).toBeGreaterThan(0);
  });
});

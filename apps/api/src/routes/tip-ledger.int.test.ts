import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { askRefund } from "../payments/refunds.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * The tip ledger (M7-08; Money rules 9, 14 and 16; GA-M2): rows written with
 * the money they record, credited to whoever collected it and their shift,
 * negative for a refund, nothing for practice money, and the night's
 * gratuity rows equal to its gratuity lines.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;

type Role = "owner" | "manager" | "bartender" | "front_desk";
interface Who {
  slug: string;
  role: Role;
  session: SessionKind;
  device: string;
  deviceKind: "bar_computer" | "front_desk" | "staff_phone";
}
let who: Who;
const as = (slug: string, role: Role, session: SessionKind, device: string) => {
  who = {
    slug,
    role,
    session,
    device,
    deviceKind: device.startsWith("dev_phone")
      ? "staff_phone"
      : device === "dev_bar_computer"
        ? "bar_computer"
        : "front_desk",
  };
};
const post = (path: string, payload?: unknown) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": `drawer-${++n}` },
    ...(payload ? { payload } : {}),
  });

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
  const memberships = Object.fromEntries(
    (
      await owner.query<{ user_id: string; id: string }>(
        "select user_id, id from memberships where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.user_id, r.id]),
  );
  as("andy", "manager", "passkey", "dev_phone_andy");
  api = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
    }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request: FastifyRequest): Promise<Principal> => {
        const userId = ids[who.slug]!;
        const deviceId = ids[who.device]!;
        Object.assign(request, {
          session: {
            assurance: who.session,
            membershipId: memberships[userId],
            deviceId,
          },
          signedDevice: { deviceId, venueId, kind: who.deviceKind },
        });
        return {
          kind: "user",
          userId,
          session: who.session,
          memberships: [{ venueId, membershipId: memberships[userId]!, role: who.role }],
        };
      },
    ],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

interface Row {
  source: string;
  amount: number;
  user: string | null;
  on: string;
  adjusts: string | null;
  refund: boolean;
}
const rows = async (where: string, args: unknown[]) =>
  (
    await owner.query<Row>(
      `select source, amount_cents::int as amount, u.name as user, business_date::text as on,
              adjusts_business_date::text as adjusts, refund_id is not null as refund
         from tip_ledger l left join users u on u.id = l.user_id
        where l.venue_id = $1 and ${where} order by l.source desc, l.amount_cents`,
      [venueId, ...args],
    )
  ).rows;
let cashId = "";

describe("the tip ledger", () => {
  it("writes Room 9's $96.00 gratuity and Diego's $5.00 cash tip, on his shift, when he takes the rest in cash", async () => {
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    as("diego", "front_desk", "pin", "dev_front_computer");
    expect((await post(`/checks/${ids["chk_room9"]}/present`)).statusCode).toBe(200);
    expect(await rows("check_id = $2", [ids["chk_room9"]])).toEqual([]);
    const paid = await post(`/checks/${ids["chk_room9"]}/payments`, {
      method: "cash",
      amount_cents: 49860,
      tip_cents: 500,
      tendered_cents: 50360,
    });
    expect(paid.statusCode, paid.body).toBe(201);
    cashId = paid.json().payment_id ?? paid.json().id;
    expect(await rows("check_id = $2 and refund_id is null", [ids["chk_room9"]])).toEqual([
      {
        source: "gratuity",
        amount: 9600,
        user: "Diego R.",
        on: "2026-09-25",
        adjusts: null,
        refund: false,
      },
      {
        source: "cash_tip",
        amount: 500,
        user: "Diego R.",
        on: "2026-09-25",
        adjusts: null,
        refund: false,
      },
    ]);
    const shifts = await owner.query<{ mine: boolean }>(
      `select s.membership_id = m.id as mine from tip_ledger l join shifts s on s.id = l.shift_id
         join memberships m on m.venue_id = l.venue_id and m.user_id = l.user_id where l.check_id = $1`,
      [ids["chk_room9"]],
    );
    expect(shifts.rows).toEqual([{ mine: true }, { mine: true }]);
  });

  it("writes a refund's share of the gratuity and the tip it gives back as negative rows on the refund's date", async () => {
    const item = (
      await owner.query<{ id: string; amount: number }>(
        "select id::text, amount_cents::int as amount from check_lines where check_id = $1 and kind = 'item' order by id limit 1",
        [ids["chk_room9"]],
      )
    ).rows[0]!;
    // Andy asks (the route's passkey step-up is the refund tests'); Abhishek approves on his phone.
    const asked = await withVenue(app, { venueId, userId: ids["andy"] }, (c) =>
      askRefund(c, venueId, {
        checkId: ids["chk_room9"]!,
        bookingId: null,
        lines: [{ lineId: Number(item.id), amountCents: item.amount }],
        parts: [{ paymentId: cashId, amountCents: 50360 }],
        reason: "Wrong drinks rung",
        userId: ids["andy"]!,
        deviceId: ids["dev_phone_andy"]!,
        businessDate: "2026-09-25",
        now: clock.now(),
      }),
    );
    as("abhishek", "owner", "passkey", "dev_phone_abhishek");
    const ok = await post(`/approvals/${asked.approval_id}/decide`, { decision: "approve" });
    expect(ok.statusCode, ok.body).toBe(200);
    const share = (
      await owner.query<{ amount: number }>(
        "select amount_cents::int as amount from check_lines where check_id = $1 and kind = 'refund' and description = 'Refund · Gratuity'",
        [ids["chk_room9"]],
      )
    ).rows[0]!.amount;
    expect(share).toBeLessThan(0);
    expect(await rows("refund_id is not null", [])).toEqual([
      {
        source: "gratuity",
        amount: share,
        user: "Diego R.",
        on: "2026-09-25",
        adjusts: null,
        refund: true,
      },
      {
        source: "cash_tip",
        amount: -500,
        user: "Diego R.",
        on: "2026-09-25",
        adjusts: null,
        refund: true,
      },
    ]);
  });

  it("writes nothing for practice money", async () => {
    await owner.query(
      `insert into payments (venue_id, method, status, amount_cents, tip_cents, business_date, training)
       values ($1, 'cash', 'captured', 1000, 300, '2026-09-25', true)`,
      [venueId],
    );
    expect(await rows("amount_cents = 300", [])).toEqual([]);
  });

  it("keeps the night's gratuity rows equal to its gratuity lines, refunds included", async () => {
    const lines = await owner.query<{ cents: number }>(
      `select coalesce(sum(l.amount_cents), 0)::int as cents
         from check_lines l join checks k on k.venue_id = l.venue_id and k.id = l.check_id
        where k.venue_id = $1 and k.business_date = '2026-09-25' and k.status = 'paid' and not k.training
          and (l.kind = 'gratuity' or (l.kind = 'refund' and l.description = 'Refund · Gratuity'))`,
      [venueId],
    );
    const ledger = await owner.query<{ cents: number }>(
      `select coalesce(sum(amount_cents), 0)::int as cents from tip_ledger
        where venue_id = $1 and source = 'gratuity' and business_date = '2026-09-25' and adjusts_business_date is null`,
      [venueId],
    );
    expect(ledger.rows[0]!.cents).toBe(lines.rows[0]!.cents);
    expect(ledger.rows[0]!.cents).toBeGreaterThan(0);
  });
});

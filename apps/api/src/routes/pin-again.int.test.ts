import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
} from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  FrozenClock,
  SEED_NOW,
  newYorkCounty,
  newYorkCountyTaxed,
  pinAgainActions,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { RegisteredRoute } from "../http/registry.js";
import type { Principal, SessionKind } from "../http/principal.js";
import { PARAM_SAMPLES, fillUrl } from "../security/fixtures.js";

/**
 * P-10 · Ask for the PIN again (spec 02 · PINs; Admin → Features → Choices): the owner ticks the
 * actions; in a PIN or badge session each ticked action answers pin_again_required until the
 * person's own PIN comes with it (X-PIN-Again), a wrong PIN is refused and nothing is written, a
 * passkey session isn't asked, and an unticked action isn't either. Only the owner saves the list.
 * Every route that names an action is called as each session, from the registry.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance & { routes: RegisteredRoute[] };
let venueId: string;
let ids: Record<string, string>;
let memberships: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;

type Role = "owner" | "manager" | "bartender";
let who: { slug: string; role: Role; session: SessionKind } = {
  slug: "abhishek",
  role: "owner",
  session: "passkey",
};
const as = (slug: string, role: Role, session: SessionKind) => {
  who = { slug, role, session };
};
const call = (
  method: "GET" | "POST" | "PUT",
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  api.inject({
    method,
    url: path.startsWith("/v1/") ? path : `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": `p10-${++n}`, ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const tick = (actions: readonly string[]) => {
  as("abhishek", "owner", "passkey");
  return call("PUT", "/settings/pinAgain", { value: { actions } });
};
const discounts = async () =>
  (
    await owner.query<{ n: number }>(
      "select count(*)::int as n from check_discounts where venue_id = $1 and check_id = $2",
      [venueId, ids["chk_t1"]],
    )
  ).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
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
  memberships = Object.fromEntries(
    (
      await owner.query<{ user_id: string; id: string }>(
        "select user_id, id from memberships where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.user_id, r.id]),
  );
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
        const deviceId = ids["dev_bar_computer"]!;
        Object.assign(request, {
          session: { assurance: who.session, membershipId: memberships[userId], deviceId },
          signedDevice: { deviceId, venueId, kind: "bar_computer" },
        });
        return {
          kind: "user",
          userId,
          session: who.session,
          memberships: [{ venueId, membershipId: memberships[userId]!, role: who.role }],
        };
      },
    ],
  }) as FastifyInstance & { routes: RegisteredRoute[] };
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

const discount = (headers: Record<string, string> = {}) =>
  call(
    "POST",
    `/checks/${ids["chk_t1"]}/discount`,
    { mode: "amount", amount_cents: 100, reason: "Regular guest" },
    headers,
  );
const removeDiscount = () => call("POST", `/checks/${ids["chk_t1"]}/discount/remove`);

describe("P-10 · Ask for the PIN again", () => {
  it("by default only no-sale asks: Maya's discount goes on with no PIN, and the drawer panel says no-sale asks", async () => {
    as("andy", "manager", "passkey");
    expect((await call("GET", "/settings/pinAgain")).json().value).toEqual({
      actions: ["no_sale"],
    });
    as("maya", "bartender", "pin");
    expect((await discount()).statusCode).toBe(201);
    expect((await removeDiscount()).statusCode).toBe(200);
    const drawers = (await call("GET", "/drawers")).json() as { me: { no_sale_pin: boolean } };
    expect(drawers.me.no_sale_pin).toBe(true);
  });

  it("only the owner saves the list; a manager reads it", async () => {
    as("andy", "manager", "passkey");
    const byAndy = await call("PUT", "/settings/pinAgain", { value: { actions: ["void"] } });
    expect(byAndy.statusCode).toBe(403);
    const bad = await tick(["admin"]);
    expect(bad.statusCode).toBe(400);
    expect((await tick([...pinAgainActions])).statusCode).toBe(200);
  });

  it("a ticked discount asks Maya's PIN session on the server; nothing is written until her own PIN comes", async () => {
    expect((await tick([...pinAgainActions])).statusCode).toBe(200);
    as("maya", "bartender", "pin");
    const before = await discounts();
    const asked = await discount();
    expect(asked.statusCode).toBe(403);
    expect(asked.json().error).toMatchObject({
      code: "pin_again_required",
      details: { action: "discount" },
    });
    const wrong = await discount({ "x-pin-again": "0000" });
    expect(wrong.statusCode).toBe(401);
    expect(await discounts()).toBe(before);
    // The same call with the same key, now with her PIN: it goes on.
    const ok = await call(
      "POST",
      `/checks/${ids["chk_t1"]}/discount`,
      { mode: "amount", amount_cents: 100, reason: "Regular guest" },
      { "x-pin-again": "4071", "idempotency-key": "p10-same" },
    );
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await discounts()).toBe(before + 1);
    expect(
      (
        await call("POST", `/checks/${ids["chk_t1"]}/discount/remove`, undefined, {
          "x-pin-again": "4071",
        })
      ).statusCode,
    ).toBe(200);
  });

  it("a badge session is asked too; a passkey session isn't", async () => {
    as("maya", "bartender", "badge");
    expect((await discount()).json().error?.code).toBe("pin_again_required");
    as("andy", "manager", "passkey");
    expect((await discount()).statusCode).toBe(201);
    expect((await removeDiscount()).statusCode).toBe(200);
  });

  it("every route that names an action asks a PIN and a badge session for it, never a passkey one", async () => {
    const named = api.routes.filter((r) => r.pinAgain !== undefined);
    const covered = new Set(
      named.map((r) => (typeof r.pinAgain === "string" ? r.pinAgain : r.pinAgain!.action)),
    );
    expect([...covered].sort()).toEqual([...pinAgainActions].sort());
    const values = { ...PARAM_SAMPLES, venueId };
    for (const r of named.filter((x) => typeof x.pinAgain === "string")) {
      const { url } = fillUrl(r.url, values);
      // A refund is asked for by owners and managers; everything else by a bartender too.
      const refund = r.action === "refunds.request";
      for (const session of ["pin", "badge"] as const) {
        as(refund ? "andy" : "maya", refund ? "manager" : "bartender", session);
        const res = await call(r.method as "POST", url, {});
        expect(res.json().error?.code, `${r.method} ${r.url} as ${session}`).toBe(
          "pin_again_required",
        );
      }
      as("andy", "manager", "passkey");
      const res = await call(r.method as "POST", url, {});
      expect(res.json().error?.code, `${r.method} ${r.url} as passkey`).not.toBe(
        "pin_again_required",
      );
    }
  });

  it("reprinting a receipt asks; the first print and a ticket's reprint don't", async () => {
    as("maya", "bartender", "pin");
    const check = ids["chk_t1"]!;
    const first = await call("POST", `/checks/${check}/receipts`, { channel: "print" });
    expect(first.json().error?.code).not.toBe("pin_again_required");
    await owner.query(
      `insert into print_jobs (venue_id, check_id, kind, station, payload, created_at)
       values ($1, $2, 'receipt', 'bar', '{}'::jsonb, now())`,
      [venueId, check],
    );
    const again = await call("POST", `/checks/${check}/receipts`, { channel: "print" });
    expect(again.json().error?.code).toBe("pin_again_required");
    const text = await call("POST", `/checks/${check}/receipts`, {
      channel: "email",
      to: "guest@example.com",
    });
    expect(text.json().error?.code).not.toBe("pin_again_required");
    const job = (
      await owner.query<{ id: string }>(
        "select id from print_jobs where venue_id = $1 and check_id = $2 and kind = 'receipt' limit 1",
        [venueId, check],
      )
    ).rows[0]!.id;
    expect((await call("POST", `/print-jobs/${job}/reprint`, {})).json().error?.code).toBe(
      "pin_again_required",
    );
    const ticket = (
      await owner.query<{ id: string }>(
        "select id from print_jobs where venue_id = $1 and kind = 'ticket' limit 1",
        [venueId],
      )
    ).rows[0];
    if (ticket)
      expect(
        (await call("POST", `/print-jobs/${ticket.id}/reprint`, {})).json().error?.code,
      ).not.toBe("pin_again_required");
  });

  it("an unticked action stops asking, no-sale included", async () => {
    expect((await tick(["void"])).statusCode).toBe(200);
    as("maya", "bartender", "pin");
    expect((await discount()).statusCode).toBe(201);
    expect((await removeDiscount()).statusCode).toBe(200);
    const drawers = (await call("GET", "/drawers")).json() as { me: { no_sale_pin: boolean } };
    expect(drawers.me.no_sale_pin).toBe(false);
  });

  it("Can also open (P-10): a grant never opens Admin to a PIN session", async () => {
    await owner.query(
      `insert into admin_section_grants (venue_id, membership_id, section, granted_by, granted_at)
       values ($1, $2, 'licenses', $3, now())`,
      [venueId, memberships[ids["maya"]!], ids["abhishek"]],
    );
    as("maya", "bartender", "pin");
    expect((await call("GET", "/licenses")).statusCode).toBe(403);
    as("maya", "bartender", "badge");
    expect((await call("GET", "/licenses")).statusCode).toBe(403);
    as("maya", "bartender", "passkey");
    expect((await call("GET", "/licenses")).statusCode).toBe(200);
  });
});

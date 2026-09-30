import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import {
  FrozenClock,
  SEED_NOW,
  actions,
  defaultPermissions,
  roles,
  type Action,
  type Role,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { route } from "../http/conventions.js";
import type { Principal } from "../http/principal.js";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;

const userIds: Record<Role, string> = {
  owner: randomUUID(),
  manager: randomUUID(),
  bartender: randomUUID(),
  front_desk: randomUUID(),
  staff: randomUUID(),
};

const asRole = (
  role: Role,
  session: "passkey" | "pin" = role === "owner" || role === "manager" ? "passkey" : "pin",
): Principal => ({
  kind: "user",
  userId: userIds[role],
  session,
  memberships: [{ venueId: v.venueA, membershipId: `m-${role}`, role }],
});

const headerAuth = async (request: { headers: Record<string, unknown> }) => {
  const raw = request.headers["x-test-principal"];
  return typeof raw === "string" ? (JSON.parse(raw) as Principal) : undefined;
};

const call = (
  method: "POST" | "GET" | "PATCH" | "PUT",
  path: string,
  principal: Principal,
  payload?: unknown,
) =>
  app.inject({
    method,
    url: `/v1/venues/${v.venueA}${path}`,
    headers: { "x-test-principal": JSON.stringify(principal) },
    payload,
  });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({
    config,
    clock: new FrozenClock(SEED_NOW),
    authenticators: [headerAuth],
    eventsPollMs: 100,
    moduleCacheMs: 0,
    extraRoutes: (a) => {
      // One fixture write per action, open to every staff principal so only the role decides.
      for (const action of actions) {
        a.post(
          `/v1/venues/:venueId/fixture/${action}`,
          {
            config: route({
              principals: ["staff", "owner_manager"],
              module: "core",
              action,
              idempotency: "none",
            }),
          },
          async () => ({ action }),
        );
      }
      a.post(
        "/v1/venues/:venueId/fixture/rooms/cut-off",
        {
          config: route({
            principals: ["staff", "owner_manager"],
            module: "core",
            action: "cutoff.apply",
            idempotency: "none",
          }),
        },
        async () => ({ ok: true }),
      );
      a.post(
        "/v1/venues/:venueId/fixture/pos/sale",
        {
          config: route({
            principals: ["staff", "owner_manager"],
            module: "core",
            action: "pos.use",
            idempotency: "none",
          }),
        },
        async () => ({ ok: true }),
      );
      a.post(
        "/v1/venues/:venueId/fixture/orders/accept",
        {
          config: route({
            principals: ["staff", "owner_manager"],
            module: "core",
            action: "orders.accept",
            idempotency: "none",
          }),
        },
        async () => ({ ok: true }),
      );
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe("roles", () => {
  it("each action in the spec's table, tried as each of the five roles, is allowed or refused exactly as the table says", async () => {
    for (const action of actions) {
      for (const role of roles) {
        const res = await call("POST", `/fixture/${action}`, asRole(role, "passkey"), {});
        const expected = defaultPermissions[action][role] ? 200 : 403;
        expect(res.statusCode, `${action} as ${role}`).toBe(expected);
        if (expected === 403) expect(res.json().error.code).toBe("forbidden");
      }
    }
  });

  it("a runner cutting off a room gets 403 forbidden", async () => {
    const res = await call("POST", "/fixture/rooms/cut-off", asRole("staff"), {});
    expect(res.statusCode).toBe(403);
    expect((await call("POST", "/fixture/rooms/cut-off", asRole("bartender"), {})).statusCode).toBe(
      200,
    );
  });

  it("with the front desk's bar POS switched off, Diego's bar POS and accept-order calls answer 403", async () => {
    const diego = asRole("front_desk");
    expect((await call("POST", "/fixture/pos/sale", diego, {})).statusCode).toBe(200);
    expect((await call("POST", "/fixture/orders/accept", diego, {})).statusCode).toBe(200);
    const owner = asRole("owner");
    expect(
      (await call("PATCH", "/permissions/front_desk/pos.use", owner, { allowed: false }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call("PATCH", "/permissions/front_desk/orders.accept", owner, { allowed: false }))
        .statusCode,
    ).toBe(200);
    expect((await call("POST", "/fixture/pos/sale", diego, {})).statusCode).toBe(403);
    expect((await call("POST", "/fixture/orders/accept", diego, {})).statusCode).toBe(403);
    // Maya's bar POS is untouched, and the effective table shows the change.
    expect((await call("POST", "/fixture/pos/sale", asRole("bartender"), {})).statusCode).toBe(200);
    const table = await call("GET", "/permissions", owner);
    const row = table.json().rows.find((r: { action: string }) => r.action === "pos.use");
    expect(row).toMatchObject({ front_desk: false, bartender: true, switchable: ["front_desk"] });
    // Only the switchable rows can be changed here, and only by an owner (Admin → Team).
    expect(
      (await call("PATCH", "/permissions/staff/cutoff.apply", owner, { allowed: true })).statusCode,
    ).toBe(400);
    expect(
      (await call("PATCH", "/permissions/front_desk/pos.use", asRole("manager"), { allowed: true }))
        .statusCode,
    ).toBe(403);
  });

  it("bartenders, the front desk and runners get 403 on every Admin action, even with a passkey session", async () => {
    for (const role of ["bartender", "front_desk", "staff"] as const) {
      for (const action of [
        "admin.access",
        "admin.payments",
        "admin.team",
        "admin.console",
      ] as const) {
        expect(
          (await call("POST", `/fixture/${action}`, asRole(role, "passkey"), {})).statusCode,
          `${action} as ${role}`,
        ).toBe(403);
      }
      expect(
        (await call("PUT", "/settings/hours", asRole(role, "passkey"), { value: {} })).statusCode,
      ).toBe(403);
    }
  });
});

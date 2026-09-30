import { describe, expect, it } from "vitest";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { route } from "./conventions.js";
import { ApiError } from "./errors.js";
import { page, parseListQuery } from "./paging.js";
import type { Principal } from "./principal.js";
import { assertVersion } from "./version.js";

const clock = new FrozenClock(SEED_NOW);
const owner: Principal = {
  kind: "user",
  userId: "u-andy",
  session: "passkey",
  memberships: [{ venueId: "v-west4", membershipId: "m1", role: "manager" }],
};
const pinUser: Principal = { ...owner, session: "pin" };
const asPrincipal = (p: Principal) => async () => p;

describe("the route registry", () => {
  it("a route with no principals declared fails at start-up", async () => {
    const app = buildApp({
      clock,
      extraRoutes: (a) => {
        a.get("/v1/undeclared", async () => ({}));
      },
    });
    await expect(app.ready()).rejects.toThrow(
      /routes without a registry entry.*GET \/v1\/undeclared/,
    );
  });

  it("lists every declared route with its principals, module and action", async () => {
    const app = buildApp({ clock });
    await app.ready();
    expect(app.routes).toContainEqual(
      expect.objectContaining({
        method: "GET",
        url: "/v1/health",
        principals: ["public"],
        module: "core",
      }),
    );
    await app.close();
  });
});

describe("principals and 403", () => {
  const withRoute = (authenticators: Parameters<typeof buildApp>[0]["authenticators"]) =>
    buildApp({
      clock,
      authenticators,
      extraRoutes: (a) => {
        a.get(
          "/v1/venues/:venueId/team",
          { config: route({ principals: ["owner_manager"], module: "core", action: "team.read" }) },
          async () => ({ team: [] }),
        );
        a.get(
          "/v1/public/menu",
          { config: route({ principals: ["public"], module: "core" }) },
          async () => ({ menu: [] }),
        );
        a.get(
          "/v1/public/r/:code",
          { config: route({ principals: ["public"], module: "core", tokenRoute: true }) },
          async () => ({ ok: true }),
        );
      },
    });

  it("an anonymous caller gets 403 forbidden on a staff route, in the error shape", async () => {
    const app = withRoute([]);
    const res = await app.inject({ method: "GET", url: "/v1/venues/v-west4/team" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: "forbidden", message: expect.any(String), retryable: false },
    });
    await app.close();
  });

  it("a manager's passkey session passes at their venue and not at another; a PIN session never opens Admin routes", async () => {
    const app = withRoute([asPrincipal(owner)]);
    expect((await app.inject({ method: "GET", url: "/v1/venues/v-west4/team" })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "GET", url: "/v1/venues/v-other/team" })).statusCode).toBe(
      403,
    );
    await app.close();
    const pin = withRoute([asPrincipal(pinUser)]);
    expect((await pin.inject({ method: "GET", url: "/v1/venues/v-west4/team" })).statusCode).toBe(
      403,
    );
    await pin.close();
  });

  it("public routes answer anyone, and token routes send no-referrer and no-store", async () => {
    const app = withRoute([]);
    expect((await app.inject({ method: "GET", url: "/v1/public/menu" })).statusCode).toBe(200);
    const token = await app.inject({ method: "GET", url: "/v1/public/r/abc" });
    expect(token.headers["referrer-policy"]).toBe("no-referrer");
    expect(token.headers["cache-control"]).toBe("no-store");
    await app.close();
  });
});

describe("every response", () => {
  it("carries server_time and min_client_version, in the body and the headers", async () => {
    const app = buildApp({ clock });
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.json()).toMatchObject({
      ok: true,
      server_time: "2026-09-25T22:41:00-04:00",
      min_client_version: "0.0.0",
    });
    expect(res.headers["x-server-time"]).toBe("2026-09-25T22:41:00-04:00");
    expect(res.headers["x-min-client-version"]).toBe("0.0.0");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const missing = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "not_found" },
      server_time: "2026-09-25T22:41:00-04:00",
    });
    await app.close();
  });
});

describe("errors", () => {
  it("map codes to statuses and retryable flags", () => {
    expect(new ApiError("module_off", "x").status).toBe(404);
    expect(new ApiError("version_conflict", "x").status).toBe(409);
    expect(new ApiError("key_reused", "x").status).toBe(422);
    expect(new ApiError("approval_pending", "x").status).toBe(202);
    expect(new ApiError("reader_offline", "x").retryable).toBe(true);
    expect(new ApiError("cut_off", "x").retryable).toBe(false);
    expect(new ApiError("over_amount_due", "x").toBody()).toEqual({
      error: { code: "over_amount_due", message: "x", retryable: false },
    });
  });

  it("assertVersion answers 409 version_conflict with the current version", () => {
    expect(() => assertVersion(3, 3)).not.toThrow();
    expect(() => assertVersion(4, 3, "the check")).toThrow(ApiError);
    try {
      assertVersion(4, 3, "the check");
    } catch (e) {
      expect((e as ApiError).code).toBe("version_conflict");
      expect((e as ApiError).details).toEqual({ version: 4 });
    }
    expect(() => assertVersion(4, undefined)).toThrow(/If-Match is required/);
  });
});

describe("lists", () => {
  it("a list of 250 items returns 100 and a cursor to the next page", () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ id: String(i + 1).padStart(4, "0") }));
    const q = parseListQuery({});
    expect(q.limit).toBe(100);
    const first = page(all.slice(0, q.limit + 1), q.limit, (x) => x.id);
    expect(first.items).toHaveLength(100);
    expect(first.next_cursor).toBe("0100");
    const after = all.filter((x) => x.id > first.next_cursor!);
    const second = page(after.slice(0, q.limit + 1), q.limit, (x) => x.id);
    expect(second.items[0]?.id).toBe("0101");
    expect(second.next_cursor).toBe("0200");
    const third = page(all.filter((x) => x.id > "0200").slice(0, 101), 100, (x) => x.id);
    expect(third.items).toHaveLength(50);
    expect(third.next_cursor).toBeNull();
  });

  it("caps limit at 100, reads status and state, and rejects a bad limit", () => {
    expect(parseListQuery({ limit: "500", status: "open" })).toEqual({
      after: undefined,
      limit: 100,
      status: "open",
      state: undefined,
    });
    expect(parseListQuery({ limit: "25", after: "x", state: "ringing" }).limit).toBe(25);
    expect(() => parseListQuery({ limit: "0" })).toThrow(ApiError);
  });
});

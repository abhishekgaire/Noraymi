import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { route } from "../http/conventions.js";
import { suiteWorld, type SuiteWorld } from "./setup.js";
import { runRouteWalls } from "./wall-suite.js";

/**
 * The suites catch what they're for (M1-37): a route that skips the venue
 * check shows up as a leak, and a route without a registry entry stops the
 * app from starting at all, so CI fails either way.
 */
let world: SuiteWorld;

beforeAll(async () => {
  world = await suiteWorld();
});

afterAll(async () => {
  await world.close();
});

describe("planted leaks", () => {
  it("a route that reads a row without the venue context is reported by the wall suite", async () => {
    const app = buildApp({
      ...world.appOptions,
      extraRoutes: (a) => {
        a.get<{ Params: { venueId: string; m: string } }>(
          "/v1/venues/:venueId/leak/:m",
          { config: route({ principals: ["owner_manager"], module: "core" }) },
          async (request) => {
            // The leak: the owner's connection, no venue context, any venue's row.
            const r = await world.owner.query("select id, role from memberships where id = $1", [
              request.params.m,
            ]);
            return r.rows[0] ?? {};
          },
        );
      },
    });
    await app.ready();
    try {
      const { findings } = await runRouteWalls(app, world.cast, world.fixtures);
      expect(findings.map((f) => f.where)).toContain("GET /v1/venues/:venueId/leak/:m");
      expect(findings.find((f) => f.where === "GET /v1/venues/:venueId/leak/:m")?.why).toMatch(
        /venue B's row answered 200/,
      );
    } finally {
      await app.close();
    }
  });

  it("a route without principals never starts: the registry refuses the app", async () => {
    const app = buildApp({
      ...world.appOptions,
      extraRoutes: (a) => {
        a.get("/v1/venues/:venueId/undeclared", async () => ({ ok: true }));
      },
    });
    await expect(app.ready()).rejects.toThrow(/routes without a registry entry/);
    await app.close().catch(() => {});
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { runPrincipalSuite, type PrincipalSuiteResult } from "./principal-suite.js";
import { suiteWorld, type SuiteWorld } from "./setup.js";

/**
 * The principal suite (M1-37): every route as every principal. Run on every
 * pull request by CI's "principals" job; `pnpm test:principals` locally.
 */
let world: SuiteWorld;
let result: PrincipalSuiteResult;

beforeAll(async () => {
  world = await suiteWorld();
  const app = buildApp(world.appOptions);
  await app.ready();
  result = await runPrincipalSuite(app, world.cast);
  await app.close();
});

afterAll(async () => {
  await world.close();
});

describe("every route as every principal", () => {
  it("answers 401 or 403 to every principal a route doesn't declare", () => {
    const undeclared = result.findings.filter((f) => !f.why.startsWith("an Admin route"));
    expect(
      undeclared,
      undeclared.map((f) => `${f.route} as ${f.principal} → ${f.status}: ${f.why}`).join("\n"),
    ).toEqual([]);
    expect(result.rows.length).toBeGreaterThan(500);
    expect(result.rows.filter((r) => r.declared).length).toBeGreaterThan(50);
  });

  it("no PIN session and no badge session reaches any Admin route", () => {
    const admin = result.findings.filter((f) => f.why.startsWith("an Admin route"));
    expect(
      admin,
      admin.map((f) => `${f.route} as ${f.principal} → ${f.status}`).join("\n"),
    ).toEqual([]);
    expect(result.adminAssertions.length).toBeGreaterThan(20);
    expect(result.adminAssertions).toContain(
      "POST /v1/venues/:venueId/team/invite as staff with a PIN on a shared device → 403",
    );
    expect(result.adminAssertions).toContain(
      "GET /v1/venues/:venueId/team as a badge session → 403",
    );
  });

  it("covers every route in the registry (a WebSocket route is the one kind it skips)", () => {
    expect(result.skipped.every((s) => s.includes("WebSocket"))).toBe(true);
  });
});

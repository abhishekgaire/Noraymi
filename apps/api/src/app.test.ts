import { describe, expect, it } from "vitest";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "./app.js";

describe("GET /v1/health", () => {
  it("answers ok with the server time in New York time", async () => {
    const app = buildApp({ clock: new FrozenClock(SEED_NOW) });
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, server_time: "2026-09-25T22:41:00-04:00" });
    await app.close();
  });

  it("has no clock control without the staging switch", async () => {
    const app = buildApp({ clock: new FrozenClock(SEED_NOW) });
    const response = await app.inject({
      method: "POST",
      url: "/v1/ops/clock",
      payload: { server_time: null },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

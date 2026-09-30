import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("GET /v1/health", () => {
  it("answers ok with the server time", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; server_time: string }>();
    expect(body.ok).toBe(true);
    expect(body.server_time).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    await app.close();
  });
});

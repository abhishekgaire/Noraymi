import { expect, test } from "@playwright/test";

test("the API answers /v1/health", async ({ request }) => {
  const response = await request.get("/v1/health");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { ok: boolean; server_time: string };
  expect(body.ok).toBe(true);
  expect(body.server_time).toMatch(/Z$/);
});

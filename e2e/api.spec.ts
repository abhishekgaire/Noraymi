import { expect, test } from "@playwright/test";

test("the API answers /v1/health", async ({ request }) => {
  const response = await request.get("/v1/health");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { ok: boolean; server_time: string };
  expect(body.ok).toBe(true);
  expect(body.server_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test("after a fresh seed load, server_time is Fri Sep 25, 2026, 10:41 PM in New York", async ({
  request,
}) => {
  const body = (await (await request.get("/v1/health")).json()) as { server_time: string };
  // The simulated clock ticks on from 10:41:00 PM, so the minutes may have moved a little.
  expect(body.server_time).toMatch(/^2026-09-25T22:4\d:\d{2}-04:00$/);
});

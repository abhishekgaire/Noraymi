import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import pg from "pg";

test("the guest web opens", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Guest web");
});

/**
 * The waitlist page behind the door QR (M2-25), on a phone, from a fresh load
 * of the demo seed: a party of 4 joins fourth and reads "3 parties ahead",
 * then leaves.
 */
test("the door QR on a phone: a party of 4 joins fourth, 3 parties ahead, then leaves", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  execSync("pnpm seed", { stdio: "ignore" });
  expect(
    (
      await request.post("http://127.0.0.1:3000/v1/ops/clock", {
        data: { server_time: "2026-09-26T02:41:00Z" },
      })
    ).ok(),
  ).toBe(true);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    const slug = (await db.query<{ slug: string }>("select slug from venues limit 1")).rows[0]!
      .slug;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/v/${slug}/waitlist`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Join the waitlist");
    await page.getByLabel("Your name").fill("Jordan L.");
    await page.getByLabel("Mobile number").fill("(212) 555-0145");
    await page.getByLabel("How many of you").fill("4");
    await page.getByRole("button", { name: "Join the waitlist" }).click();
    await expect(page).toHaveURL(/\/w\/[A-Za-z0-9_-]{22}$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("West 4 Boho Karaoke");
    await expect(page.getByRole("status")).toHaveText("3 parties ahead");
    await expect(page.getByText("Jordan L. · party of 4")).toBeVisible();
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "Leave the waitlist" }).click();
    await expect(page.getByRole("status")).toHaveText("You've left the waitlist.");
  } finally {
    await db.end();
  }
});

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import pg from "pg";

/**
 * Every test starts from a fresh load of the demo seed at 10:41 PM, whatever
 * the test before it did (M2-35): the seed's tables, and the API's simulated
 * clock.
 */
test.beforeEach(async ({ request }) => {
  execSync("pnpm seed", { stdio: "ignore" });
  const clock = await request.post("http://127.0.0.1:3000/v1/ops/clock", {
    data: { server_time: "2026-09-26T02:41:00Z" },
  });
  expect(clock.ok()).toBe(true);
});

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

/**
 * Joining a room on a phone (M3-08; screens N3), from a fresh load of the
 * demo seed: Marcus T.'s Room code link joins him as Room 9's host; a friend
 * types a wrong code, is told so, then joins with KX4M7; Room 11 has nobody
 * in it and says it's closed.
 */
test("joining a room on a phone: the host link, a wrong code, KX4M7, and a closed room", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    const roomId = async (name: string) =>
      (await db.query<{ id: string }>("select id from rooms where name = $1", [name])).rows[0]!.id;
    const phone = async () =>
      (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();

    const marcus = await phone();
    const hostToken = createHash("sha256")
      .update("host-token:sess_room9")
      .digest("base64url")
      .slice(0, 32);
    await marcus.goto(`/r/${hostToken}`);
    await expect(marcus.getByRole("heading", { level: 1 })).toHaveText("Room 9 · Code KX4M7");
    await expect(marcus.getByText("You're the host")).toBeVisible();
    await marcus.context().close();

    const friend = await phone();
    await friend.goto(`/v/west4karaoke/room/${await roomId("Room 9")}`);
    await expect(friend.getByRole("heading", { level: 1 })).toHaveText("Join Room 9");
    await friend.getByLabel("Room code").fill("QQQQQ");
    await friend.getByRole("button", { name: "Join" }).click();
    // Next's route announcer is an alert too, so the refusal is found by its words.
    await expect(friend.getByRole("alert").filter({ hasText: "That code isn't right" })).toHaveText(
      "That code isn't right. Check the code on the wall.",
    );
    await friend.getByLabel("Room code").fill("kx4m7");
    await friend.getByRole("button", { name: "Join" }).click();
    await expect(friend.getByRole("heading", { level: 1 })).toHaveText("Room 9 · Code KX4M7");
    await expect(friend.getByText("You're in")).toBeVisible();
    const cookie = (await friend.context().cookies()).find((c) => c.name === "west4_room");
    expect(cookie?.httpOnly).toBe(true);
    await friend.context().close();

    const closed = await phone();
    await closed.goto(`/v/west4karaoke/room/${await roomId("Room 11")}`);
    await expect(closed.getByRole("status")).toHaveText("Room 11 is closed right now.");
    await closed.context().close();
  } finally {
    await db.end();
  }
});

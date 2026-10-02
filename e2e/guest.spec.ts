import { createHash, randomBytes } from "node:crypto";
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

/**
 * The room page on a phone (M3-09; screens Order notes 1, 2 and 13): a friend
 * in Room 9 orders 2 × Margarita · Peach (the flavor asked first; Hoegaarden
 * 86'd and greyed), and reads each of the guest's words as the bar, driven
 * through the API as Maya, asks the room to wait, accepts, marks it ready,
 * and a runner takes it and delivers it. Cancel shows only while it rings or
 * waits.
 */
test("the room page on a phone: order 2 × Margarita · Peach and follow it in the guest's words", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    // Maya's session at the bar, made directly so the test can drive the bar through the API.
    const token = randomBytes(24).toString("base64url");
    const maya = (
      await db.query<{ user_id: string; id: string; venue_id: string }>(
        "select m.user_id, m.id, m.venue_id from memberships m join users u on u.id = m.user_id where u.name like 'Maya%'",
      )
    ).rows[0]!;
    await db.query(
      `insert into auth_sessions (principal, user_id, membership_id, assurance, client, token_hash, started_at, last_seen_at, expires_at)
       values ('staff', $1, $2, 'pin', 'web', $3, '2026-09-25T22:41:00-04:00', '2026-09-25T22:41:00-04:00', '2026-09-26T06:00:00-04:00')`,
      [maya.user_id, maya.id, createHash("sha256").update(token).digest("hex")],
    );
    const bar = async (orderId: string, step: string) =>
      expect(
        (
          await request.post(
            `http://127.0.0.1:3000/v1/venues/${maya.venue_id}/orders/${orderId}/${step}`,
            { headers: { authorization: `Bearer ${token}` }, data: {} },
          )
        ).status(),
        step,
      ).toBe(200);

    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    const page = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    await page.goto(`/v/west4karaoke/room/${room9}`);
    await page.getByLabel("Room code").fill("KX4M7");
    await page.getByRole("button", { name: "Join" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room 9 · Code KX4M7");

    // Hoegaarden is 86'd tonight: greyed in its place, and it can't be added.
    const hoe = page.getByRole("button", { name: "Hoegaarden · 86'd tonight" });
    await expect(hoe).toBeDisabled();

    // The flavor is asked before adding, twice for two.
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "Margarita · $13.00" }).click();
      const sheet = page.getByRole("dialog", { name: "Margarita" });
      await expect(sheet).toContainText("Which one? The bar gets it on the ticket.");
      await sheet.getByLabel("Peach").check();
      await sheet.getByRole("button", { name: "Add" }).click();
    }
    const cart = page.getByRole("region", { name: "Your order · not sent yet" });
    await expect(cart).toContainText("2 × Margarita · Peach");
    await cart.getByRole("button", { name: "Send 2 to the bar · $26.00" }).click();

    const order = page.locator(".order").first();
    await expect(order).toContainText("2 × Margarita · Peach");
    await expect(order.locator(".status")).toHaveText("Sent to the bar · you can still cancel");
    await expect(order.getByRole("button", { name: "Cancel" })).toBeVisible();
    const orderId = (
      await db.query<{ id: string }>(
        "select id from orders where source = 'room' and room_guest_id is not null order by placed_at desc limit 1",
      )
    ).rows[0]!.id;

    const steps: [string, string, boolean][] = [
      ["hold", "The bar needs a few minutes", true],
      ["accept", "Being made · on your tab", false],
      ["ready", "Being made · on your tab", false],
      ["claim", "On its way to Room 9", false],
      ["deliver", "Delivered", false],
    ];
    for (const [step, words, cancel] of steps) {
      await bar(orderId, step);
      await expect(order.locator(".status")).toHaveText(words, { timeout: 15_000 });
      await expect(order.getByRole("button", { name: "Cancel" })).toHaveCount(cancel ? 1 : 0);
    }
    await page.context().close();
  } finally {
    await db.end();
  }
});

/**
 * Tonight so far, Call staff and the host lock on the room page (M3-10;
 * screens Order notes 11 to 13): Room 9 reads $322.00 for 161 minutes, $158.00
 * of drinks and $480.00 so far, with the $120 deposit and "Stay on by the
 * minute until we close at 4 AM"; Room 3 is asked to wrap up for 11 PM; a call
 * for another mic reads "Staff get it on their phones"; and with Marcus's
 * lock on, a friend reads that Marcus has locked ordering.
 */
test("the room page on a phone: tonight so far, the stay and wrap-up lines, Call staff and the host lock", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    const hostToken = (slug: string) =>
      createHash("sha256").update(`host-token:${slug}`).digest("base64url").slice(0, 32);
    const phone = async () =>
      (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();

    const marcus = await phone();
    await marcus.goto(`/r/${hostToken("sess_room9")}`);
    const bill = marcus.getByRole("region", { name: "Tonight so far" });
    await expect(bill).toContainText("Room time · 161 min$322.00");
    await expect(bill).toContainText("Drinks on your tab$158.00");
    await expect(bill).toContainText("Tab so far$480.00");
    await expect(bill).toContainText("Before tax and gratuity · $2.00 a minute for 12");
    await expect(bill).toContainText("Your $120.00 deposit comes off when you settle up");
    await expect(bill).toContainText("Stay on by the minute until we close at 4 AM");
    await expect(bill).not.toContainText("Margarita");

    await marcus.getByRole("button", { name: "Another mic" }).click();
    await expect(marcus.getByText("Staff get it on their phones")).toBeVisible();

    const room3 = await phone();
    await room3.goto(`/r/${hostToken("sess_room3")}`);
    await expect(room3.getByRole("region", { name: "Tonight so far" })).toContainText(
      "The next party has this room at 11 PM · please start wrapping up",
    );
    await room3.context().close();

    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    const friend = await phone();
    await friend.goto(`/v/west4karaoke/room/${room9}`);
    await friend.getByLabel("Room code").fill("KX4M7");
    await friend.getByRole("button", { name: "Join" }).click();
    await expect(friend.getByRole("heading", { level: 1 })).toHaveText("Room 9 · Code KX4M7");

    // The switch follows the server: it turns on once the lock is saved.
    await marcus.getByLabel(/Lock ordering/).click();
    await expect(marcus.getByLabel(/Lock ordering/)).toBeChecked();
    await friend.reload();
    await expect(
      friend.getByText("Marcus has locked ordering · ask them to send it"),
    ).toBeVisible();
    await friend.getByRole("button", { name: "Bud Light · $8.00" }).click();
    await expect(
      friend.getByRole("region", { name: "Your order · not sent yet" }).getByRole("button", {
        name: /^Send/,
      }),
    ).toBeDisabled();
    await friend.context().close();
    await marcus.context().close();
  } finally {
    await db.end();
  }
});

import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { SEED_COMMAND, setClock } from "./night.js";
import { API, DB, esc, GUEST, PAY } from "./stack.js";

// Put the shared clock back for whatever spec runs next, in this project or another.
test.afterEach(async () => {
  await setClock();
});

/**
 * Every test starts from a fresh load of the demo seed at 10:41 PM, whatever
 * the test before it did (M2-35): the seed's tables, and the API's simulated
 * clock.
 */
test.beforeEach(async ({ request }) => {
  execSync(SEED_COMMAND, { stdio: ["ignore", "ignore", "pipe"] });
  const clock = await request.post(`${API}/v1/ops/clock`, {
    data: { server_time: "2026-09-26T02:41:00Z" },
  });
  expect(clock.ok()).toBe(true);
});

/**
 * West 4's site (M5-01; screens Main, Rooms, Parties) at Fri Sep 25, 10:41 PM:
 * open until 4 AM, the price wording, the Rooms picker, the songbook with its
 * count and no search, and every page readable with JavaScript off.
 */
test("the site: open until 4 AM, the prices, the rooms picker and the songbook", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lose your voice.");
  await expect(page.locator(".hero .open-line")).toHaveText("Open now · until 4 AM");
  const rooms = page.getByRole("region", { name: "14 rooms. Three to forty." });
  await expect(rooms).toContainText("$10 a person an hour, plus tax and a 20% gratuity");
  await expect(rooms).toContainText("VIP room $250 an hour");
  await expect(page.getByRole("heading", { name: "113,000 songs." })).toBeVisible();
  await expect(page.getByText("113,000 songs in the rooms")).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  // Sing at the bar opens the singer's queue page (M6-20).
  await expect(page.getByRole("heading", { name: "Sing at the bar." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Join the queue" })).toHaveAttribute(
    "href",
    "/v/west4karaoke/sing",
  );

  // The picker: 3 guests on a Friday fit a small room billed for 4.
  await rooms.getByRole("link", { name: "One fewer" }).click();
  await expect(page).toHaveURL(/guests=3#rooms$/);
  await expect(page.locator("#rooms .fit")).toContainText("A small room fits you");
  await expect(page.locator("#rooms .fit")).toContainText(
    "$40 an hour · tonight bills at least 4 guests",
  );
});

test("the site with JavaScript off still reads, and the parties page estimates a night", async ({
  browser,
}) => {
  const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lose your voice.");
  await expect(page.locator(".hero .open-line")).toHaveText("Open now · until 4 AM");
  await page.goto("/v/west4karaoke/parties?guests=12&hours=3");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your night. Your door.");
  const estimate = page.getByRole("region", { name: "Rough room cost" });
  await expect(estimate).toContainText("Room time$360");
  await expect(estimate).toContainText("Tax 8.875%$31.95");
  await expect(estimate).toContainText("Gratuity 20%$72");
  await expect(estimate).toContainText("Room time, all in$463.95");
  await page.context().close();
});

/**
 * The domain move (M9-09): every page the old west4karaoke.com listed answers on
 * the new site, the old booking page goes to Book, and an old manage link's page
 * gives West 4's number.
 */
test("every old west4karaoke.com page answers, and the old booking page goes to Book", async ({
  request,
  page,
}) => {
  for (const url of ["/", "/menu", "/menu?menu=menu", "/room", "/reservation"]) {
    const first = await request.get(url, { maxRedirects: 0 });
    expect([200, 301, 302], url).toContain(first.status());
    const final = await request.get(url);
    expect(final.status(), url).toBe(200);
  }
  const old = await request.get("/reservation", { maxRedirects: 0 });
  expect(old.status()).toBe(301);
  expect(new URL(old.headers()["location"] ?? "", "http://x").pathname).toBe("/book");
  await page.goto("/booking-moved");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "This link is from our old website",
  );
});

test("all in, and booking off: every price line changes, and the hero reads Call to book", async ({
  page,
}) => {
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  try {
    await db.query(
      `update venue_settings set value = '{"priceWording": "allIn"}' where key = 'website'`,
    );
    await db.query("update venue_modules set state = 'off' where module_id = 'online_booking'");
    await page.goto("/");
    const rooms = page.getByRole("region", { name: "14 rooms. Three to forty." });
    await expect(rooms).toContainText("$12.89 a person an hour, tax and the 20% gratuity included");
    await expect(rooms).toContainText("VIP room $322.19 an hour, tax and gratuity included");
    await expect(page.getByText("a person an hour, plus tax")).toHaveCount(0);
    await expect(
      page.locator(".hero").getByRole("link", { name: /^Call to book/ }),
    ).toHaveAttribute("href", "tel:+12122550011");
    await expect(page.locator(".hero")).toContainText("Call to book · (212) 255-0011");
    await expect(
      page.getByRole("navigation").getByRole("link", { name: "Call to book" }),
    ).toHaveAttribute("href", "tel:+12122550011");
    await expect(page.getByRole("link", { name: "Book a room" })).toHaveCount(0);
  } finally {
    await db.end();
  }
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
      await request.post(`${API}/v1/ops/clock`, {
        data: { server_time: "2026-09-26T02:41:00Z" },
      })
    ).ok(),
  ).toBe(true);
  const db = new pg.Client({
    connectionString: DB,
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
    await expect(
      page.getByRole("link", { name: "Sing at the bar while you wait" }),
    ).toHaveAttribute("href", `/v/${slug}/sing`);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "Leave the waitlist" }).click();
    await expect(page.getByRole("status")).toHaveText("You've left the waitlist.");
  } finally {
    await db.end();
  }
});

/**
 * The singer's queue page on a phone (M6-20; screens N9): Ben T. signs in on his number with a code
 * and reads "2 singers before you"; Sofia R.'s song needs a drink credit; a new singer joins with a
 * code and queues "Valerie" typed by hand, with no songbook loaded. No page shows a phone number but
 * the singer's own (and the page never prints even that).
 */
test("the singer's queue page: Ben T. 2 singers before you, Sofia R. needs a drink credit, a new singer queues Valerie", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  const codeFor = async (phone: string) => {
    await expect
      .poll(
        async () =>
          (
            await db.query("select 1 from jobs where kind = 'text.send' and payload->>'to' = $1", [
              phone,
            ])
          ).rowCount,
      )
      .toBeGreaterThan(0);
    return (
      await db.query<{ code: string }>(
        `select payload->'data'->>'code' as code from jobs where kind = 'text.send'
           and payload->>'to' = $1 order by created_at desc limit 1`,
        [phone],
      )
    ).rows[0]!.code;
  };
  const join = async (name: string, typed: string, e164: string) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/v/west4karaoke/sing");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sing at the bar");
    await expect(page.getByRole("heading", { name: "Join the queue" })).toBeVisible();
    await page.getByLabel("Your name on the TV").fill(name);
    await page.getByLabel("Mobile number").fill(typed);
    await page.getByRole("button", { name: "Text me a code" }).click();
    await page.getByLabel("The code we texted you").fill(await codeFor(e164));
    await page.getByRole("button", { name: "Confirm" }).click();
    return { context, page };
  };
  try {
    // Ben T. is the seed's phone demo: place 3, with Jess P. and Kira before him.
    const ben = await join("Ben", "(646) 555-0163", "+16465550163");
    await expect(ben.page.getByRole("status")).toHaveText("2 singers before you");
    await expect(ben.page.getByRole("heading", { name: "Ben T." })).toBeVisible();
    await expect(ben.page.getByText("Livin' on a Prayer · Bon Jovi")).toBeVisible();
    await expect(ben.page.locator(".credits dd")).toHaveText("1");
    await expect(ben.page.getByText("Luis M.")).toBeVisible();
    expect(await ben.page.locator("body").innerText()).not.toMatch(/555|\+1\d{10}/);
    const scroll = await ben.page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(390);
    await ben.context.close();

    const sofia = await join("Sofia R.", "347-555-0195", "+13475550195");
    await expect(sofia.page.getByRole("status")).toHaveText("5 singers before you");
    await expect(sofia.page.getByText("Needs a drink credit")).toBeVisible();
    await sofia.context.close();

    // A new singer, with no songbook: they type the title and artist.
    const priya = await join("Priya", "(646) 555-0177", "+16465550177");
    await expect(priya.page.getByRole("status")).toHaveText("Add a song to get in line.");
    await expect(priya.page.getByRole("searchbox")).toHaveCount(0);
    await priya.page.getByLabel("Song title").fill("Valerie");
    await priya.page.getByLabel("Artist (optional)").fill("Amy Winehouse");
    await priya.page.getByRole("button", { name: "Add to the queue" }).click();
    await expect(priya.page.getByText("Valerie · Amy Winehouse")).toBeVisible();
    await expect(priya.page.getByRole("status")).toHaveText("6 singers before you");
    expect(await priya.page.locator("body").innerText()).not.toMatch(/555|\+1\d{10}/);
    await priya.context.close();
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
    connectionString: DB,
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
    connectionString: DB,
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
          await request.post(`${API}/v1/venues/${maya.venue_id}/orders/${orderId}/${step}`, {
            headers: { authorization: `Bearer ${token}` },
            data: {},
          })
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
    connectionString: DB,
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

/**
 * Same again on the room page (M3-11; screens N7): once o3 is delivered,
 * Room 3's phone lists its round for $39.00 and one tap orders it again;
 * with Strawberry 86'd tonight the round is offered without it, and says so.
 */
test("Same again on a phone: Room 3's round for $39.00, ordered again, and without what's 86'd", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  try {
    await db.query(
      "update orders set status = 'delivered', delivered_at = '2026-09-25T22:40:00-04:00' where id = (select row_id from seed_ids where slug = 'order_o3')",
    );
    const token = createHash("sha256")
      .update("host-token:sess_room3")
      .digest("base64url")
      .slice(0, 32);
    const page = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    await page.goto(`/r/${token}`);
    const again = page.getByRole("region", { name: "Same again" });
    await expect(again).toContainText("2 × Margarita · Peach, 1 × Margarita · Strawberry · $39.00");
    await again.getByRole("button", { name: "Order this again" }).click();
    const order = page.locator(".order").first();
    await expect(order.locator(".status")).toHaveText("Sent to the bar · you can still cancel");
    const placed = await db.query<{ n: number }>(
      "select count(*)::int as n from orders where same_again_of = (select row_id from seed_ids where slug = 'order_o3') and status = 'ringing'",
    );
    expect(placed.rows[0]!.n).toBe(1);

    await db.query(
      `update menu_options set out_until = '2026-09-26T10:00:00Z'
        where name = 'Strawberry' and item_id = (select id from menu_items where name = 'Margarita')`,
    );
    await page.reload();
    await expect(again).toContainText("2 × Margarita · Peach · $26.00");
    await expect(again).toContainText("Without Margarita · Strawberry · 86'd tonight");
    await page.context().close();
  } finally {
    await db.end();
  }
});

/**
 * Room tablets in kiosk mode (M3-12; screens N4), paired with codes from
 * Admin → Devices: Room 11's reads "Room available" and offers nothing to
 * order; Room 9's shows the clock and $480.00 so far, and an order from it
 * rings at the bar as the tablet. No tablet shows a PIN pad or a help link.
 */
test("room tablets on a tablet: Room 11 available, Room 9's clock, $480.00 and an order", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  try {
    const pairCode = async (room: string) => {
      const code = randomBytes(4).toString("hex").toUpperCase();
      await db.query(
        `insert into device_pairing_codes (venue_id, code_hash, kind, name, room_id, expires_at)
         select r.venue_id, $1, 'room_tablet', 'Tablet · ' || r.name, r.id, now() + interval '1 hour'
           from rooms r where r.name = $2`,
        [createHash("sha256").update(code).digest("hex"), room],
      );
      return code;
    };
    const tablet = async (room: string) => {
      const page = await (
        await browser.newContext({ viewport: { width: 1024, height: 768 } })
      ).newPage();
      await page.goto("/tablet");
      await page.getByLabel("Pairing code from Admin → Devices").fill(await pairCode(room));
      await page.getByRole("button", { name: "Pair" }).click();
      return page;
    };

    const room11 = await tablet("Room 11");
    await expect(room11.getByRole("heading", { level: 1 })).toHaveText("Room 11");
    await expect(room11.getByRole("status")).toHaveText("Room available");
    await expect(room11.getByRole("main").getByRole("button")).toHaveCount(0);
    await room11.context().close();

    const room9 = await tablet("Room 9");
    await expect(room9.getByRole("heading", { level: 1 })).toHaveText("Room 9 · Code KX4M7");
    const bill = room9.getByRole("region", { name: "Tonight so far" });
    await expect(bill).toContainText("Room time · 161 min$322.00");
    await expect(bill).toContainText("Tab so far$480.00");
    await room9.getByRole("button", { name: "Bud Light · $8.00" }).click();
    await room9.getByRole("button", { name: "Send 1 to the bar · $8.00" }).click();
    await expect(
      room9.locator(".order", { hasText: "1 × Bud Light" }).locator(".status"),
    ).toHaveText("Sent to the bar · you can still cancel");
    const rang = await db.query<{ name: string; status: string }>(
      `select g.name, o.status from orders o join room_guests g on g.id = o.room_guest_id
        where o.source = 'room' order by o.placed_at desc limit 1`,
    );
    expect(rang.rows[0]).toEqual({ name: "Tablet · Room 9", status: "ringing" });
    // Kiosk: no PIN pad, no private help link, and no host lock switch.
    await expect(room9.locator(".keypad")).toHaveCount(0);
    await expect(room9.getByText(/manager, privately/i)).toHaveCount(0);
    await expect(room9.getByLabel(/Lock ordering/)).toHaveCount(0);
    await room9.context().close();
  } finally {
    await db.end();
  }
});

/**
 * The alcohol window on the room page (M3-20): at 4:00 AM the guest's menu
 * hides alcohol and says why, while a Red Bull can still be ordered.
 */
test("at 4:00 AM the room page hides alcohol and says why; a Red Bull still orders", async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  expect(
    (
      await request.post(`${API}/v1/ops/clock`, {
        data: { server_time: "2026-09-26T08:00:30Z" },
      })
    ).ok(),
  ).toBe(true);
  const token = createHash("sha256")
    .update("host-token:sess_room9")
    .digest("base64url")
    .slice(0, 32);
  const page = await (
    await browser.newContext({ viewport: { width: 390, height: 844 } })
  ).newPage();
  await page.goto(`/r/${token}`);
  await expect(page.getByText("The bar has stopped serving alcohol for tonight")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Bud Light/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Margarita/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Red Bull · $6.00" }).click();
  await page.getByRole("button", { name: "Send 1 to the bar · $6.00" }).click();
  await expect(page.locator(".order", { hasText: "1 × Red Bull" }).locator(".status")).toHaveText(
    "Sent to the bar · you can still cancel",
  );
  await page.context().close();
});

/**
 * The payment page on its own origin (M4-15; Security 1), against the fake
 * Stripe: only on the pay. hostname, a nonce CSP that frames nothing and is
 * framed by nothing, no service worker, a reload that keeps the same
 * PaymentIntent, a wrong token that finds nothing, and a test card that pays.
 */
test("the payment page: its own origin, strict headers, one PaymentIntent, paid with a test card", async ({
  page,
}) => {
  test.setTimeout(90_000);
  execSync("pnpm exec tsx src/stripe/seed-stripe.ts", {
    cwd: "apps/api",
    stdio: "ignore",
    env: {
      ...process.env,
      WEST4_ENV: "local",
      DATABASE_URL: DB,
    },
  });
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  try {
    const token = randomBytes(16).toString("base64url");
    await db.query(
      `insert into pay_links (venue_id, token_hash, check_id, amount_cents, expires_at, purpose)
       select c.venue_id, $1, c.id, 2500, now() + interval '1 day', 'balance'
         from checks c join seed_ids s on s.row_id = c.id where s.slug = 'chk_room9'`,
      [createHash("sha256").update(token).digest("hex")],
    );
    // Not on the guest site's own hostname.
    expect((await page.goto(`/pay/${token}`))?.status()).toBe(404);

    const url = `${PAY}/pay/${token}`;
    const r = await page.goto(url);
    expect(r?.status()).toBe(200);
    const h = r!.headers();
    expect(h["cross-origin-opener-policy"]).toBe("same-origin");
    expect(h["referrer-policy"]).toBe("no-referrer");
    // Next's dev server says no-cache on a dynamic page; the production build says no-store.
    expect(h["cache-control"]).toMatch(/no-store|no-cache/);
    expect(h["content-security-policy"]).toMatch(/script-src[^;]*'nonce-/);
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pay $25.00");
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations())).toHaveLength(0);

    const intentOf = async () =>
      (
        await db.query<{ pi: string | null }>(
          `select p.stripe_pi_id as pi from pay_links l join payments p on p.id = l.payment_id
            where l.token_hash = $1`,
          [createHash("sha256").update(token).digest("hex")],
        )
      ).rows[0]?.pi;
    const first = await intentOf();
    expect(first).toMatch(/^pi_/);
    await page.reload();
    expect(await intentOf()).toBe(first);

    expect((await page.goto(`${PAY}/pay/not-a-real-token`))?.status()).toBe(404);

    await page.goto(url);
    await page.getByRole("button", { name: "Pay $25.00" }).click();
    await expect(page.getByRole("status")).toHaveText("Paid $25.00 · thank you");
  } finally {
    await db.end();
  }
});

/**
 * "Your bill" (M4-16; screens N5 and N4) on the seed: after Present, Room 9's
 * phone reads the bill to the cent, "Pay cash to staff" reaches the Board and
 * the Calls list, the tablet shows the bill with no way to pay, Marcus's
 * booking link shows the same bill, a reopen and a second Present show
 * revision 2, and "Pay another way" opens the payment page for $498.60.
 */
test("Your bill: Room 9 after Present on a phone, its tablet and Marcus's booking link", async ({
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  execSync("pnpm exec tsx src/stripe/seed-stripe.ts", {
    cwd: "apps/api",
    stdio: "ignore",
    env: {
      ...process.env,
      WEST4_ENV: "local",
      DATABASE_URL: DB,
    },
  });
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  try {
    // Andy's session, made directly so the test can present and reopen through the API.
    const token = randomBytes(24).toString("base64url");
    const andy = (
      await db.query<{ user_id: string; id: string; venue_id: string }>(
        "select m.user_id, m.id, m.venue_id from memberships m join users u on u.id = m.user_id where u.name like 'Andy%'",
      )
    ).rows[0]!;
    await db.query(
      `insert into auth_sessions (principal, user_id, membership_id, assurance, client, token_hash, started_at, last_seen_at, expires_at)
       values ('staff', $1, $2, 'pin', 'web', $3, '2026-09-25T22:41:00-04:00', '2026-09-25T22:41:00-04:00', '2026-09-26T06:00:00-04:00')`,
      [andy.user_id, andy.id, createHash("sha256").update(token).digest("hex")],
    );
    const staff = (method: "get" | "post", path: string) =>
      request[method](`${API}/v1/venues/${andy.venue_id}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        ...(method === "post" ? { data: {} } : {}),
      });
    const ids = Object.fromEntries(
      (
        await db.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
      ).rows.map((r) => [r.slug, r.id]),
    );
    // The ringing Margarita is cancelled first, so the check can be presented.
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    const bookingToken = randomBytes(16).toString("base64url");
    await db.query("update bookings set manage_token_hash = $2 where id = $1", [
      ids["bk_marcus"],
      createHash("sha256").update(bookingToken).digest("hex"),
    ]);

    const phone = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    const hostToken = createHash("sha256")
      .update("host-token:sess_room9")
      .digest("base64url")
      .slice(0, 32);
    await phone.goto(`/r/${hostToken}`);
    await expect(phone.getByRole("heading", { level: 1 })).toHaveText("Room 9 · Code KX4M7");
    expect((await staff("post", `/checks/${ids["chk_room9"]}/present`)).status()).toBe(200);

    // The live socket may connect just after Present; the page's 10-second refresh catches it then.
    await expect(phone.getByText("Your bill is ready · ordering is closed")).toBeVisible({
      timeout: 15_000,
    });
    const bill = phone.getByRole("region", { name: "Your bill · #1042" });
    for (const line of [
      "Room time$322.00",
      "Drinks$158.00",
      "Tax (8.875%)$42.60",
      "Gratuity included (20%)$96.00",
      "Total$618.60",
      "Deposit−$120.00",
      "Left to pay$498.60",
    ])
      await expect(bill).toContainText(line);

    await bill.getByRole("button", { name: "Pay cash to staff" }).click();
    await expect(bill.getByText("Staff are on their way to take your cash")).toBeVisible();
    const calls = (await (await staff("get", "/calls")).json()) as {
      calls: { kind: string; room_name?: string }[];
    };
    expect(calls.calls.some((c) => c.kind === "check")).toBe(true);
    const board = (await (await staff("get", "/board")).json()) as {
      rooms: { room_id: string; calls?: { kind: string }[] }[];
    };
    expect(
      board.rooms.find((r) => r.room_id === ids["room_9"])?.calls?.some((c) => c.kind === "check"),
    ).toBe(true);

    // The booking link reads the same bill.
    const link = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    const opened = await link.goto(`/b/${bookingToken}`);
    expect(opened?.headers()["referrer-policy"]).toBe("no-referrer");
    const linkBill = link.getByRole("region", { name: "Your bill · #1042" });
    await expect(linkBill).toContainText("Left to pay$498.60");
    expect(await linkBill.locator("dl").innerText()).toBe(await bill.locator("dl").innerText());
    expect((await link.goto("/b/not-a-real-booking-token-0000"))?.status()).toBe(404);

    // Andy reopens and presents again: revision 2.
    expect((await staff("post", `/checks/${ids["chk_room9"]}/reopen`)).status()).toBe(200);
    expect((await staff("post", `/checks/${ids["chk_room9"]}/present`)).status()).toBe(200);
    await phone.reload();
    await expect(phone.getByRole("region", { name: "Your bill · #1042" })).toContainText(
      "Revision 2",
    );

    // Room 9's tablet: the bill, and no way to pay from it.
    const code = randomBytes(4).toString("hex").toUpperCase();
    await db.query(
      `insert into device_pairing_codes (venue_id, code_hash, kind, name, room_id, expires_at)
       select r.venue_id, $1, 'room_tablet', 'Tablet · ' || r.name, r.id, now() + interval '1 hour'
         from rooms r where r.name = 'Room 9'`,
      [createHash("sha256").update(code).digest("hex")],
    );
    const tablet = await (
      await browser.newContext({ viewport: { width: 1024, height: 768 } })
    ).newPage();
    await tablet.goto("/tablet");
    await tablet.getByLabel("Pairing code from Admin → Devices").fill(code);
    await tablet.getByRole("button", { name: "Pair" }).click();
    await expect(tablet.getByText("Your bill is ready · ordering is closed")).toBeVisible();
    await expect(tablet.getByRole("region", { name: "Your bill · #1042" })).toContainText(
      "Left to pay$498.60",
    );
    await expect(tablet.getByRole("button", { name: "Pay another way" })).toHaveCount(0);
    await expect(tablet.getByRole("button", { name: "Pay cash to staff" })).toHaveCount(0);

    // Pay another way: the payment page on its own origin, for what's left.
    await phone
      .getByRole("region", { name: "Your bill · #1042" })
      .getByRole("button", { name: "Pay another way" })
      .click();
    await expect(phone).toHaveURL(new RegExp(`^${esc(PAY)}/pay/`));
    await expect(phone.getByRole("heading", { level: 1 })).toHaveText("Pay $498.60");

    // Paid on the payment page: the phone's bill says so, with the receipt (M4-19).
    await phone.waitForLoadState("networkidle");
    await phone.getByRole("button", { name: "Pay $498.60" }).click();
    await expect(phone.getByRole("status")).toHaveText("Paid $498.60 · thank you");
    await phone.goto("/room");
    await expect(phone.getByText("Paid in full · thank you")).toBeVisible();
    await phone.getByRole("link", { name: "See your receipt" }).click();
    await expect(phone).toHaveURL(/\/receipt\//);
    await expect(phone.getByRole("heading", { level: 1 })).toHaveText("West 4 Boho Karaoke");
    const totals = phone.getByRole("region", { name: "Totals" });
    await expect(totals).toContainText("Gratuity included (20%)$96.00");
    await expect(totals).toContainText("Tax · room time (8.875%)$28.58");
    await expect(phone.getByRole("region", { name: "How it was paid" })).toContainText(
      "Deposit−$120.00",
    );
    await expect(phone.getByText("Check #1042 · Room 9")).toBeVisible();
  } finally {
    await db.end();
  }
});

/**
 * The menu page, the PDF and the room page's menu (M5-03) read one list: every
 * row the room page's route gives shows on the page at the same price, and in
 * the PDF the job prints; an item hidden in Admin → Menu goes from all three;
 * Hoegaarden, Casamigos Blanco and Casamigos · bottle read "86'd tonight"; no
 * price rules, no happy-hour banner.
 */
test("the menu page, the PDF and the room page's menu show the same items and prices", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const { menuPdfText } = await import("../apps/api/src/menu/pdf-text.js");
  const databaseUrl = DB;
  const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);
  const pdfMoney = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  type Api = {
    categories: {
      items: {
        name: string;
        out_tonight: boolean;
        variants: { name: string; price_cents: number; out_tonight: boolean }[];
      }[];
    }[];
    happy_hours: unknown[];
  };
  const compare = async () => {
    const api = (await (
      await request.get(`${API}/v1/public/venues/west4karaoke/menu`)
    ).json()) as Api;
    const expected = api.categories.flatMap((c) =>
      c.items.flatMap((i) =>
        i.variants.map((v) => ({
          name: i.variants.length > 1 ? `${i.name} · ${v.name}` : i.name,
          price: i.out_tonight || v.out_tonight ? "86'd tonight" : v.price_cents,
        })),
      ),
    );
    await page.goto("/v/west4karaoke/menu");
    const shown = await page.locator("[data-menu-row]").evaluateAll((rows) =>
      rows.map((r) => ({
        name: r.querySelector(".name")?.textContent ?? "",
        price: r.querySelector(".price")?.textContent ?? "",
      })),
    );
    expect(
      shown.map((r) => ({
        name: r.name,
        price: r.price.startsWith("$") ? cents(r.price) : r.price,
      })),
    ).toEqual(expected);
    const pdf = await menuPdfText(databaseUrl, "west4karaoke", "2026-09-26T02:41:00Z");
    for (const c of api.categories)
      for (const i of c.items) {
        expect(pdf, i.name).toContain(i.name);
        for (const v of i.variants) expect(pdf, i.name).toContain(pdfMoney(v.price_cents));
      }
    return { api, pdf };
  };

  const first = await compare();
  expect(first.api.happy_hours).toEqual([]);
  await expect(page.getByRole("heading", { name: "Happy hour" })).toHaveCount(0);
  for (const name of ["Hoegaarden", "Casamigos Blanco", "Casamigos · bottle"])
    await expect(
      page.locator("[data-menu-row]").filter({ has: page.getByText(name, { exact: true }) }),
    ).toContainText("86'd tonight");
  expect(first.pdf).toContain("Bud Light");

  // Hidden in Admin → Menu: gone from all three.
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query("update menu_items set shown = false where name = 'Bud Light'");
  } finally {
    await db.end();
  }
  const after = await compare();
  expect(JSON.stringify(after.api)).not.toContain("Bud Light");
  expect(after.pdf).not.toContain("Bud Light");
  await expect(page.getByText("Bud Light")).toHaveCount(0);
});

/** The enquiry form on the private parties page (M5-04): no email address, then sent by text. */
test("the parties page takes an enquiry for 22 by mobile number, not email", async ({ page }) => {
  await page.goto("/v/west4karaoke/parties");
  const form = page.locator("form.enquiry");
  await form.getByLabel("Your name").fill("Priya");
  await form.getByLabel("Mobile number").fill("priya@example.com");
  await expect(form.getByText("We reply by text.")).toBeVisible();
  await form.getByLabel("Guests").fill("22");
  await form.getByLabel("Date").fill("2026-10-10");
  await form.getByLabel("Anything else?").fill("Office party, from 8 PM.");
  await form.getByRole("button", { name: "Send enquiry" }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "We reply by text, so we need a mobile number, not an email address.",
  );
  await form.getByLabel("Mobile number").fill("(646) 555-0142");
  await form.getByRole("button", { name: "Send enquiry" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sent." })).toContainText(
    "Sent. We'll reply by text.",
  );
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  try {
    const row = await db.query(
      "select e.party_size, e.date::text, c.unread from enquiries e join conversations c on c.id = e.conversation_id",
    );
    expect(row.rows).toEqual([{ party_size: 22, date: "2026-10-10", unread: 1 }]);
  } finally {
    await db.end();
  }
});

/**
 * Book a room, the Pick step (M5-07): Jae & co.'s price before paying, the
 * hold with its countdown and More time, a hold that runs out, a party of 3
 * on a Friday, and both 1 AMs on the fall-back night.
 */
test("Book: 5 guests for 2 hours on a Friday at 11 PM, held for 10 minutes, More time, then the hold runs out", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await page.goto("/v/west4karaoke/book?date=2026-10-02&guests=5&hours=2");
  const quote = page.locator(".quote");
  await expect(quote).toContainText("Room time, 2 hours for 5$100");
  await expect(quote).toContainText("Tax 8.875%$8.88");
  await expect(quote).toContainText("Gratuity 20%$20");
  await expect(quote).toContainText("Room time, all in$128.88");
  await expect(quote).toContainText("Deposit to hold it$50");
  await page.getByRole("button", { name: "Hold 11 PM EDT" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A small room held for you");
  await expect(page.getByText("Fri, Oct 2 · 11 PM · 5 guests · 2 hours")).toBeVisible();
  await expect(page.getByText(/^(10:00|9:5\d) left to finish$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "More time" })).toHaveCount(0);
  const held = page.url();

  // At one minute left, More time adds 10 minutes.
  const at = (iso: string) => request.post(`${API}/v1/ops/clock`, { data: { server_time: iso } });
  expect((await at("2026-09-26T02:50:10Z")).ok()).toBe(true);
  await page.reload();
  await expect(page.getByText("One minute left. Need more time?")).toBeAttached();
  await page.getByRole("button", { name: "More time" }).click();
  await expect(page.getByText(/^(10:00|9:5\d) left to finish$/)).toBeVisible();

  // Past the hold, the room is let go and the guest picks again.
  expect((await at("2026-09-26T03:01:00Z")).ok()).toBe(true);
  await page.goto(held);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Your hold ran out, and the room went back on sale.",
  );
  await expect(page.getByRole("link", { name: "Pick a time again" })).toBeVisible();
});

/**
 * The Details and Terms steps (M5-08): a +44 number is refused; with Marketing texts on, the box
 * starts unticked and, ticked, stores its proof; the terms show the policy and this booking's cut-off.
 */
test("Book: Jae's details, the marketing box and the terms", async ({ page }) => {
  test.setTimeout(90_000);
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  try {
    await db.query(
      `update venue_modules set state = 'on'
        where module_id = 'marketing_texts' and venue_id = (select id from venues where slug = 'west4karaoke')`,
    );
    await page.goto("/v/west4karaoke/book?date=2026-10-02&guests=5&hours=2");
    await page.getByRole("button", { name: "Hold 11 PM EDT" }).click();
    await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
    await expect(
      page.getByText("We text your confirmation and reminders to this number."),
    ).toBeVisible();
    const box = page.getByRole("checkbox", { name: /Also text me news and offers from West 4/ });
    await expect(box).not.toBeChecked();
    await page.getByLabel("Name").fill("Jae K.");
    await page.getByLabel("Mobile number").fill("+44 20 7123 4567");
    await page.getByLabel("Email").fill("jae@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("p[role=alert]")).toHaveText(
      "Check your name, your email and a US mobile number (+1).",
    );
    await page.getByLabel("Mobile number").fill("(212) 555-0188");
    await box.check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "The deposit policy" })).toBeVisible();
    await expect(page.locator(".terms")).toContainText("Free to cancel until Thu, Oct 1 11:00 PM");
    await expect(page.locator(".terms")).toContainText("A 20% gratuity is added to room tabs.");
    const proof = await db.query(
      `select k.source, k.ip is not null as ip, k.given_at is not null as at, p.kind
         from consents k join policy_versions p on p.id::text = k.text_version
        where k.phone_e164 = '+12125550188' and k.kind = 'marketing'`,
    );
    expect(proof.rows).toEqual([
      { source: "booking_form", ip: true, at: true, kind: "marketing_opt_in" },
    ]);
  } finally {
    await db.end();
  }
});

/**
 * The deposit on the payment page (M5-09): from Terms to the payment origin, the policy above
 * "Pay $50.00 deposit", a declined test card then a good one on the same PaymentIntent, and a second
 * hold left to run out goes back to pick a time.
 */
test("Book: Jae pays the $50.00 deposit on the payment page and is booked", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  execSync("pnpm exec tsx src/stripe/seed-stripe.ts", {
    cwd: "apps/api",
    stdio: "ignore",
    env: {
      ...process.env,
      WEST4_ENV: "local",
      DATABASE_URL: DB,
    },
  });
  const book = async (time: string) => {
    await page.goto("/v/west4karaoke/book?date=2026-10-02&guests=5&hours=2");
    await page.getByRole("button", { name: `Hold ${time} EDT` }).click();
    await page.getByLabel("Name").fill("Jae K.");
    await page.getByLabel("Mobile number").fill("(212) 555-0188");
    await page.getByLabel("Email").fill("jae@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Pay $50.00 deposit" }).click();
    await page.waitForURL(new RegExp(`^${esc(PAY)}/pay/`));
  };
  await book("11 PM");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your deposit · $50.00");
  await expect(page.locator(".terms")).toContainText("A 20% gratuity is added to room tabs.");
  await expect(page.getByText(/^(10:00|9:5\d) left to finish$/)).toBeVisible();
  await page.getByRole("button", { name: "Try a declined test card" }).click();
  await expect(page.locator("p[role=alert]")).toHaveText(
    "Your card was declined · try another card",
  );
  await page.getByRole("button", { name: "Pay $50.00 deposit" }).click();
  // Paid and confirmed (M5-10): back on the booking's own page, in the Confirmed state.
  await page.waitForURL(new RegExp(`^${esc(GUEST)}/v/west4karaoke/book/[A-Za-z0-9_-]{22}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're booked");
  const confirmed = page.locator(".confirmed");
  await expect(confirmed).toContainText("A small room · Fri, Oct 2 · 11 PM · 5 guests · 2 hours");
  await expect(confirmed).toContainText("Deposit $50.00 paid · it comes off your bill");
  await expect(confirmed).toContainText("Free to cancel until Thu, Oct 1 11:00 PM");
  await expect(confirmed).toContainText("A 20% gratuity is added to room tabs.");
  await expect(confirmed).toContainText("We texted your confirmation to (212) 555-0188.");
  await expect(page.getByRole("link", { name: "Manage your booking" })).toHaveAttribute(
    "href",
    /^\/b\/[A-Za-z0-9_-]{22}$/,
  );

  // A second booking whose hold runs out on the payment page.
  await book("9 PM");
  const at = (iso: string) => request.post(`${API}/v1/ops/clock`, { data: { server_time: iso } });
  expect((await at("2026-09-26T03:05:00Z")).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(
    "Your hold ran out, and the room went back on sale.",
  );
  await expect(page.getByRole("link", { name: "Pick a time again" })).toHaveAttribute(
    "href",
    `${GUEST}/v/west4karaoke/book`,
  );
});

/**
 * The manage page (M5-11) on Jae's seed booking at 10:41 PM: 5 guests, $50.00 paid, past the Thu
 * 11:00 PM cut-off. 5 to 6 shows the $60.00 deposit and sends him to pay $10.00 on the payment page;
 * Running late holds the room until 11:15 PM.
 */
test("Manage: Jae goes from 5 to 6 guests and pays $10.00, then says he's running late", async ({
  page,
}) => {
  test.setTimeout(120_000);
  execSync("pnpm exec tsx src/stripe/seed-stripe.ts", {
    cwd: "apps/api",
    stdio: "ignore",
    env: {
      ...process.env,
      WEST4_ENV: "local",
      DATABASE_URL: DB,
    },
  });
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  const token = randomBytes(16).toString("base64url");
  try {
    await db.query(
      `update bookings set manage_token_hash = $1
        where id = (select row_id from seed_ids where slug = 'bk_jae')`,
      [createHash("sha256").update(token).digest("hex")],
    );
  } finally {
    await db.end();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/b/${token}`);
  const manage = page.getByRole("region", { name: "Your booking" });
  await expect(manage).toContainText("A small room · Fri, Sep 25 · 11 PM · 5 guests");
  await expect(manage).toContainText("Deposit $50.00 paid");
  await expect(manage).toContainText("You're past the refund cut-off (Thu 11:00 PM)");

  await manage.getByRole("button", { name: "Change party size" }).click();
  await manage.getByRole("button", { name: "More guests" }).click();
  await manage.getByRole("button", { name: "Update to 6 guests" }).click();
  await expect(manage).toContainText("Your deposit becomes $60.00");
  await expect(manage).toContainText("You pay the $10.00 difference on the next page");
  await manage.getByRole("button", { name: "Confirm and pay $10.00" }).click();
  await page.waitForURL(new RegExp(`^${esc(PAY)}/pay/`));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("$10.00");

  await page.goto(`/b/${token}`);
  await expect(manage).toContainText("Pay the $10.00 difference");
  await manage.getByRole("button", { name: "Running late?" }).click();
  await expect(manage).toContainText(
    "We'll hold your room until 11:15 PM. That's our 15-minute grace.",
  );
});

/**
 * Cancelling on the manage page (M5-12) at 10:41 PM, after Jae's Thu 11:00 PM cut-off: the page says the
 * $50.00 is kept before he confirms, then shows it kept.
 */
test("Manage: with Online booking & deposits off, Jae cancels after the cut-off and the page says the deposit is kept", async ({
  page,
}) => {
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  const token = randomBytes(16).toString("base64url");
  await db.query(
    `update bookings set manage_token_hash = $1
      where id = (select row_id from seed_ids where slug = 'bk_jae')`,
    [createHash("sha256").update(token).digest("hex")],
  );
  // M5-14: his manage link keeps working with the module off.
  await db.query("update venue_modules set state = 'off' where module_id = 'online_booking'");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/b/${token}`);
    const manage = page.getByRole("region", { name: "Your booking" });
    await manage.getByRole("button", { name: "Cancel booking" }).click();
    await expect(page.getByRole("dialog", { name: "Cancel booking" })).toContainText(
      "You're past the refund cut-off (Thu 11:00 PM): the $50.00 deposit is kept per our policy.",
    );
    await page.getByRole("button", { name: "Yes, cancel" }).click();
    const cancelled = page.getByRole("region", { name: "Cancelled" });
    await expect(cancelled).toContainText("Deposit kept per our policy · $50.00");
    await page.reload();
    await expect(cancelled).toContainText("Deposit kept per our policy · $50.00");
  } finally {
    await db.query("update venue_modules set state = 'on' where module_id = 'online_booking'");
    await db.end();
  }
});

test("Book: a party of 3 on a Friday pays for 4, and Nov 1 lists 1 AM EDT and 1 AM EST", async ({
  page,
}) => {
  await page.goto("/v/west4karaoke/book?date=2026-10-02&guests=3&hours=1");
  await expect(page.getByRole("note")).toHaveText("Fri & Sat bill at least 4 · you pay for 4");
  await expect(page.locator(".quote")).toContainText("Deposit to hold it$40");
  await page.goto("/v/west4karaoke/book?date=2026-10-31&guests=4&hours=1");
  await expect(page.getByRole("button", { name: "Hold 1 AM EDT" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hold 1 AM EST" })).toBeVisible();
  await page.goto("/v/west4karaoke/book?date=2026-10-02&guests=25&hours=2");
  await expect(page.getByRole("link", { name: "Plan a party" })).toHaveAttribute(
    "href",
    "/v/west4karaoke/parties#enquire",
  );
});

/**
 * The public status page (M8-16): each part Working, then an operator's post (a drill, M8-07)
 * shows as Maintenance with its note on the next check, and clearing it puts Working back.
 */
test("the status page shows each part and follows an operator's post", async ({ page }) => {
  const db = new pg.Client({
    connectionString: DB,
  });
  await db.connect();
  const clear = () =>
    db.query(
      "update status_parts set operator_state = null, operator_note = null, operator_since = null, auto_state = 'operational', auto_note = null",
    );
  try {
    await clear();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/status");
    await expect(page.getByRole("heading", { name: "Service status" })).toBeVisible();
    for (const part of ["Ordering", "Payments", "Printing", "Texts"])
      await expect(page.locator("li", { hasText: part })).toContainText("Working");

    await db.query(
      "update status_parts set operator_state = 'maintenance', operator_note = 'Outage drill at one venue', operator_since = now(), operator_by = 'e2e', updated_at = now() where part = 'ordering'",
    );
    await page.reload();
    const ordering = page.locator('li[data-part="ordering"]');
    await expect(ordering).toContainText("Maintenance");
    await expect(ordering).toContainText("Outage drill at one venue");
    await expect(page.locator('li[data-part="payments"]')).toContainText("Working");

    await clear();
    await page.reload();
    await expect(ordering).toContainText("Working");
  } finally {
    await clear();
    await db.end();
  }
});

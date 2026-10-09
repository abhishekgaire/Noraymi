import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { SEED_COMMAND, setClock } from "./night.js";

/**
 * Accessibility checks for the guest web (M3-24; spec 12 · 14): WCAG 2.2 AA,
 * through axe, on the join step, the room page in each of its states, the
 * room tablet and the waitlist pages. Any violation fails the run, and CI
 * runs it on every pull request with the guest smoke tests. One planted
 * violation shows the checks really fail.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const API = "http://127.0.0.1:3000";
const hostToken = (slug: string) =>
  createHash("sha256").update(`host-token:${slug}`).digest("base64url").slice(0, 32);

async function violations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const db = () =>
  new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });

// Put the shared clock back for whatever spec runs next, in this project or another.
test.afterEach(async () => {
  await setClock();
});

test.beforeEach(async ({ request }) => {
  execSync(SEED_COMMAND, { stdio: ["ignore", "ignore", "pipe"] });
  expect(
    (
      await request.post(`${API}/v1/ops/clock`, { data: { server_time: "2026-09-26T02:41:00Z" } })
    ).ok(),
  ).toBe(true);
});

test("the checks fail on a planted violation", async ({ page }) => {
  await page.setContent(
    `<!doctype html><html lang="en"><body><main><img src="x.png"><button></button></main></body></html>`,
  );
  const found = await violations(page);
  expect(found.some((v) => v.startsWith("image-alt"))).toBe(true);
  expect(found.some((v) => v.startsWith("button-name"))).toBe(true);
});

test("the join step, a wrong code and a closed room pass", async ({ page }) => {
  const c = db();
  await c.connect();
  try {
    const room = async (name: string) =>
      (await c.query<{ id: string }>("select id from rooms where name = $1", [name])).rows[0]!.id;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/v/west4karaoke/room/${await room("Room 9")}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Join Room 9");
    expect(await violations(page)).toEqual([]);
    await page.getByLabel("Room code").fill("QQQQQ");
    await page.getByRole("button", { name: "Join" }).click();
    await expect(page.getByText("That code isn't right")).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.goto(`/v/west4karaoke/room/${await room("Room 11")}`);
    await expect(page.getByText("Room 11 is closed right now.")).toBeVisible();
    expect(await violations(page)).toEqual([]);
  } finally {
    await c.end();
  }
});

test("the room page in every state passes, and a status change is announced", async ({
  page,
  request,
}) => {
  const c = db();
  await c.connect();
  try {
    // One order of each status and side message on Room 9, beside the seed's o1 and Jäger Bombs.
    const statuses: [string, string | null, string | null][] = [
      ["held", null, null],
      ["accepted", null, null],
      ["ready", null, null],
      ["on_the_way", null, null],
      ["returned", null, null],
      ["cancelled", "guest", null],
      ["cancelled", "declined", "Out of peach"],
      ["cancelled", "alcohol_closed", null],
      ["cancelled", "cut_off", null],
    ];
    for (const [status, reason, decline] of statuses)
      await c.query(
        `with o as (
           insert into orders (venue_id, check_id, session_id, source, status, cancel_reason, decline_reason, placed_at, business_date)
           select s.venue_id, s.check_id, s.id, 'room', $1, $2, $3, '2026-09-25T22:30:00-04:00', '2026-09-25'
             from room_sessions s where s.id = (select row_id from seed_ids where slug = 'sess_room9') returning id, venue_id)
         insert into order_items (venue_id, order_id, qty, unit_cents, name_snapshot, alcohol)
         select venue_id, id, 1, 800, 'Bud Light', true from o`,
        [status, reason, decline],
      );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/r/${hostToken("sess_room9")}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room 9 · Code KX4M7");
    await expect(page.getByRole("region", { name: "Tonight so far" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Same again" })).toBeVisible();
    await expect(
      page.getByText("The bar couldn't take this order · nothing charged · Out of peach"),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
    // Each order's status is a live region, so a change is announced.
    await expect(page.locator(".order .status").first()).toHaveAttribute("aria-live", "polite");

    // A required choice, then the cart.
    await page.getByRole("button", { name: "Margarita · $13.00" }).click();
    await expect(page.getByRole("dialog", { name: "Margarita" })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.getByRole("dialog", { name: "Margarita" }).getByLabel("Peach").check();
    await page
      .getByRole("dialog", { name: "Margarita" })
      .getByRole("button", { name: "Add" })
      .click();
    await expect(page.getByRole("region", { name: "Your order · not sent yet" })).toBeVisible();
    await page.getByRole("button", { name: "Another mic" }).click();
    await expect(page.getByText("Staff get it on their phones")).toBeVisible();
    expect(await violations(page)).toEqual([]);

    // The host lock, as a friend sees it.
    await page.getByLabel(/Lock ordering/).click();
    await expect(page.getByLabel(/Lock ordering/)).toBeChecked();
    const friend = await (
      await page
        .context()
        .browser()!
        .newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    const room9 = (await c.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    const code = (await page.getByRole("heading", { level: 1 }).innerText()).slice(-5);
    await friend.goto(`/v/west4karaoke/room/${room9}`);
    await friend.getByLabel("Room code").fill(code);
    await friend.getByRole("button", { name: "Join" }).click();
    await expect(friend.getByText(/has locked ordering/)).toBeVisible();
    expect(await violations(friend)).toEqual([]);
    await friend.context().close();

    // A cut-off room, then the 4 AM stop.
    await c.query(
      "update room_sessions set alcohol_cut_off_at = now() where id = (select row_id from seed_ids where slug = 'sess_room9')",
    );
    await page.reload();
    await expect(
      page.getByText("Your server has paused alcohol for this room").first(),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await c.query(
      "update room_sessions set alcohol_cut_off_at = null where id = (select row_id from seed_ids where slug = 'sess_room9')",
    );
    expect(
      (
        await request.post(`${API}/v1/ops/clock`, { data: { server_time: "2026-09-26T08:00:30Z" } })
      ).ok(),
    ).toBe(true);
    await page.reload();
    await expect(page.getByText("The bar has stopped serving alcohol for tonight")).toBeVisible();
    expect(await violations(page)).toEqual([]);
  } finally {
    await c.end();
  }
});

test("the room tablet passes, available and in a session", async ({ page }) => {
  const c = db();
  await c.connect();
  try {
    const pair = async (room: string) => {
      const code = randomBytes(4).toString("hex").toUpperCase();
      await c.query(
        `insert into device_pairing_codes (venue_id, code_hash, kind, name, room_id, expires_at)
         select r.venue_id, $1, 'room_tablet', 'Tablet · ' || r.name, r.id, now() + interval '1 hour' from rooms r where r.name = $2`,
        [createHash("sha256").update(code).digest("hex"), room],
      );
      return code;
    };
    for (const [room, expected] of [
      ["Room 11", "Room available"],
      ["Room 9", "Tonight so far"],
    ] as const) {
      const tablet = await (
        await page
          .context()
          .browser()!
          .newContext({ viewport: { width: 1024, height: 768 } })
      ).newPage();
      await tablet.goto("/tablet");
      expect(await violations(tablet)).toEqual([]);
      await tablet.getByLabel("Pairing code from Admin → Devices").fill(await pair(room));
      await tablet.getByRole("button", { name: "Pair" }).click();
      await expect(tablet.getByText(expected).first()).toBeVisible();
      expect(await violations(tablet)).toEqual([]);
      await tablet.context().close();
    }
  } finally {
    await c.end();
  }
});

test("the waitlist pages from M2 pass", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/v/west4karaoke/waitlist");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.getByLabel("Your name").fill("Ari");
  await page.getByLabel("Mobile number").fill("2125550188");
  await page.getByLabel("How many of you").fill("4");
  await page.getByRole("button", { name: /Join/ }).click();
  await expect(page).toHaveURL(/\/w\//);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

/** Your bill (M4-16) on Room 9's phone and on Marcus's booking link, after Present. */
test("the bill passes on the room page and the booking link", async ({ page, request }) => {
  test.setTimeout(90_000);
  const c = db();
  await c.connect();
  try {
    const token = randomBytes(24).toString("base64url");
    const andy = (
      await c.query<{ user_id: string; id: string; venue_id: string }>(
        "select m.user_id, m.id, m.venue_id from memberships m join users u on u.id = m.user_id where u.name like 'Andy%'",
      )
    ).rows[0]!;
    await c.query(
      `insert into auth_sessions (principal, user_id, membership_id, assurance, client, token_hash, started_at, last_seen_at, expires_at)
       values ('staff', $1, $2, 'pin', 'web', $3, '2026-09-25T22:41:00-04:00', '2026-09-25T22:41:00-04:00', '2026-09-26T06:00:00-04:00')`,
      [andy.user_id, andy.id, createHash("sha256").update(token).digest("hex")],
    );
    await c.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    const bookingToken = randomBytes(16).toString("base64url");
    await c.query(
      "update bookings set manage_token_hash = $1 where id = (select row_id from seed_ids where slug = 'bk_marcus')",
      [createHash("sha256").update(bookingToken).digest("hex")],
    );
    const check = (
      await c.query<{ id: string }>("select row_id as id from seed_ids where slug = 'chk_room9'")
    ).rows[0]!.id;
    expect(
      (
        await request.post(`${API}/v1/venues/${andy.venue_id}/checks/${check}/present`, {
          headers: { authorization: `Bearer ${token}` },
          data: {},
        })
      ).status(),
    ).toBe(200);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/r/${hostToken("sess_room9")}`);
    await expect(page.getByRole("region", { name: "Your bill · #1042" })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.goto(`/b/${bookingToken}`);
    await expect(page.getByRole("region", { name: "Your bill · #1042" })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  } finally {
    await c.end();
  }
});

/** The site's home and private parties pages (M5-01). */
test("the site's home and parties pages pass", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lose your voice.");
  expect(await violations(page)).toEqual([]);
  await page.goto("/v/west4karaoke/parties");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your night. Your door.");
  expect(await violations(page)).toEqual([]);
});

/** The menu page (M5-03), with its 86'd rows greyed, in light and dark. */
test("the menu page passes, light and dark", async ({ page }) => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/menu");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Menu");
    expect(await violations(page)).toEqual([]);
  }
});

/** Book a room (M5-07): the Pick step and a held booking with its countdown. */
test("the Book page and a held booking pass", async ({ page }) => {
  await page.goto("/v/west4karaoke/book?date=2026-10-02&guests=5&hours=2");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Book a room");
  expect(await violations(page)).toEqual([]);
  await page.getByRole("button", { name: "Hold 11 PM EDT" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A small room held for you");
  expect(await violations(page)).toEqual([]);
});

/** The singer's queue page (M6-20): the join step, the code step with a wrong code, and Sofia R.'s page, light and dark. */
test("the singer's queue page passes: joining, a wrong code and a singer's own page", async ({
  page,
}) => {
  const c = db();
  await c.connect();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/v/west4karaoke/sing");
    await expect(page.getByRole("heading", { name: "Join the queue" })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.getByLabel("Your name on the TV").fill("Sofia R.");
    await page.getByLabel("Mobile number").fill("(347) 555-0195");
    await page.getByRole("button", { name: "Text me a code" }).click();
    await page.getByLabel("The code we texted you").fill("000000");
    const code = async () =>
      (
        await c.query<{ code: string }>(
          `select payload->'data'->>'code' as code from jobs where kind = 'text.send'
             and payload->>'to' = '+13475550195' order by created_at desc limit 1`,
        )
      ).rows[0]?.code;
    await expect.poll(code).toBeTruthy();
    const right = (await code())!;
    if (right !== "000000") {
      await page.getByRole("button", { name: "Confirm" }).click();
      await expect(page.getByText("That code isn't right.")).toBeVisible();
      expect(await violations(page)).toEqual([]);
    }
    await page.getByLabel("The code we texted you").fill(right);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Needs a drink credit")).toBeVisible();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await violations(page)).toEqual([]);
    }
  } finally {
    await c.end();
  }
});

/** The Stripe side of the night on the fake Stripe, for the payment page (M5-09). */
const stripeSeed = () =>
  execSync("pnpm exec tsx src/stripe/seed-stripe.ts", {
    cwd: "apps/api",
    stdio: "ignore",
    env: {
      ...process.env,
      WEST4_ENV: "local",
      DATABASE_URL: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
    },
  });
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** M5-16: the rest of the site, light and dark: the venue page, its menu, the moved page and the status page. */
test("the venue page, its menu, the old booking page and the status page pass, light and dark", async ({
  page,
}) => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const path of [
      "/",
      "/v/west4karaoke",
      "/v/west4karaoke/menu",
      "/book",
      "/booking-moved",
      "/status",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await violations(page), `${path} (${colorScheme})`).toEqual([]);
    }
  }
});

/** M5-16: the parties page's enquiry form with its error, then sent. */
test("the enquiry form passes with an error and once sent", async ({ page }) => {
  await page.goto("/v/west4karaoke/parties");
  const form = page.locator("form.enquiry");
  await form.getByLabel("Your name").fill("Priya");
  await form.getByLabel("Mobile number").fill("priya@example.com");
  await form.getByLabel("Guests").fill("22");
  await form.getByLabel("Date").fill("2026-10-10");
  await form.getByRole("button", { name: "Send enquiry" }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await form.getByLabel("Mobile number").fill("(646) 555-0142");
  await form.getByRole("button", { name: "Send enquiry" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sent." })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

/**
 * M5-16: every booking step on a phone, light and dark: details with an error, the deposit policy,
 * the payment page with a declined card, the confirmed booking, and a hold that ran out.
 */
test("every booking step passes: details, terms, the payment page, booked and a lapsed hold", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  stripeSeed();
  await page.setViewportSize({ width: 390, height: 844 });
  const both = async (label: string) => {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await violations(page), `${label} (${colorScheme})`).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
  };
  const book = async (time: string) => {
    await page.goto("/v/west4karaoke/book?date=2026-10-02&guests=5&hours=2");
    await page.getByRole("button", { name: `Hold ${time} EDT` }).click();
    await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
  };
  await book("11 PM");
  await page.getByLabel("Name").fill("Jae K.");
  await page.getByLabel("Mobile number").fill("+44 20 7123 4567");
  await page.getByLabel("Email").fill("jae@example.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("p[role=alert]")).toBeVisible();
  await both("details with an error");
  await page.getByLabel("Mobile number").fill("(212) 555-0188");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "The deposit policy" })).toBeVisible();
  await both("terms");
  await page.getByRole("button", { name: "Pay $50.00 deposit" }).click();
  await page.waitForURL(/^http:\/\/pay\.localhost:3001\/pay\//);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your deposit · $50.00");
  await both("the payment page");
  await page.getByRole("button", { name: "Try a declined test card" }).click();
  await expect(page.locator("p[role=alert]")).toBeVisible();
  await both("the payment page, declined");
  await page.getByRole("button", { name: "Pay $50.00 deposit" }).click();
  await page.waitForURL(/\/v\/west4karaoke\/book\/[A-Za-z0-9_-]{22}$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're booked");
  await both("booked");

  await book("9 PM");
  expect(
    (
      await request.post(`${API}/v1/ops/clock`, { data: { server_time: "2026-09-26T03:05:00Z" } })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await expect(page.getByText(/ran out/).first()).toBeVisible();
  await both("a lapsed hold");
});

/** M5-16: a balance pay link on the payment page, before and after paying. */
test("the payment page passes for a pay link, and once paid", async ({ page }) => {
  test.setTimeout(90_000);
  stripeSeed();
  const c = db();
  await c.connect();
  try {
    const token = randomBytes(16).toString("base64url");
    await c.query(
      `insert into pay_links (venue_id, token_hash, check_id, amount_cents, expires_at, purpose)
       select c.venue_id, $1, c.id, 2500, now() + interval '1 day', 'balance'
         from checks c join seed_ids s on s.row_id = c.id where s.slug = 'chk_room9'`,
      [tokenHash(token)],
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://pay.localhost:3001/pay/${token}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pay $25.00");
    expect(await violations(page)).toEqual([]);
    await page.getByRole("button", { name: "Pay $25.00" }).click();
    await expect(page.getByRole("status")).toHaveText("Paid $25.00 · thank you");
    expect(await violations(page)).toEqual([]);
  } finally {
    await c.end();
  }
});

/** M5-16: the manage page on Jae's booking, with Change party size and Cancel open. */
test("the manage page passes, with a change and the cancel question open", async ({ page }) => {
  const c = db();
  await c.connect();
  const token = randomBytes(16).toString("base64url");
  try {
    await c.query(
      "update bookings set manage_token_hash = $1 where id = (select row_id from seed_ids where slug = 'bk_jae')",
      [tokenHash(token)],
    );
  } finally {
    await c.end();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/b/${token}`);
  const manage = page.getByRole("region", { name: "Your booking" });
  await expect(manage).toContainText("Deposit $50.00 paid");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await violations(page), colorScheme).toEqual([]);
  }
  await manage.getByRole("button", { name: "Change party size" }).click();
  await manage.getByRole("button", { name: "More guests" }).click();
  await manage.getByRole("button", { name: "Update to 6 guests" }).click();
  await expect(manage).toContainText("Your deposit becomes $60.00");
  expect(await violations(page)).toEqual([]);
  await page.goto(`/b/${token}`);
  await manage.getByRole("button", { name: "Cancel booking" }).click();
  await expect(page.getByRole("dialog", { name: "Cancel booking" })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

/** M5-16: the waitlist offer's page, with its countdown announced once a minute rather than every second. */
test("the waitlist offer passes, and its countdown isn't read out every second", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/v/west4karaoke/waitlist");
  await page.getByLabel("Your name").fill("Ari");
  await page.getByLabel("Mobile number").fill("2125550188");
  await page.getByLabel("How many of you").fill("4");
  await page.getByRole("button", { name: /Join/ }).click();
  await expect(page).toHaveURL(/\/w\//);
  const c = db();
  await c.connect();
  try {
    await c.query(
      `update waitlist_entries set status = 'offered', offer_expires_at = '2026-09-25T22:51:00-04:00',
              offered_room_id = (select id from rooms where name = 'Room 11')
        where id = (select id from waitlist_entries order by joined_at desc limit 1)`,
    );
  } finally {
    await c.end();
  }
  await page.reload();
  await expect(page.getByText(/Room 11 is ready · \d+:\d\d to claim it/)).toBeVisible();
  const spoken = page.getByRole("status").filter({ hasText: "Room 11 is ready" });
  await expect(spoken).toHaveText(/Room 11 is ready · \d+ minutes? to claim it/);
  expect(await violations(page)).toEqual([]);
});

/** M5-16: Pay my share on a joined guest's phone after Present, and the receipt page. */
test("Pay my share and the receipt page pass", async ({ page, request }) => {
  test.setTimeout(90_000);
  const c = db();
  await c.connect();
  try {
    const token = randomBytes(24).toString("base64url");
    const andy = (
      await c.query<{ user_id: string; id: string; venue_id: string }>(
        "select m.user_id, m.id, m.venue_id from memberships m join users u on u.id = m.user_id where u.name like 'Andy%'",
      )
    ).rows[0]!;
    await c.query(
      `insert into auth_sessions (principal, user_id, membership_id, assurance, client, token_hash, started_at, last_seen_at, expires_at)
       values ('staff', $1, $2, 'pin', 'web', $3, '2026-09-25T22:41:00-04:00', '2026-09-25T22:41:00-04:00', '2026-09-26T06:00:00-04:00')`,
      [andy.user_id, andy.id, tokenHash(token)],
    );
    await c.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    const check = (
      await c.query<{ id: string }>("select row_id as id from seed_ids where slug = 'chk_room9'")
    ).rows[0]!.id;
    expect(
      (
        await request.post(`${API}/v1/venues/${andy.venue_id}/checks/${check}/present`, {
          headers: { authorization: `Bearer ${token}` },
          data: {},
        })
      ).status(),
    ).toBe(200);
    await page.setViewportSize({ width: 390, height: 844 });
    const room9 = (await c.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/v/west4karaoke/room/${room9}`);
    await page.getByLabel("Room code").fill("KX4M7");
    await page.getByRole("button", { name: "Join" }).click();
    const share = page
      .getByRole("region", { name: "Your bill · #1042" })
      .getByRole("group", { name: "Pay my share" });
    await expect(share).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await share.getByLabel("Your name, for the bill").fill("Kevin");
    await share.getByRole("button", { name: "An even share (1 of 12)" }).click();
    await expect(share.getByText("Your share 1 of 12 · $41.55")).toBeVisible();
    expect(await violations(page)).toEqual([]);

    const receipt = randomBytes(18).toString("base64url");
    await c.query(
      `insert into receipts (venue_id, check_id, token_hash, channel, sent_at, expires_at)
       select venue_id, id, $1, 'web', now(), now() + interval '30 days' from checks where id = $2`,
      [tokenHash(receipt), check],
    );
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto(`/receipt/${receipt}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await violations(page), colorScheme).toEqual([]);
    }
  } finally {
    await c.end();
  }
});

/**
 * M5-16: every guest page is in this suite. A new page.tsx under apps/guest/app fails here until it
 * gets an axe check above (or a reason it isn't a guest's page).
 */
test("every guest page has an accessibility check", () => {
  const covered: Record<string, string> = {
    "": "the site's home",
    book: "the bare domain's Book page",
    "booking-moved": "the old booking page",
    menu: "the menu page",
    status: "the status page",
    "b/[token]": "manage and the booking link's bill",
    "pay/[token]": "the payment page",
    "r/[token]": "the room page from the host link",
    "receipt/[token]": "the receipt page",
    room: "the room page on a joined phone",
    tablet: "the room tablet",
    "v/[slug]": "the venue page",
    "v/[slug]/book": "Book: Pick and Hold",
    "v/[slug]/book/[token]": "Book: details, terms, booked and a lapsed hold",
    "v/[slug]/menu": "the venue's menu page",
    "v/[slug]/parties": "private parties and the enquiry form",
    "v/[slug]/room/[roomId]": "joining a room, ordering and Pay my share",
    "v/[slug]/sing": "the singer's queue page",
    "v/[slug]/waitlist": "joining the waitlist",
    "w/[token]": "a waitlist spot and its offer",
    tv: "not a guest's page: the bar's Up next TV, a paired shared screen (M6-22)",
  };
  const pages: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`, rel ? `${rel}/${e.name}` : e.name);
      else if (e.name === "page.tsx") pages.push(rel);
    }
  };
  walk("apps/guest/app", "");
  expect(pages.filter((p) => !(p in covered))).toEqual([]);
});

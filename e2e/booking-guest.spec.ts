import { execSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { checkPayPage } from "../apps/guest/pay-check.js";
import { SEED_COMMAND, SEED_INSTANT, setClock } from "./night.js";

/**
 * M5-17: Jae & co.'s booking end to end, the M5 done-when on the fake Stripe. The seed already holds
 * Jae's booking in Room 3, so the fixture drops it (its $50 deposit and its block on the room) to free a small room at
 * 11:00 PM. The clock goes to Wed Sep 23, 2 PM (the day the seed says Jae paid) to book, change and
 * cancel before the Thu 11:00 PM cut-off, and to Fri Sep 25, 10:41 PM to cancel after it.
 */
const DB = process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4";
const WED_2PM = "2026-09-23T18:00:00Z";
const JAE = { name: "Jae & co.", phone: "(347) 555-0165", email: "jae@example.com" };
const PAY = /^http:\/\/pay\.localhost:3001\/pay\//;
const BOOKED = /^http:\/\/localhost:3001\/v\/west4karaoke\/book\/[A-Za-z0-9_-]{22}$/;

/** Prints the Booking confirmed text for one booking, as the M5-10 job builds and renders it. */
const CONFIRM_TEXT = [
  "(async () => {",
  "const [venue, booking, now] = process.argv.slice(-3);",
  'const pg = (await import("pg")).default;',
  'const { Temporal } = await import("@west4/shared");',
  'const { confirmationText } = await import("./src/bookings/confirm.ts");',
  'const { render } = await import("./src/texts/queue.ts");',
  "const db = new pg.Client({ connectionString: process.env.DATABASE_URL });",
  "await db.connect();",
  'const t = await confirmationText(db, venue, booking, Temporal.Instant.from(now), "https://localhost:3001");',
  'const { rows } = await db.query("select body from message_templates where venue_id = $1 and key = $2", [venue, "booking_confirmed"]);',
  "console.log(JSON.stringify({ to: t.to, link: t.params.link, sms: render(rows[0].body, t.params) }));",
  "await db.end();",
  "})();",
].join(" ");

const dropJae = `
  with b as (select row_id as id from seed_ids where slug = 'bk_jae'),
       p as (select id from payments where booking_id = (select id from b)),
       e as (delete from payment_events where payment_id in (select id from p)),
       t as (delete from payment_attempts where booking_id = (select id from b) or payment_id in (select id from p)),
       a as (delete from payment_allocations where payment_id in (select id from p)),
       l as (delete from pay_links where booking_id = (select id from b)),
       k as (delete from booking_links where booking_id = (select id from b)),
       r as (delete from room_blocks where kind = 'booking' and ref_id = (select id from b))
  select 1`;

test.beforeEach(async ({ request }) => {
  execSync(SEED_COMMAND, { stdio: ["ignore", "ignore", "pipe"] });
  execSync("pnpm exec tsx src/stripe/seed-stripe.ts", {
    cwd: "apps/api",
    stdio: "ignore",
    env: { ...process.env, WEST4_ENV: "local", DATABASE_URL: DB },
  });
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  try {
    // The seed's settings start on its own night, Fri Sep 25; West 4 had them the Wednesday before too.
    await db.query(
      `update venue_settings s set starts_on = '2026-09-01'
        where starts_on = '2026-09-25' and not exists (
          select 1 from venue_settings e
           where e.venue_id = s.venue_id and e.key = s.key and e.starts_on < '2026-09-25')`,
    );
    await db.query(dropJae);
    await db.query(
      "delete from payments where booking_id = (select row_id from seed_ids where slug = 'bk_jae')",
    );
    await db.query(
      "delete from bookings where id = (select row_id from seed_ids where slug = 'bk_jae')",
    );
  } finally {
    await db.end();
  }
  expect(
    (
      await request.post("http://127.0.0.1:3000/v1/ops/clock", { data: { server_time: WED_2PM } })
    ).ok(),
  ).toBe(true);
});

test.afterEach(async () => {
  await setClock();
});

/** Books Jae & co. from the quote to the payment page, and returns the pay page's response. */
async function bookToPayPage(page: Page) {
  await page.goto("/v/west4karaoke/book?date=2026-09-25&guests=5&hours=2");
  const quote = page.locator(".quote");
  await expect(quote).toContainText("Room time, 2 hours for 5$100");
  await expect(quote).toContainText("Tax 8.875%$8.88");
  await expect(quote).toContainText("Gratuity 20%$20");
  await expect(quote).toContainText("Room time, all in$128.88");
  await expect(quote).toContainText("Deposit to hold it$50");
  await page.getByRole("button", { name: "Hold 11 PM EDT" }).click();
  await expect(page.getByText("Fri, Sep 25 · 11 PM · 5 guests · 2 hours")).toBeVisible();
  await page.getByLabel("Name").fill(JAE.name);
  await page.getByLabel("Mobile number").fill(JAE.phone);
  await page.getByLabel("Email").fill(JAE.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".terms")).toContainText("Free to cancel until Thu 11:00 PM");
  await expect(page.locator(".terms")).toContainText("A 20% gratuity is added to room tabs.");
  const doc = page.waitForResponse(
    (r) => PAY.test(r.url()) && r.request().resourceType() === "document",
  );
  await page.getByRole("button", { name: "Pay $50.00 deposit" }).click();
  await page.waitForURL(PAY);
  return doc;
}

test("Jae & co. book on Wed Sep 23: the whole price, the terms stored, $50.00 paid on the payment page, the text and the page agree; then change and cancel for a full refund", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Every request our own servers get from the browser, to show no card data reaches them.
  const ours: string[] = [];
  page.on("request", (r) => {
    if (/^http:\/\/(pay\.)?localhost:3001|^http:\/\/127\.0\.0\.1:3000/.test(r.url()))
      ours.push(`${r.url()} ${r.postData() ?? ""}`);
  });
  const payDoc = await bookToPayPage(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your deposit · $50.00");

  // The payment page's header, script and changed-script checks (M4-15) on the deposit flow.
  const html = await payDoc.text();
  const headers = payDoc.headers();
  const problems = checkPayPage({ html, headers, requireIntegrity: false });
  // Next's dev server says no-cache on a dynamic page; the production build says no-store (M4-15).
  expect(headers["cache-control"]).toMatch(/no-store|no-cache/);
  expect(problems.filter((p) => !p.startsWith("the Cache-Control header"))).toEqual([]);
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  const changed = html.replace(
    "</head>",
    '<script src="https://cdn.example.com/skim.js"></script></head>',
  );
  expect(checkPayPage({ html: changed, headers, requireIntegrity: false })).toContain(
    "an unlisted script: https://cdn.example.com/skim.js",
  );
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations())).toHaveLength(0);

  await page.getByRole("button", { name: "Pay $50.00 deposit" }).click();
  await page.waitForURL(BOOKED);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're booked");
  const confirmed = page.locator(".confirmed");
  await expect(confirmed).toContainText("A small room · Fri, Sep 25 · 11 PM · 5 guests · 2 hours");
  await expect(confirmed).toContainText("Deposit $50.00 paid · it comes off your bill");
  await expect(confirmed).toContainText("Free to cancel until Thu 11:00 PM");
  await expect(confirmed).toContainText("A 20% gratuity is added to room tabs.");
  await expect(confirmed).toContainText("We texted your confirmation to (347) 555-0165.");
  for (const line of ours) expect(line).not.toMatch(/4242|cvc|card\[number\]|card_number/i);

  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  try {
    // The accepted policy version is stored, and the deposit is a PaymentIntent on West 4's account.
    const b = (
      await db.query<{
        id: string;
        venue_id: string;
        kind: string;
        pi: string;
        paid: number;
      }>(
        `select b.id, b.venue_id, pv.kind, p.stripe_pi_id as pi, p.amount_cents::int as paid
           from bookings b join guests g on g.id = b.guest_id
           join policy_versions pv on pv.id = b.policy_version_id
           join payments p on p.booking_id = b.id and p.status = 'captured'
          where g.phone_e164 = '+13475550165' and b.status = 'confirmed'`,
      )
    ).rows;
    expect(b).toHaveLength(1);
    expect(b[0]!.pi).toMatch(/^pi_/);
    expect(b[0]!.paid).toBe(5000);

    // The Booking confirmed text, as the job would send it, agrees with the page.
    // The job's own builder runs in the API package, so the API's sources stay out of this typecheck.
    const text = JSON.parse(
      execSync(`pnpm exec tsx -e '${CONFIRM_TEXT}' ${b[0]!.venue_id} ${b[0]!.id} ${WED_2PM}`, {
        cwd: "apps/api",
        env: { ...process.env, DATABASE_URL: DB },
      }).toString(),
    ) as { to: string; sms: string; link: string };
    const sms = text.sms;
    expect(sms).toContain("Booked. Room for 5 at 11:00 PM, Fri Sep 25.");
    expect(sms).toContain("A 20% gratuity is added to room tabs.");
    expect(sms).toContain("Deposit $50 paid");
    expect(sms).toContain("Free to cancel until Thu 11:00 PM");
    expect(text.to).toBe("+13475550165");

    // The text's own link opens the same booking on the manage page.
    await page.goto(`/${text.link.split("/").slice(1).join("/")}`);
    const manage = page.getByRole("region", { name: "Your booking" });
    await expect(manage).toContainText("A small room · Fri, Sep 25 · 11 PM · 5 guests");
    await expect(manage).toContainText("Deposit $50.00 paid");

    // Manage changes it: 5 to 6 guests, the $10.00 difference paid on the payment page.
    await manage.getByRole("button", { name: "Change party size" }).click();
    await manage.getByRole("button", { name: "More guests" }).click();
    await manage.getByRole("button", { name: "Update to 6 guests" }).click();
    await expect(manage).toContainText("Your deposit becomes $60.00");
    await manage.getByRole("button", { name: "Confirm and pay $10.00" }).click();
    await page.waitForURL(PAY);
    await page.getByRole("button", { name: /^Pay \$10\.00/ }).click();
    await page.waitForURL(BOOKED);
    await expect(page.locator(".confirmed")).toContainText("6 guests · 2 hours");
    await expect(page.locator(".confirmed")).toContainText("Deposit $60.00 paid");
    const manageUrl = `/${text.link.split("/").slice(1).join("/")}`;
    await page.goto(manageUrl);
    await expect(manage).toContainText("6 guests");
    await expect(manage).toContainText("Deposit $60.00 paid");

    // Cancelled on Wed, before the Thu 11:00 PM cut-off in New York time: all of it goes back.
    await manage.getByRole("button", { name: "Cancel booking" }).click();
    await expect(page.getByRole("dialog", { name: "Cancel booking" })).toContainText(
      ": $60.00 goes back to your card.",
    );
    await page.getByRole("button", { name: "Yes, cancel" }).click();
    const cancelled = page.getByRole("region", { name: "Cancelled" });
    await expect(cancelled).toContainText(/Refund(ed)?( pending)? · \$60\.00/);
    await expect(cancelled).not.toContainText("Deposit kept");
    const refunds = await db.query<{ cents: number; reason: string }>(
      `select sum(r.amount_cents)::int as cents, min(r.reason) as reason
         from refunds r join payments p on p.id = r.payment_id where p.booking_id = $1`,
      [b[0]!.id],
    );
    expect(refunds.rows[0]).toEqual({ cents: 6000, reason: "Cancelled before the refund cut-off" });
  } finally {
    await db.end();
  }
});

test("Jae & co. book on Wed, then on Fri at 10:41 PM, with Online booking & deposits off, cancel after the cut-off and the deposit is kept", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  await bookToPayPage(page);
  await page.getByRole("button", { name: "Pay $50.00 deposit" }).click();
  await page.waitForURL(BOOKED);
  const href = await page.getByRole("link", { name: "Manage your booking" }).getAttribute("href");
  expect(href).toMatch(/^\/b\/[A-Za-z0-9_-]{22}$/);

  expect(
    (
      await request.post("http://127.0.0.1:3000/v1/ops/clock", {
        data: { server_time: SEED_INSTANT },
      })
    ).ok(),
  ).toBe(true);
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  await db.query("update venue_modules set state = 'off' where module_id = 'online_booking'");
  try {
    // The site says Call to book with West 4's number, and Jae's manage link still works.
    await page.goto("/");
    await expect(page.locator(".hero")).toContainText("Call to book · (212) 255-0011");
    await page.goto(href!);
    const manage = page.getByRole("region", { name: "Your booking" });
    await expect(manage).toContainText("You're past the refund cut-off (Thu 11:00 PM)");
    await manage.getByRole("button", { name: "Cancel booking" }).click();
    await expect(page.getByRole("dialog", { name: "Cancel booking" })).toContainText(
      "You're past the refund cut-off (Thu 11:00 PM): the $50.00 deposit is kept per our policy.",
    );
    await page.getByRole("button", { name: "Yes, cancel" }).click();
    const cancelled = page.getByRole("region", { name: "Cancelled" });
    await expect(cancelled).toContainText("Deposit kept per our policy · $50.00");
    const refunds = await db.query(
      `select 1 from refunds r join payments p on p.id = r.payment_id
         join guests g on g.id = (select guest_id from bookings where id = p.booking_id)
        where g.phone_e164 = '+13475550165'`,
    );
    expect(refunds.rowCount).toBe(0);
  } finally {
    await db.query("update venue_modules set state = 'on' where module_id = 'online_booking'");
    await db.end();
  }
});

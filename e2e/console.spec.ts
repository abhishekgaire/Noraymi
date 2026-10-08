import { expect, test } from "@playwright/test";
import pg from "pg";
import { setClock } from "./night.js";

// Put the shared clock back for whatever spec runs next, in this project or another.
test.afterEach(async () => {
  await setClock();
});

/**
 * The Console (M1-35). Our staff member signs in locally by email, then with a
 * FIDO2 security key (a virtual USB authenticator here), and reads West 4's
 * device health from the same rows as Admin → Printers & devices: 13 of 14
 * room tablets online, both readers online, "Backup internet · on". Opening
 * West 4 shows the module allow-list and the venue flags.
 */
test("our staff sign in with a security key and read West 4's health, modules and flags", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  const clean = async () => {
    await db.query("delete from console_sessions");
    await db.query("delete from console_challenges");
    await db.query("delete from console_credentials");
    await db.query("delete from support_grants where reason like 'E2E %'");
  };
  try {
    // A fresh start: the seed keeps our staff's enrolled keys, so an earlier run's key would be asked for.
    await clean();
    await page.setViewportSize({ width: 1280, height: 800 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "usb",
        hasResidentKey: false,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Console");
    await page.getByLabel("Work email").fill("support@demo.west4.local");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Use your security key" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Venues" })).toBeVisible();
    await expect(page.getByText("Noraymi support · support@demo.west4.local")).toBeVisible();
    const key = await db.query("select 1 from console_credentials where revoked_at is null");
    expect(key.rowCount).toBeGreaterThan(0);

    // Pages (M8-17): nobody is on call in the demo until we set the rota, and nothing is open.
    const pages = page.getByRole("region", { name: "Pages" });
    await expect(pages).toContainText("First · nobody yet · Second · nobody yet");
    await expect(pages).toContainText("Nobody is on call yet.");
    await expect(pages).toContainText("No open pages.");

    const west4 = page.getByRole("button", { name: /West 4 Boho Karaoke/ });
    await expect(west4).toContainText("13 of 14 room tablets online");
    await expect(west4).toContainText("2 of 2 readers online");
    await expect(west4).toContainText("Backup internet · on");
    await west4.click();
    await expect(
      page.getByRole("heading", { level: 2, name: "West 4 Boho Karaoke" }),
    ).toBeVisible();
    const row = page.getByRole("row", { name: /^Bar screen & tickets / });
    await expect(row).toContainText("On");
    await expect(row).toContainText("Allowed");
    await expect(page.getByRole("row", { name: /^Kitchen & food / })).toHaveCount(0);
    await expect(page.getByRole("row", { name: /^Payments & checks / })).toContainText("Always on");
    await expect(page.getByText("No flags set")).toBeVisible();

    // Support access (M8-10): ask with a reason, wait for the owner, then the open grant.
    const support = page.getByRole("region", { name: "Support access" });
    await support.getByLabel("Reason").fill("E2E checking a stuck ticket");
    await support.getByLabel(/Minutes/).fill("30");
    await support.getByRole("button", { name: "Request access" }).click();
    await expect(support.getByText("Waiting for West 4 Boho Karaoke to approve")).toBeVisible();
    // Abhishek's approval in Admin → Console (staff.spec.ts covers that screen), at a known moment.
    const at = "2026-09-26T02:41:00Z";
    const clock = await page.request.post("http://127.0.0.1:3000/v1/ops/clock", {
      data: { server_time: at },
    });
    expect(clock.ok()).toBe(true);
    await db.query(
      `update support_grants g set status = 'approved', decided_at = $1, starts_at = $1,
              ends_at = $1::timestamptz + interval '30 minutes',
              approved_by = (select m.user_id from memberships m where m.venue_id = g.venue_id and m.role = 'owner' limit 1)
        where reason = 'E2E checking a stuck ticket' and status = 'requested'`,
      [at],
    );
    await page.reload();
    await page.getByRole("button", { name: /West 4 Boho Karaoke/ }).click();
    await expect(support.getByText(/^Open · (30:00|29:[0-5]\d) left/)).toBeVisible();
    const guests = support.getByRole("table").first();
    await expect(guests.getByRole("row").nth(1)).toBeVisible();
    await expect(guests).not.toContainText("+1");
    await expect(guests.getByText(/^••• ••• \d\d$/).first()).toBeVisible();
    await support.getByRole("button", { name: "End now" }).click();
    await expect(support.getByRole("button", { name: "Request access" })).toBeVisible();
    await expect(support.getByText(/^Ended early · read · 30 min/)).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Work email")).toBeVisible();
  } finally {
    await clean();
    await db.end();
  }
});

/**
 * The emergency path (M8-11). Our support account asks to requeue a bar ticket that never
 * printed; it waits, and the one who asked sees only Withdraw. A second person on our side
 * (Ben, in his own Console session with his own security key) approves it, it runs, the ticket
 * comes back as REPRINT 2, and Abhishek has a push and an email naming both and the reason.
 */
test("an emergency requeue waits for a second person on our side, then prints REPRINT 2", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  const clean = async () => {
    await db.query("delete from console_sessions");
    await db.query("delete from console_challenges");
    await db.query("delete from console_credentials");
    await db.query("delete from emergency_actions where reason like 'E2E %'");
  };
  const signIn = async (email: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "usb",
        hasResidentKey: false,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto("http://localhost:5174/");
    await page.getByLabel("Work email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Use your security key" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Venues" })).toBeVisible();
    await page.getByRole("button", { name: /West 4 Boho Karaoke/ }).click();
    return { context, page, region: page.getByRole("region", { name: "Emergency actions" }) };
  };
  try {
    await clean();
    await db.query(
      `insert into console_staff (name, email) values ('Ben on call', 'oncall@demo.west4.local')
         on conflict ((lower(email))) do update set active = true`,
    );
    const venueId = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    const job = (
      await db.query<{ id: string }>(
        `insert into print_jobs (venue_id, kind, station, payload, status, failed_at)
         values ($1, 'ticket', 'bar', '{"room":"Room 5","lines":[{"qty":4,"name":"Bud Light","options":[]}]}', 'failed', now())
         returning id`,
        [venueId],
      )
    ).rows[0]!.id;

    const ana = await signIn("support@demo.west4.local");
    await ana.region
      .getByRole("combobox", { name: "Action", exact: true })
      .selectOption("requeue_print");
    await ana.region.getByLabel("Print job id").fill(job);
    await ana.region.getByLabel("Why").fill("E2E bar printer jammed, Room 5's ticket lost");
    await ana.region.getByRole("button", { name: "Ask for a second approver" }).click();
    const asked = ana.region.getByRole("listitem").filter({ hasText: "E2E bar printer jammed" });
    await expect(asked).toContainText("Waiting for a second approver");
    await expect(asked.getByRole("button", { name: "Withdraw" })).toBeVisible();
    await expect(asked.getByRole("button", { name: "Approve and run" })).toHaveCount(0);
    expect((await db.query("select 1 from print_jobs where reprint_of = $1", [job])).rowCount).toBe(
      0,
    );

    const ben = await signIn("oncall@demo.west4.local");
    const waiting = ben.region.getByRole("listitem").filter({ hasText: "E2E bar printer jammed" });
    await waiting.getByRole("button", { name: "Approve and run" }).click();
    await expect(waiting).toContainText("Done");
    await expect(waiting).toContainText("Ben on call");
    const reprint = await db.query<{ reprint_n: number }>(
      "select reprint_n from print_jobs where reprint_of = $1",
      [job],
    );
    expect(reprint.rows.map((r) => r.reprint_n)).toEqual([2]);
    const told = await db.query<{ kind: string }>(
      `select j.kind from jobs j join emergency_actions e on j.dedupe_key like 'emergency:' || e.id || ':done:%'
        where e.reason like 'E2E %' order by j.kind`,
    );
    expect(told.rows.map((r) => r.kind)).toEqual(["email.send", "push.send"]);
    await ana.context.close();
    await ben.context.close();
  } finally {
    await clean();
    await db
      .query("delete from console_staff where email = 'oncall@demo.west4.local'")
      .catch(() => {});
    await db.end();
  }
});

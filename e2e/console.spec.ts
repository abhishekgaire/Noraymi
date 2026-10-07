import { expect, test } from "@playwright/test";
import pg from "pg";

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

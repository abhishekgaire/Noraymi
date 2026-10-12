import { execSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { SEED_COMMAND, setClock } from "./night.js";
import { CONSOLE, DB, STRIPE } from "./stack.js";

/*
 * O-14 runs in its own project, after every other spec: the venue it onboards keeps its rooms,
 * reader, drawer and checks (nothing wipes a venue but West 4's seed), and the other specs read
 * West 4's rows by name or kind.
 */

/** The newest invite link a text or an email carried to this address. */
async function inviteLink(db: pg.Client, kind: "text.send" | "email.send", to: string) {
  const job = await db.query<{ p: string }>(
    "select payload::text as p from jobs where kind = $1 and payload->>'to' = $2 order by created_at desc limit 1",
    [kind, to],
  );
  const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(job.rows[0]?.p ?? "")?.[1];
  expect(token, `an invite link to ${to}`).toBeTruthy();
  return `/invite/${token}`;
}

/** The invite page: the phone confirmed with the texted code, then a PIN (M1-23). */
async function acceptInvite(page: Page, db: pg.Client, link: string, phone: string, pin: string) {
  await page.goto(link);
  await page.getByLabel("Your mobile number").fill(phone);
  await page.getByRole("button", { name: "Text me a code" }).click();
  await expect(page.getByText(`We texted a code to ${phone}`)).toBeVisible();
  const text = await db.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'text.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [phone],
  );
  await page.getByLabel("The code from the text").fill(text.rows[0]!.payload.data.code);
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.getByLabel("Choose your PIN", { exact: true }).fill(pin);
  await page.getByLabel("Type it again").fill(pin);
  await page.getByRole("button", { name: "Set my PIN" }).click();
}

/** West 4's night, to show a new venue's onboarding leaves it alone. */
async function west4Night(db: pg.Client) {
  return (
    await db.query(
      `select (select count(*) from rooms r where r.venue_id = v.id)::int as rooms,
              (select count(*) from checks c where c.venue_id = v.id)::int as checks,
              (select coalesce(sum(p.amount_cents), 0) from payments p where p.venue_id = v.id)::text as paid,
              (select count(*) from menu_items i where i.venue_id = v.id)::int as items,
              (select count(*) from venue_settings s where s.venue_id = v.id)::int as settings,
              (select count(*) from devices d where d.venue_id = v.id)::int as devices,
              (select count(*) from memberships m where m.venue_id = v.id)::int as people,
              (select count(*) from cash_drawers w where w.venue_id = v.id)::int as drawers
         from venues v where v.slug = 'west4karaoke'`,
    )
  ).rows[0];
}

/**
 * O-14: a venue onboarded from nothing, by its owner alone. From a fresh demo seed our Console
 * makes "Test Karaoke" and sends its owner's invite; the owner joins from the emailed link (phone,
 * PIN, passkey), picks Rooms + Kitchen with the fake's test promo code, connects the fake Stripe,
 * enters 3 rooms and prices, hours, no deposit with Keep the card behind the bar, the money
 * answers, a menu, a manager (who sets his PIN from his own texted link), the on-call and breach
 * contacts and the liquor license, registers a simulated reader and a printer with its drawer,
 * checks the merchant category, reaches Ready to open and finishes setup. Then a walk-in is
 * seated and closed out on the new venue. No SQL writes, no ops command; West 4's night is unchanged.
 */
test("O-14 · Test Karaoke from the Console to Ready to open, then a walk-in closed out", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  execSync(SEED_COMMAND, { stdio: ["ignore", "ignore", "pipe"] });
  await setClock();
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  const n = Date.now().toString(36);
  const ownerEmail = `owner-${n}@example.com`;
  const ownerPhone = "+12125550161";
  const managerPhone = "+12125550162";
  const consoleContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const managerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const before = await west4Night(db);
    // The plans' Prices on the fake Stripe (made-up test amounts), unless an earlier test made them.
    for (const [lookup_key, unit_amount] of [
      ["west4_plan_rooms_kitchen", 3300],
      ["west4_plan_room", 300],
    ] as const) {
      const have = await request.get(`${STRIPE}/v1/prices?lookup_keys[]=${lookup_key}`, {
        headers: { authorization: "Bearer rk_test_fake_billing" },
      });
      if (((await have.json()) as { data: unknown[] }).data.length > 0) continue;
      const made = await request.post(`${STRIPE}/v1/prices`, {
        headers: {
          authorization: "Bearer rk_test_fake_billing",
          "idempotency-key": `e2e-onboard-${n}-${lookup_key}`,
        },
        form: { currency: "usd", unit_amount, lookup_key },
      });
      expect(made.ok(), await made.text()).toBe(true);
    }

    // Our Console makes the venue and sends its owner's invite (O-01). A security key another
    // spec enrolled for our staff member lives in that spec's browser, so this one starts clean.
    await db.query("delete from console_sessions");
    await db.query("delete from console_challenges");
    await db.query("delete from console_credentials");
    const consolePage = await consoleContext.newPage();
    const cdp = await consoleContext.newCDPSession(consolePage);
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
    await consolePage.goto(`${CONSOLE}/`);
    await consolePage.getByLabel("Work email").fill("support@demo.west4.local");
    await consolePage.getByRole("button", { name: "Continue" }).click();
    await consolePage.getByRole("button", { name: "Use your security key" }).click();
    await expect(consolePage.getByRole("heading", { level: 2, name: "Venues" })).toBeVisible();
    await consolePage.getByRole("button", { name: "New venue" }).click();
    await consolePage.getByLabel("Venue name (what guests see)").fill("Test Karaoke");
    await consolePage.getByLabel(/^Web name/).fill(`test-karaoke-${n}`);
    await consolePage.getByLabel("Legal name").fill(`Test Karaoke ${n} LLC`);
    await consolePage.getByLabel("Owner's name").fill("Rita Moreno");
    await consolePage.getByLabel("Owner's email").fill(ownerEmail);
    await consolePage.getByLabel("Why (kept with the venue)").fill("O-14 onboarding check");
    await consolePage.getByRole("button", { name: "Make the venue" }).click();
    await expect(
      consolePage.getByRole("heading", { level: 2, name: "Test Karaoke" }),
    ).toBeVisible();
    await consolePage.getByRole("button", { name: "Send the owner's invite", exact: true }).click();
    await expect(
      consolePage.getByText(`Sent to ${ownerEmail} · the link works for 7 days`),
    ).toBeVisible();

    // The owner joins from the emailed link on her phone: the phone, a PIN, then a passkey, which
    // her password manager syncs to her laptop (copied between the two virtual authenticators).
    const authenticator = {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    } as const;
    const ownerPhonePage = await managerContext
      .browser()!
      .newContext({
        viewport: { width: 390, height: 844 },
      })
      .then((c) => c.newPage());
    const phoneCdp = await ownerPhonePage.context().newCDPSession(ownerPhonePage);
    await phoneCdp.send("WebAuthn.enable");
    const phoneKey = await phoneCdp.send("WebAuthn.addVirtualAuthenticator", {
      options: authenticator,
    });
    await acceptInvite(
      ownerPhonePage,
      db,
      await inviteLink(db, "email.send", ownerEmail),
      ownerPhone,
      "739158",
    );
    await expect(ownerPhonePage.getByRole("heading", { level: 2 })).toHaveText("Add a passkey");
    await ownerPhonePage.getByRole("button", { name: "Add a passkey" }).click();
    await expect(
      ownerPhonePage.getByText("You're set · sign in with your passkey to set up your venue"),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    const laptopCdp = await page.context().newCDPSession(page);
    await laptopCdp.send("WebAuthn.enable");
    const laptopKey = await laptopCdp.send("WebAuthn.addVirtualAuthenticator", {
      options: authenticator,
    });
    const synced = await phoneCdp.send("WebAuthn.getCredentials", {
      authenticatorId: phoneKey.authenticatorId,
    });
    expect(synced.credentials).toHaveLength(1);
    await laptopCdp.send("WebAuthn.addCredential", {
      authenticatorId: laptopKey.authenticatorId,
      credential: synced.credentials[0]!,
    });
    await ownerPhonePage.context().close();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(ownerEmail);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page).toHaveURL(/\/set-up$/);
    const rail = page.getByRole("navigation", { name: "Setup steps" });

    // Step 1: the venue.
    await expect(page.getByRole("heading", { level: 2, name: "Your venue" })).toBeVisible();
    await expect(page.getByLabel("Legal name")).toHaveValue(`Test Karaoke ${n} LLC`);
    await page.getByLabel("Street", { exact: true }).fill("100 Test St");
    await page.getByLabel("City").fill("New York");
    await page.getByLabel("State").fill("NY");
    await page.getByLabel("ZIP code").fill("10012");
    await page.getByLabel("Number guests call").fill("+1 212 555 0160");
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 2: Rooms + Kitchen with the test promo code, through the fake Checkout.
    await expect(page.getByRole("heading", { level: 2, name: "Your plan" })).toBeVisible();
    await page.getByLabel("Private rooms").check();
    await page.getByLabel("A kitchen").check();
    await page
      .getByRole("radiogroup", { name: "Choose a plan" })
      .getByRole("radio", { name: /Rooms \+ Kitchen plan/ })
      .click();
    await page.getByLabel("Promo code").fill("FAKEFIRSTMONTH");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByText("First month free")).toBeVisible();
    await page.getByRole("button", { name: "Start plan" }).click();
    await expect(page.getByText("Rooms + Kitchen plan · started")).toBeVisible({
      timeout: 30_000,
    });

    // Step 3: Connect with Stripe (the fake's hosted onboarding).
    await rail.getByRole("button", { name: /Card payments/ }).click();
    await page.getByRole("button", { name: "Connect with Stripe" }).click();
    await expect(
      page.getByText(`Connected through Test Karaoke ${n} LLC · card payments on`),
    ).toBeVisible({ timeout: 30_000 });

    // Step 4: three rooms and the room price.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Rooms and prices" })).toBeVisible();
    for (const [name, most] of [
      ["Room 1", "6"],
      ["Room 2", "8"],
      ["Room 3", "12"],
    ] as const) {
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Fewest guests", { exact: true }).fill("2");
      await page.getByLabel("Most guests", { exact: true }).fill(most);
      await page.getByRole("button", { name: "Add a room" }).click();
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    await page.getByLabel("How rooms are priced").selectOption("perPerson");
    await page.getByLabel("Per person an hour ($)").fill("9.50");
    await page.getByLabel("Billed in steps of").selectOption("15");
    await page.getByLabel("Rounding a step").selectOption("up");
    await page.getByLabel("At least this many guests, weeknights").fill("2");
    await page.getByLabel("At least this many guests, Friday and Saturday").fill("2");
    await page.getByLabel("Shortest booking (hours)").fill("1");
    await page.getByLabel("Longest booking (hours)").fill("4");
    await page.getByLabel("Most guests in a booking").fill("12");
    await page.getByLabel("Damage fee ($)").fill("50");
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 5: Friday's hours and the age policy; the kitchen's times stay empty (optional).
    await expect(page.getByRole("heading", { level: 2, name: "Hours" })).toBeVisible();
    await page.getByLabel("Fri · Opens").fill("17:00");
    await page.getByLabel("Fri · Closes").fill("04:00");
    await page.getByLabel("House last call").fill("03:30");
    await page.getByLabel("21 and over", { exact: true }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 6: no deposit online; a walk-in check-in keeps the card behind the bar.
    await expect(
      page.getByRole("heading", { level: 2, name: "Deposits and check-in" }),
    ).toBeVisible();
    await page.getByLabel("Deposit", { exact: true }).selectOption("off");
    await page.getByLabel("No-show after (minutes late)").fill("15");
    await page.getByLabel("Keep the card behind the bar").check();
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 7: no cash discount, no tip screen on the reader, house drawers with a starting bank.
    await expect(
      page.getByRole("heading", { level: 2, name: "Money at the counter" }),
    ).toBeVisible();
    await page.getByLabel("Added to").selectOption("off");
    await page.getByLabel("Ask for a tip on the reader").selectOption("no");
    await page.getByLabel("Flag a tip over (%)").fill("30");
    await page.getByLabel("Flag a tip over ($)").fill("60");
    await page.getByLabel("Flag a tip entered this many hours late").fill("3");
    await page.getByLabel("How the pool splits").selectOption("hours");
    await page.getByLabel(/^Pay my share/).selectOption("no");
    await page.getByLabel("Hold a card at room check-in").selectOption("no");
    await page.getByLabel("Drawer model").selectOption("house");
    await page.getByLabel("Starting bank, $").fill("250");
    await page.getByLabel("A count off by more than this needs a note, $").fill("10");
    await page.getByLabel("Second counter").selectOption("never");
    await page.getByLabel("Paid-outs need approval over, $").fill("40");
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 8: the menu from a spreadsheet (Sing Sing's file, a dry run, then Looks right).
    await expect(page.getByRole("heading", { level: 2, name: "Menu" })).toBeVisible();
    const dir = "docs/venues/sing-sing/import";
    await page
      .getByLabel("Spreadsheet files")
      .setInputFiles([`${dir}/mapping.json`, `${dir}/items.csv`, `${dir}/choices.csv`]);
    await page.getByRole("button", { name: "Check the file" }).click();
    await expect(page.getByText(/^179 menu lines/)).toBeVisible();
    await page.getByRole("button", { name: "Looks right" }).click();
    await expect(page.getByText("Saved: 179 new menu lines")).toBeVisible();
    await expect(rail.getByRole("button", { name: /Menu/ })).toContainText("Done");

    // Step 9: a manager invited by phone; the owner on call and the breach contact.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Team and contacts" })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Leo Park");
    await page.getByLabel("Mobile phone").fill(managerPhone);
    await page.getByLabel("Role").selectOption("manager");
    await page.getByRole("button", { name: "Send the invite" }).click();
    await expect(page.getByText(`Invite sent to ${managerPhone}`)).toBeVisible();
    await page.getByLabel("Who").first().selectOption({ label: "Rita Moreno · Owner" });
    await page.getByRole("checkbox", { name: "Fri" }).check();
    await page.getByRole("checkbox", { name: "Sat" }).check();
    await page.getByLabel("First on call · From").fill("18:00");
    await page.getByLabel("First on call · Until").fill("04:00");
    await page
      .getByRole("combobox", { name: "Breach contact" })
      .selectOption({ label: "Rita Moreno · Owner" });
    await page.getByRole("button", { name: "Continue" }).click();
    // The manager sets his PIN from the link texted to his own phone.
    const managerPage = await managerContext.newPage();
    await acceptInvite(
      managerPage,
      db,
      await inviteLink(db, "text.send", managerPhone),
      managerPhone,
      "582047",
    );
    await expect(managerPage.getByRole("status")).toHaveText(
      "You're set · sign in with your badge or name and PIN",
    );

    // Step 10: the liquor license.
    await expect(page.getByRole("heading", { level: 2, name: "Licenses" })).toBeVisible();
    const register = page.getByRole("region", { name: "Licenses" });
    await register.getByRole("button", { name: "Add a license" }).click();
    await register.getByLabel("Kind").selectOption("liquor");
    await register.getByLabel("Number").fill("TEST-LIQUOR-1");
    await register.getByLabel("Expires").fill("2027-06-30");
    await register.getByRole("button", { name: "Save" }).click();
    await expect(rail.getByRole("button", { name: /^\d* ?Licenses/ })).toContainText("Done");

    // Step 11 is optional: skipped. Step 12: a simulated reader, a printer with its drawer.
    await rail.getByRole("button", { name: /Devices and checks/ }).click();
    await page.getByRole("link", { name: "Open Admin → Printers & devices" }).click();
    await page.getByLabel("Name staff pick").fill("Bar S710");
    await page.getByLabel("Registration code").fill("simulated-s710");
    await page.getByRole("button", { name: "Register", exact: true }).click();
    await expect(page.getByText("Bar S710 is registered")).toBeVisible();
    await page.getByLabel("Printer name").fill("Bar printer");
    await page.getByLabel("Station").selectOption("bar");
    await page.getByRole("button", { name: "Add a printer" }).click();
    await page.getByLabel("Drawer name").fill("Bar drawer");
    await page.getByLabel("On the kick port of").selectOption({ label: "Bar printer" });
    await page.getByRole("button", { name: "Add the drawer" }).click();
    await expect(page.getByText("On Bar printer's kick port")).toBeVisible();
    await page.goto("/set-up/devices");
    const golive = page.getByRole("region", { name: "Go-live checklist" });
    await expect(async () => {
      await golive.getByLabel("The category we expect").fill("5813");
      await golive.getByRole("button", { name: "Save the category" }).click();
      await expect(golive.getByText("Checked: Stripe has 5813")).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });

    // Ready to open: Finish setup, with Online booking & deposits left off.
    await expect(page.getByText("Ready to open", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Finish setup" }).click();
    const confirm = page.getByRole("dialog", { name: "Finish setup?" });
    await confirm.getByRole("button", { name: "Finish setup" }).click();
    await expect(page.getByText("Setup finished · your venue's facts are in")).toBeVisible();
    const venue = await db.query<{ id: string; done: boolean }>(
      "select id, setup_completed_at is not null as done from venues where slug = $1",
      [`test-karaoke-${n}`],
    );
    expect(venue.rows[0]!.done).toBe(true);

    // A walk-in on Room 1: the card behind the bar, then close-out in cash and the card given back.
    await page.goto("/tonight");
    const room1 = page.getByRole("region", { name: "Room 1", exact: true });
    await page
      .getByRole("listitem", { name: "Room 1", exact: true })
      .getByRole("button")
      .first()
      .click();
    await expect(room1).toBeVisible();
    await room1.getByRole("button", { name: "+ Walk-in" }).click();
    const dialog = page.getByRole("dialog", { name: "Walk-in · Room 1" });
    await dialog.getByLabel("1 · Guests").fill("4");
    await dialog.getByRole("button", { name: "Seat them" }).click();
    const held = page.getByRole("dialog", { name: "Card behind the bar · Room 1" });
    await held.getByLabel("Name on the card").fill("Sam Lee");
    await held.getByLabel("Last 4 digits").fill("1881");
    await held.getByRole("button", { name: "Save the card" }).click();
    await expect(held).toHaveCount(0);
    await setClock("2026-09-26T03:11:00Z");
    const roomId = (
      await db.query<{ id: string }>(
        "select id from rooms where venue_id = $1 and name = 'Room 1'",
        [venue.rows[0]!.id],
      )
    ).rows[0]!.id;
    await page.goto(`/room/${roomId}`);
    await page
      .getByRole("region", { name: "Present the check" })
      .getByRole("button", { name: "Present the check" })
      .click();
    const cash = page.getByRole("region", { name: "Cash" });
    await cash.getByRole("button", { name: /^Exact \$/ }).click();
    await cash.getByRole("button", { name: /^Take \$[\d.,]+ in cash$/ }).click();
    const giveBack = page.getByRole("group", { name: "Give the card back" });
    await expect(giveBack).toContainText("SAM LEE ···· 1881");
    await giveBack.getByRole("button", { name: "Returned" }).click();
    await expect(page.getByText("Card given back")).toBeVisible();
    const check = await db.query<{ status: string }>(
      "select status from checks where venue_id = $1",
      [venue.rows[0]!.id],
    );
    expect(check.rows.map((r) => r.status)).toEqual(["paid"]);

    // West 4's night is as the seed left it.
    expect(await west4Night(db)).toEqual(before);
  } finally {
    await setClock();
    await consoleContext.close();
    await managerContext.close();
    await db.end();
  }
});

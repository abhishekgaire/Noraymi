import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import pg from "pg";
import { SEED_COMMAND, setClock } from "./night.js";
import { CONSOLE, DB, STRIPE } from "./stack.js";

/**
 * Set up your venue (O-02): a venue our Console made, its owner signed in with
 * a passkey. Signing in opens the wizard at step 1; Skip for now marks a
 * required step "Needed before you open"; Save and finish later leaves for the
 * owner's home. Step 1 saved with Continue (O-03: an address outside New York
 * refused first) stays done when the owner signs in again, and the wizard
 * opens the next step not done; the last step lists what's missing and Finish setup stays off.
 * Admin → Setup shows the same count.
 */
async function postAuth(request: APIRequestContext, path: string, data: unknown) {
  for (let i = 0; ; i++) {
    const r = await request.post(path, { data });
    if (r.status() !== 429 || i >= 3) return r;
    await new Promise((done) => setTimeout(done, 20_000));
  }
}

async function enrolPasskey(page: Page, request: APIRequestContext, db: pg.Client, email: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  expect((await postAuth(request, "/v1/auth/enroll", { step: "start", email })).ok()).toBe(true);
  const job = await db.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [email],
  );
  const code = job.rows[0]!.payload.data.code;
  const options = (await (
    await postAuth(request, "/v1/auth/enroll", { step: "passkey_options", email, code })
  ).json()) as { options: unknown };
  const registration = await page.evaluate(async (opts) => {
    const { PublicKeyCredential } = window as unknown as {
      PublicKeyCredential: {
        parseCreationOptionsFromJSON(o: unknown): PublicKeyCredentialCreationOptions;
      };
    };
    const cred = (await navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts),
    })) as PublicKeyCredential & { toJSON(): unknown };
    return cred.toJSON();
  }, options.options);
  const enrolled = await postAuth(request, "/v1/auth/enroll", {
    step: "passkey_finish",
    email,
    code,
    credential: registration,
    name: "Setup test",
    client: "web",
  });
  expect(enrolled.status(), await enrolled.text()).toBe(201);
}

test("the owner saves, skips, leaves and resumes Set up your venue at the next step not done", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  const n = Date.now().toString(36);
  const email = `owner-${n}@example.com`;
  try {
    // A venue as the Console's New venue makes it (O-01): the organization, the venue, an owner.
    const staff = await db.query<{ id: string }>(
      `insert into console_staff (name, email) values ('E2E staff', 'e2e-setup@noraymi.test')
         on conflict ((lower(email))) do update set active = true returning id`,
    );
    const org = await db.query<{ id: string }>(
      "insert into organizations (legal_name) values ($1) returning id",
      [`E2E Setup ${n} LLC`],
    );
    const venue = await db.query<{ id: string }>(
      `insert into venues (org_id, name, slug, rule_pack_id)
         values ($1, $2, $3, 'us-ny-new-york-county') returning id`,
      [org.rows[0]!.id, `E2E Setup ${n}`, `e2e-setup-${n}`],
    );
    const venueId = venue.rows[0]!.id;
    const user = await db.query<{ id: string }>(
      "insert into users (name, email) values ('Jin Park', $1) returning id",
      [email],
    );
    await db.query(
      "insert into memberships (venue_id, user_id, role, status, pin_digits) values ($1, $2, 'owner', 'active', 6)",
      [venueId, user.rows[0]!.id],
    );
    await db.query(
      "insert into venue_onboarding (venue_id, created_by, reason) values ($1, $2, 'E2E setup')",
      [venueId, staff.rows[0]!.id],
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in");
    await enrolPasskey(page, request, db, email);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();

    // Signing in opens the wizard at the first step not done.
    await expect(page).toHaveURL(/\/set-up$/);
    await expect(page.getByRole("heading", { level: 2, name: "Your venue" })).toBeVisible();
    await expect(page.getByText("Step 1 of 12 · Required")).toBeVisible();
    await expect(page.getByText("0 of 12 done")).toBeVisible();
    const rail = page.getByRole("navigation", { name: "Setup steps" });
    await expect(rail.getByRole("button", { name: /Your venue/ })).toContainText("Needs attention");

    // Step 1's form (O-03): an address outside New York is refused, and Continue stays put.
    await page.getByLabel("Street", { exact: true }).fill("1 Hudson St");
    await page.getByLabel("City").fill("Hoboken");
    await page.getByLabel("State").fill("NJ");
    await page.getByLabel("ZIP code").fill("07030");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("This address is outside New York · contact us")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Your venue" })).toBeVisible();
    // Then the real address, the number guests call and a booking inbox address: Continue saves it.
    await page.getByLabel("Street", { exact: true }).fill("31-18 Steinway St");
    await page.getByLabel("City").fill("Astoria");
    await page.getByLabel("State").fill("NY");
    await page.getByLabel("ZIP code").fill("11103");
    await page.getByLabel("Number guests call").fill("+1 718 555 0100");
    await page.getByRole("button", { name: "Add an address" }).click();
    await page.getByLabel("Booking inbox address 1").fill(`bookings-${n}@example.com`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Your plan" })).toBeVisible();
    await expect(rail.getByRole("button", { name: /Your venue/ })).toContainText("Done");
    await expect(page.getByText("1 of 12 done")).toBeVisible();

    // Skip for now on Your plan: it stays needed before opening.
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Card payments" })).toBeVisible();
    await expect(rail.getByRole("button", { name: /Your plan/ })).toContainText(
      "Needed before you open",
    );

    // Save and finish later leaves for the owner's home.
    await page.getByRole("button", { name: "Save and finish later" }).click();
    await expect(page).toHaveURL(/\/tonight$/);

    // Signing in again, as on another device, opens the next step not done: Card payments.
    await page.context().clearCookies();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Card payments" })).toBeVisible();
    await expect(page.getByText("1 of 12 done")).toBeVisible();
    await expect(rail.getByRole("button", { name: /Your venue/ })).toContainText("Done");

    // The last step: not ready, each missing step with a link, Finish setup off.
    await rail.getByRole("button", { name: /Devices and checks/ }).click();
    await expect(page.getByText("Not ready to open yet")).toBeVisible();
    await expect(page.getByText("Step 2 · Your plan · a started plan")).toBeVisible();
    await expect(page.getByRole("button", { name: "Finish setup" })).toBeDisabled();

    // Admin → Setup reads the same count.
    await page.goto("/admin/setup");
    await expect(page.getByText("1 of 12 done")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Set up your venue" })).toBeVisible();

    // Admin → Venue and Admin → Phone & texts show step 1's answers.
    await page.goto("/admin/venue");
    await expect(page.getByLabel("City")).toHaveValue("Astoria");
    await expect(page.getByLabel("Number guests call")).toHaveValue("+17185550100");
    await expect(page.getByLabel("Booking inbox address 1")).toHaveValue(
      `bookings-${n}@example.com`,
    );
    await expect(page.getByLabel("Legal name")).toHaveValue(`E2E Setup ${n} LLC`);
    await page.goto("/admin/phone");
    await expect(page.getByLabel("Call number", { exact: true })).toHaveValue("+17185550100");
    await expect(
      page.getByText("Not set yet · our team sets up your texting number"),
    ).toBeVisible();
  } finally {
    await db.end();
  }
});

test("Your plan through Stripe Checkout (O-04), Connect with Stripe (O-05), rooms, prices and hours (O-06)", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  const n = Date.now().toString(36);
  const email = `plan-${n}@example.com`;
  try {
    // The plans' Prices on the fake Stripe, made-up test amounts; Rooms + Kitchen's is missing.
    for (const [lookup_key, unit_amount] of [
      ["west4_plan_bar", 1100],
      ["west4_plan_rooms", 2200],
      ["west4_plan_room", 300],
    ] as const) {
      const made = await request.post(`${STRIPE}/v1/prices`, {
        headers: {
          authorization: "Bearer rk_test_fake_billing",
          "idempotency-key": `e2e-${n}-${lookup_key}`,
        },
        form: { currency: "usd", unit_amount, lookup_key },
      });
      expect(made.ok(), await made.text()).toBe(true);
    }
    const org = await db.query<{ id: string }>(
      "insert into organizations (legal_name) values ($1) returning id",
      [`E2E Plan ${n} LLC`],
    );
    const venue = await db.query<{ id: string }>(
      `insert into venues (org_id, name, slug, rule_pack_id)
         values ($1, $2, $3, 'us-ny-new-york-county') returning id`,
      [org.rows[0]!.id, `E2E Plan ${n}`, `e2e-plan-${n}`],
    );
    const user = await db.query<{ id: string }>(
      "insert into users (name, email) values ('Mina Cho', $1) returning id",
      [email],
    );
    await db.query(
      "insert into memberships (venue_id, user_id, role, status, pin_digits) values ($1, $2, 'owner', 'active', 6)",
      [venue.rows[0]!.id, user.rows[0]!.id],
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in");
    await enrolPasskey(page, request, db, email);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page).toHaveURL(/\/(set-up|tonight)/);
    await page.goto("/set-up/plan");
    await expect(page.getByRole("heading", { level: 2, name: "Your plan" })).toBeVisible();

    // What you run points to Rooms; Rooms + Kitchen has no Price in Stripe yet.
    await page.getByLabel("Private rooms").check();
    const cards = page.getByRole("radiogroup", { name: "Choose a plan" });
    await expect(cards.getByRole("radio", { name: /Rooms plan.*Recommended/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(cards.getByRole("radio", { name: /Rooms \+ Kitchen plan/ })).toContainText(
      "Not available yet · we'll email you when it is",
    );

    // A code that doesn't exist is refused, and Start plan stays off with it.
    await page.getByLabel("Promo code").fill("NOPE");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByText("That code isn't valid")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start plan" })).toBeDisabled();
    // The fake's test code: the first month free.
    await page.getByLabel("Promo code").fill("FAKEFIRSTMONTH");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByText("First month free")).toBeVisible();

    // Start plan opens Stripe's page, which pays and comes back; then the event starts the plan.
    await page.getByRole("button", { name: "Start plan" }).click();
    await expect(page).toHaveURL(/\/set-up\/plan\?checkout=done$/);
    await expect(page.getByText("Rooms plan · started")).toBeVisible({ timeout: 30_000 });
    const rail = page.getByRole("navigation", { name: "Setup steps" });
    await expect(rail.getByRole("button", { name: /Your plan/ })).toContainText("Done");
    const sub = await db.query<{ plan: string; room_quantity: number }>(
      "select plan, room_quantity from venue_subscriptions where venue_id = $1",
      [venue.rows[0]!.id],
    );
    expect(sub.rows[0]).toEqual({ plan: "rooms", room_quantity: 0 });

    // Step 3 (O-05): Connect with Stripe opens Stripe's hosted onboarding, which comes back to the
    // step; account.updated with card payments on marks it done, connected through the organization.
    await rail.getByRole("button", { name: /Card payments/ }).click();
    await expect(
      page.getByText("Not connected · Stripe takes your cards and pays your bank"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Connect with Stripe" }).click();
    await expect(page).toHaveURL(/\/set-up\/card\?stripe=back$/);
    await expect(
      page.getByText(`Connected through E2E Plan ${n} LLC · card payments on`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(rail.getByRole("button", { name: /Card payments/ })).toContainText("Done");

    // Step 4 (O-06): Rooms & room clock already on from the plan (D121), a room typed (no capacity
    // suggested), the prices.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Rooms and prices" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn on Rooms & room clock" })).toHaveCount(0);
    await expect(page.getByLabel("Fewest guests", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("Most guests", { exact: true })).toHaveValue("");
    await page.getByLabel("Name", { exact: true }).fill("Room 1");
    await page.getByLabel("Fewest guests", { exact: true }).fill("2");
    await page.getByLabel("Most guests", { exact: true }).fill("8");
    await page.getByRole("button", { name: "Add a room" }).click();
    await expect(page.getByText("Room 1", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Per person an hour ($)")).toHaveCount(0);
    await page.getByLabel("How rooms are priced").selectOption("perPerson");
    await page.getByLabel("Per person an hour ($)").fill("9.50");
    await page.getByLabel("Billed in steps of").selectOption("15");
    await page.getByLabel("Rounding a step").selectOption("up");
    await page.getByLabel("At least this many guests, weeknights").fill("2");
    await page.getByLabel("At least this many guests, Friday and Saturday").fill("3");
    await page.getByLabel("Shortest booking (hours)").fill("1");
    await page.getByLabel("Longest booking (hours)").fill("4");
    await page.getByLabel("Most guests in a booking").fill("12");
    await page.getByLabel("Damage fee ($)").fill("50");
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 5: no kitchen fields on the Rooms plan; a late last call is refused with the reason.
    await expect(page.getByRole("heading", { level: 2, name: "Hours" })).toBeVisible();
    await expect(rail.getByRole("button", { name: /Rooms and prices/ })).toContainText("Done");
    await expect(page.getByLabel("Kitchen opens")).toHaveCount(0);
    await page.getByLabel("Fri · Opens").fill("17:00");
    await page.getByLabel("Fri · Closes").fill("04:00");
    await page.getByLabel("House last call").fill("05:00");
    await page.getByLabel("21 and over", { exact: true }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(/can't be later than the rule pack's last sale/)).toBeVisible();
    await page.getByLabel("House last call").fill("03:30");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Deposits and check-in" }),
    ).toBeVisible();
    await expect(rail.getByRole("button", { name: /^Hours/ })).toContainText("Done");

    // Step 6 (O-07): nothing chosen for the owner; no deposit online and Keep the card behind
    // the bar saves, and Admin → Deposits & cancelling shows the same choice.
    await expect(page.getByLabel("Keep the card behind the bar")).not.toBeChecked();
    await expect(page.getByLabel("Take a deposit")).not.toBeChecked();
    await page.getByLabel("Deposit", { exact: true }).selectOption("off");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Finish the deposit answers, or clear them")).toBeVisible();
    await page.getByLabel("No-show after (minutes late)").fill("15");
    await page.getByLabel("Keep the card behind the bar").check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(rail.getByRole("button", { name: /Deposits and check-in/ })).toContainText("Done");
    await expect(
      page.getByRole("heading", { level: 2, name: "Money at the counter" }),
    ).toBeVisible();

    // Step 7 (O-09): nothing chosen; a half-answered form waits; then the answers save and show
    // in Admin → Card fee & gratuity and Admin → Cash drawers. No Kitchen: no food question.
    await expect(page.getByLabel("Cash discount (%) · empty is no discount")).toHaveValue("");
    await page.getByLabel("Cash discount (%) · empty is no discount").fill("3");
    await expect(
      page.getByRole("radiogroup", { name: "Food prices and the cash discount" }),
    ).toHaveCount(0);
    await page.getByLabel("Added to").selectOption("off");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Finish the payments and drawer answers")).toBeVisible();
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
    await expect(rail.getByRole("button", { name: /Money at the counter/ })).toContainText("Done");

    // Step 8 (O-10): Sing Sing's menu file as a dry run, then "Looks right" saves it.
    await expect(page.getByRole("heading", { level: 2, name: "Menu" })).toBeVisible();
    await expect(rail.getByRole("button", { name: /Menu/ })).not.toContainText("Done");
    const dir = "docs/venues/sing-sing/import";
    await page
      .getByLabel("Spreadsheet files")
      .setInputFiles([`${dir}/mapping.json`, `${dir}/items.csv`, `${dir}/choices.csv`]);
    await page.getByRole("button", { name: "Check the file" }).click();
    await expect(page.getByText(/^179 menu lines/)).toBeVisible();
    await expect(page.getByText("To answer on your items").first()).toBeVisible();
    await page.getByRole("button", { name: "Looks right" }).click();
    await expect(page.getByText("Saved: 179 new menu lines")).toBeVisible();
    await expect(rail.getByRole("button", { name: /Menu/ })).toContainText("Done");

    // Step 9 (O-11): a manager invited by phone; the owner names herself on call and for breaches.
    // Until a manager sets their PIN the step needs attention, and the contacts show in Admin → Venue.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Team and contacts" })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Andy Park");
    await page.getByLabel("Mobile phone").fill("(212) 555-0188");
    await page.getByLabel("Role").selectOption("manager");
    await page.getByRole("button", { name: "Send the invite" }).click();
    await expect(page.getByText("Invite sent to +12125550188")).toBeVisible();
    await expect(page.getByText(/Andy Park · Manager/)).toBeVisible();
    await page.getByLabel("Who").first().selectOption({ label: "Mina Cho · Owner" });
    await page.getByRole("checkbox", { name: "Fri" }).check();
    await page.getByRole("checkbox", { name: "Sat" }).check();
    await page.getByLabel("First on call · From").fill("18:00");
    await page.getByLabel("First on call · Until").fill("04:00");
    await page
      .getByRole("combobox", { name: "Breach contact" })
      .selectOption({ label: "Mina Cho · Owner" });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(rail.getByRole("button", { name: /Team and contacts/ })).toContainText(
      "Needs attention",
    );

    // Step 10 (O-12): the liquor license, through Admin → Licenses' own register.
    await expect(page.getByRole("heading", { level: 2, name: "Licenses" })).toBeVisible();
    const register = page.getByRole("region", { name: "Licenses" });
    await register.getByRole("button", { name: "Add a license" }).click();
    await register.getByLabel("Kind").selectOption("liquor");
    await register.getByLabel("Number").fill("E2E-LIQUOR-1");
    await register.getByLabel("Expires").fill("2026-12-31");
    await register.getByRole("button", { name: "Save" }).click();
    await expect(rail.getByRole("button", { name: /^\d* ?Licenses/ })).toContainText("Done");

    // Step 11 (O-12): no texting number yet; the website answer is recorded.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByText("We're setting up your texting number · we'll email you"),
    ).toBeVisible();
    await page.getByRole("radio", { name: "No" }).check();
    await page.getByRole("button", { name: "Save the answer" }).click();
    await expect(page.getByText(/^Answered no/)).toBeVisible();

    // Step 12 (O-13): nothing paired yet; the song system is None; pairing is Admin's own flow.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Devices and checks" })).toBeVisible();
    const paired = page.getByRole("list", { name: "What's paired" });
    await expect(paired).toContainText("Card readersNone yet");
    await expect(paired).toContainText(
      "None · a song system connects only through a partnership with its maker",
    );
    await page.getByRole("link", { name: "Open Admin → Printers & devices" }).click();
    await expect(page).toHaveURL(/\/admin\/devices$/);
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
    await expect(paired).toContainText("Bar S710");
    await expect(paired).toContainText("Bar printer · Bar drawer");
    const golive = page.getByRole("region", { name: "Go-live checklist" });
    await expect(async () => {
      await golive.getByLabel("The category we expect").fill("5813");
      await golive.getByRole("button", { name: "Save the category" }).click();
      await expect(golive.getByText("Checked: Stripe has 5813")).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await expect(rail.getByRole("button", { name: /Devices and checks/ })).toContainText("Done");
    // Andy hasn't set his PIN, so the venue isn't ready and Finish setup stays off.
    await expect(page.getByRole("button", { name: "Finish setup" })).toBeDisabled();

    await page.goto("/admin/venue");
    await expect(page.getByRole("combobox", { name: "Breach contact" })).toHaveValue(/.+/);

    await page.goto("/admin/deposits");
    await expect(page.getByLabel("Keep the card behind the bar")).toBeChecked();
    await page.goto("/admin/card-fee");
    await expect(page.getByLabel("Percent", { exact: true })).toHaveValue("3");
    await expect(page.getByLabel("How the pool splits")).toHaveValue("hours");
    await page.goto("/admin/cash-drawers");
    await expect(page.getByLabel("Starting bank, $")).toHaveValue("250");
  } finally {
    await db.end();
  }
});

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

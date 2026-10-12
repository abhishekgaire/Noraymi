import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { DB, STRIPE } from "./stack.js";

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

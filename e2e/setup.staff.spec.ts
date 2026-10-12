import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { DB } from "./stack.js";

/**
 * Set up your venue (O-02): a venue our Console made, its owner signed in with
 * a passkey. Signing in opens the wizard at step 1; Skip for now marks a
 * required step "Needed before you open"; Save and finish later leaves for the
 * owner's home. A step saved meanwhile (the venue's address and guest phone)
 * is done when the owner signs in again, and the wizard opens the next step
 * not done; the last step lists what's missing and Finish setup stays off.
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

    // Continue, then Skip for now on Your plan: it stays needed before opening.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Your plan" })).toBeVisible();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Card payments" })).toBeVisible();
    await expect(rail.getByRole("button", { name: /Your plan/ })).toContainText(
      "Needed before you open",
    );

    // Save and finish later leaves for the owner's home.
    await page.getByRole("button", { name: "Save and finish later" }).click();
    await expect(page).toHaveURL(/\/tonight$/);

    // Meanwhile Your venue is saved (its form arrives with O-03): the address and the guest phone.
    await db.query(
      `update venues set address = '{"line1":"31-18 Steinway St","city":"Astoria","state":"NY","postal_code":"11103"}' where id = $1`,
      [venueId],
    );
    await db.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on, saved_by)
         values ($1, 'phone', 1, '{"callNumber":"+17185550100","textNumber":"+17185550100"}', '2026-09-01', $2)`,
      [venueId, user.rows[0]!.id],
    );

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
  } finally {
    await db.end();
  }
});

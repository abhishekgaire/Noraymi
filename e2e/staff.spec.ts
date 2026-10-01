import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import { catalogs } from "@west4/shared";

/**
 * The staff app shell (M1-21). Andy (manager) enrols a passkey with
 * Playwright's virtual authenticator on the staff app's own origin, signs in
 * through the sign-in screen, and the shell shows the venue's 10:41 PM
 * although the browser's clock says otherwise. Then he switches to Español:
 * every visible string must come from the Spanish catalog, and each shell
 * screen at 390 and 1280 pixels wide must show no clipped text (spec 13's
 * language tests).
 */
const ANDY = "andy@demo.west4.local";
const SCREENS = ["/tonight", "/bar", "/runs", "/sign-in"];

async function enrolPasskey(page: Page, request: APIRequestContext, db: pg.Client) {
  // Andy's seed row has a demo authenticator; the first passkey by email needs an account with no credential yet.
  await db.query(
    "delete from auth_credentials where user_id = (select id from users where lower(email) = $1)",
    [ANDY],
  );
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
  expect(
    (await request.post("/v1/auth/enroll", { data: { step: "start", email: ANDY } })).ok(),
  ).toBe(true);
  const job = await db.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [ANDY],
  );
  const code = job.rows[0]!.payload.data.code;
  const options = (await (
    await request.post("/v1/auth/enroll", { data: { step: "passkey_options", email: ANDY, code } })
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
  const enrolled = await request.post("/v1/auth/enroll", {
    data: {
      step: "passkey_finish",
      email: ANDY,
      code,
      credential: registration,
      name: "Smoke test",
      client: "desktop",
    },
  });
  expect(enrolled.status(), await enrolled.text()).toBe(201);
}

/** Every line of text on the page, as a person reads it. */
async function visibleTexts(page: Page): Promise<string[]> {
  const text = await page.locator("body").innerText();
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const matchers = (locale: "en" | "es") =>
  Object.values(catalogs[locale]).map(
    (v) => new RegExp(`^${escape(v).replace(/\\\{\w+\\\}/g, ".+")}$`),
  );

/** Elements whose text is wider than the box that hides it, plus any sideways page scroll. */
async function clippedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const clipped: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1)
      clipped.push("page scrolls sideways");
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const text = el.textContent?.trim() ?? "";
      if (text === "") continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const hides = style.overflowX !== "visible" || style.textOverflow === "ellipsis";
      if (hides && el.scrollWidth > el.clientWidth + 1) {
        clipped.push(`${el.tagName.toLowerCase()}.${el.className}: "${text.slice(0, 40)}"`);
      }
    }
    return clipped;
  });
}

test("Andy signs in, reads the venue's 10:41 PM, switches to Español and every screen fits at 390 and 1280", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    // The device's clock is years off; the shell must still show the seed's 10:41 PM.
    await page.clock.setFixedTime(new Date("2031-03-03T15:00:00Z"));
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    await enrolPasskey(page, request, db);

    // The simulated clock runs on from the seed's 10:41 PM while the servers start; put it back (M1-06's staging control).
    const reset = () =>
      request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } });
    expect((await reset()).ok()).toBe(true);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await expect(page.locator(".clock time")).toHaveText("10:41 PM");
    await expect(page.locator(".clock")).toContainText("Fri, Sep 25");
    await expect(page.locator(".topbar .venue")).toHaveText("West 4 Boho Karaoke");
    await expect(page.locator(".topbar .who")).toHaveText("Andy C. · Manager");

    // Switching the signed-in person to Español re-renders every visible string from es.
    await page.setViewportSize({ width: 1280, height: 800 });
    await reset();
    await page.getByRole("button", { name: "Switch to Español" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Esta noche");
    await expect(page.locator(".clock time")).toHaveText(/^10:41\s?p\.\s?m\.$/);
    const data = new Set(["West 4 Boho Karaoke", "English", "Español", "☰"]);
    const es = matchers("es");
    const enOnly = matchers("en").filter((m) => !es.some((e) => e.source === m.source));
    for (const text of await visibleTexts(page)) {
      // Data, not words: the venue, the names of the languages, and the venue's time ("10:41 p.m.").
      if (data.has(text) || /^\d{1,2}:\d{2}\s?([ap]\.\s?m\.|[AP]M)$/.test(text)) continue;
      expect(
        es.some((m) => m.test(text)),
        `not Spanish: "${text}"`,
      ).toBe(true);
      expect(
        enOnly.some((m) => m.test(text)),
        `English on a Spanish screen: "${text}"`,
      ).toBe(false);
    }
    // The choice is saved on his membership, not just this page.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Esta noche");

    // Each shell screen in its longest language at phone and desktop widths: nothing cut off.
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const path of SCREENS) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        if (width === 390 && path !== "/sign-in") {
          await page.getByRole("button", { name: "Abrir el menú" }).click();
        }
        expect(await clippedText(page), `${path} at ${width}px`).toEqual([]);
      }
    }

    // Lock ends the session on this screen and shows sign-in, in Spanish, with the lock notice.
    // At 1280 the side menu is always open; at 390 it's the drawer behind "Abrir el menú" (checked above).
    await page.goto("/tonight");
    await page.getByRole("button", { name: "Bloquear" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Iniciar sesión");
    await expect(page.getByRole("status")).toHaveText("Bloqueado · inicia sesión para continuar");
    await expect(page.getByRole("button", { name: "Cambiar a English" })).toBeVisible();
  } finally {
    await db.end();
  }
});

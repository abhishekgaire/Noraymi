import { expect, test, type Browser, type Page, type APIRequestContext } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import { SoftwarePasskey } from "../apps/api/src/auth/test-passkey.js";
import { fakeFingerprint } from "../apps/api/src/stripe/fake/payments.js";
import { catalogs, makeDeviceKey, signDeviceRequest, Temporal } from "@west4/shared";
import { offlineCodeAt } from "@west4/rules";
import { sweepRouters } from "../apps/api/src/jobs/router-watch.js";
import { subscribeVenue } from "../apps/api/src/billing/plan.js";
import { StripeClient } from "../apps/api/src/stripe/client.js";
import { PLAN_LOOKUP_KEYS, ROOM_LOOKUP_KEY } from "../apps/api/src/stripe/billing.js";
import { fakeStripeSettings } from "../apps/api/src/stripe/settings.js";
import { loadVendorHealthSettings, sweepVendorHealth } from "../apps/api/src/jobs/vendor-health.js";
import { SEED_COMMAND, setClock as resetClock } from "./night.js";

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
const ABHISHEK = "abhishek@demo.west4.local";
/** The Admin sections shipped so far; each M1 Admin ticket adds its path to the Spanish check. */
const ADMIN_SECTIONS = [
  "/admin/team",
  "/admin/features",
  "/admin/hours",
  "/admin/devices",
  "/admin/rooms",
  "/admin/menu",
  "/admin/safety",
  "/admin/licenses",
  "/admin/connections",
  "/admin/payments",
  "/admin/disputes",
  "/admin/card-fee",
  "/admin/cash-drawers",
  "/admin/website",
  "/admin/deposits",
  "/admin/bar-pos",
  "/admin/bar-mode",
  "/admin/console",
];
const SCREENS = [
  "/tonight",
  "/bar",
  "/song-queue",
  "/runs",
  "/setup",
  "/clock",
  "/my-tips",
  "/reports",
  "/admin",
  "/sign-in",
];

// Put the shared clock back for whatever spec runs next, in this project or another.
test.afterEach(async () => {
  await resetClock();
});

/**
 * Every test starts from a fresh load of the demo seed at 10:41 PM, whatever
 * the test before it did (M2-35): the seed's tables, and the API's simulated
 * clock.
 */
test.beforeEach(async ({ request }) => {
  execSync(SEED_COMMAND, { stdio: ["ignore", "ignore", "pipe"] });
  const clock = await request.post("http://127.0.0.1:3000/v1/ops/clock", {
    data: { server_time: "2026-09-26T02:41:00Z" },
  });
  expect(clock.ok()).toBe(true);
});

/**
 * The sign-in routes allow 30 calls a minute from one address, and a full smoke run signs in many
 * times: a 429 waits out the window instead of failing (the limit itself stays).
 */
async function postAuth(request: APIRequestContext, path: string, options: { data: unknown }) {
  for (let i = 0; ; i++) {
    const r = await request.post(path, options);
    if (r.status() !== 429 || i >= 3) return r;
    await new Promise((done) => setTimeout(done, 20_000));
  }
}

async function enrolPasskey(
  page: Page,
  request: APIRequestContext,
  db: pg.Client,
  email: string = ANDY,
) {
  // Andy's seed row has a demo authenticator; the first passkey by email needs an account with no credential yet.
  await db.query(
    "delete from auth_credentials where user_id = (select id from users where lower(email) = $1)",
    [email],
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
    (await postAuth(request, "/v1/auth/enroll", { data: { step: "start", email } })).ok(),
  ).toBe(true);
  const job = await db.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [email],
  );
  const code = job.rows[0]!.payload.data.code;
  const options = (await (
    await postAuth(request, "/v1/auth/enroll", { data: { step: "passkey_options", email, code } })
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
    data: {
      step: "passkey_finish",
      email,
      code,
      credential: registration,
      name: "Smoke test",
      client: "desktop",
    },
  });
  expect(enrolled.status(), await enrolled.text()).toBe(201);
}

/** A pairing code for a shared screen, written the way Admin → Devices makes one (M1-15). */
async function pairingCode(
  db: pg.Client,
  kind: "bar_computer" | "front_desk" | "up_next_display",
  name: string,
): Promise<string> {
  const code = randomBytes(4).toString("hex").toUpperCase();
  const venue = await db.query<{ id: string }>("select id from venues limit 1");
  await db.query(
    "insert into device_pairing_codes (venue_id, code_hash, kind, name, expires_at) values ($1, $2, $3, $4, now() + interval '1 hour')",
    [
      venue.rows[0]!.id,
      createHash("sha256").update(code.trim().toUpperCase()).digest("hex"),
      kind,
      name,
    ],
  );
  return code;
}

/** Tap a PIN on the keypad. */
async function typePin(page: Page, pin: string): Promise<void> {
  for (const digit of pin)
    await page.locator(".keypad").getByRole("button", { name: digit, exact: true }).click();
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
/** A text that is a Spanish catalog string word for word is Spanish, whatever a loose English pattern says. */
const esExact = new Set<string>(Object.values(catalogs.es));
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
    const rooms = (
      await db.query<{ name: string }>(
        // Room and guest names, and fault notes, are the venue's data, not the app's words.
        "select name from rooms union all select name from guests union all select text from room_faults union all select text from room_notes",
      )
    ).rows.map((r) => r.name);
    const data = new Set(["West 4 Boho Karaoke", "English", "Español", "☰", "−", "+", ...rooms]);
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
        !esExact.has(text) && enOnly.some((m) => m.test(text)),
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

/**
 * Install and subscribe (M1-22). Chromium has no push service in a test run,
 * so the browser's PushManager and Notification are stood in for; everything
 * else is real: the service worker registers and controls the page, the phone
 * makes its device key, registers itself as Andy's staff_phone, signs its
 * subscription, and a test alert is queued for it. The worker never caches an
 * API response.
 */
test("Andy's phone installs the staff app, turns on alerts and gets a test alert queued", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await page.addInitScript(() => {
      const fake = {
        endpoint: "https://push.example.test/send/andy-phone",
        toJSON: () => ({
          endpoint: "https://push.example.test/send/andy-phone",
          keys: { p256dh: "fake-p256dh", auth: "fake-auth" },
        }),
        unsubscribe: async () => true,
      };
      let subscribed = false;
      // Headless Chromium answers "denied" whatever the grant: the phone says yes here.
      Object.defineProperty(Notification, "permission", { get: () => "granted" });
      Notification.requestPermission = async () => "granted";
      PushManager.prototype.subscribe = async () => {
        subscribed = true;
        return fake as unknown as PushSubscription;
      };
      PushManager.prototype.getSubscription = async () =>
        (subscribed ? fake : null) as unknown as PushSubscription;
      Object.defineProperty(Notification, "permission", { get: () => "default" });
      Notification.requestPermission = async () => "granted";
    });
    // The earlier test left Andy in Español; this one reads the screen in English.
    await db.query(
      "update memberships set locale = 'en' where user_id = (select id from users where lower(email) = $1)",
      [ANDY],
    );
    await page.goto("/");
    await enrolPasskey(page, request, db);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    // The app is installable: a manifest, and a service worker that controls the page.
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.webmanifest",
    );
    expect((await request.get("/manifest.webmanifest")).ok()).toBe(true);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    await page.goto("/setup");
    await page.getByRole("button", { name: "Turn on alerts" }).click();
    await expect(page.getByRole("status")).toHaveText("Alerts are on");
    const phone = await db.query<{ id: string; kind: string }>(
      "select d.id, d.kind from devices d join users u on u.id = d.user_id where lower(u.email) = $1 and d.revoked_at is null and d.public_key is not null",
      [ANDY],
    );
    expect(phone.rows.map((r) => r.kind)).toEqual(["staff_phone"]);
    const subscription = await db.query<{ endpoint: string }>(
      "select endpoint from push_subscriptions where device_id = $1 and revoked_at is null",
      [phone.rows[0]!.id],
    );
    expect(subscription.rows).toEqual([{ endpoint: "https://push.example.test/send/andy-phone" }]);

    await page.getByRole("button", { name: "Send a test alert" }).click();
    await expect(
      page.getByText("Test alert sent · it reaches this phone in a moment"),
    ).toBeVisible();
    const job = await db.query<{ payload: { audience: { kind: string } } }>(
      "select payload from jobs where kind = 'push.send' order by created_at desc limit 1",
    );
    expect(job.rows[0]!.payload.audience.kind).toBe("person");

    // The shell cache holds pages and assets, never an API response.
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const urls: string[] = [];
      for (const key of keys)
        for (const r of await (await caches.open(key)).keys()) urls.push(r.url);
      return urls;
    });
    expect(cached.length).toBeGreaterThan(0);
    expect(cached.filter((u) => u.includes("/v1/"))).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * The invite link on a phone (M1-23, N25). Diego's invite is written straight
 * into the database the way Admin → Team would (the owner's passkey step-up is
 * covered by the API tests); the texted code is read from the job the API
 * queued, as a fake text sender would deliver it. On a 390 px viewport: the
 * number is confirmed, 1234 is refused, a PIN of his own is accepted, and the
 * phone becomes his staff_phone.
 */
test("Diego's invite on his phone: a texted code, 1234 refused, his own PIN set", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    const venue = await db.query<{ id: string }>("select id from venues limit 1");
    const venueId = venue.rows[0]!.id;
    // The seed wipes the venue's rows, not a person this test made last time, nor his sessions.
    await db.query(
      "delete from auth_sessions where user_id in (select id from users where email = 'diego-test@demo.west4.local')",
    );
    await db.query("delete from users where email = 'diego-test@demo.west4.local'");
    const user = await db.query<{ id: string }>(
      "insert into users (name, email) values ('Diego Test', 'diego-test@demo.west4.local') returning id",
    );
    const membership = await db.query<{ id: string }>(
      `insert into memberships (venue_id, user_id, role, status, pin_digits, locale)
       values ($1, $2, 'front_desk', 'invited', 4, 'en') returning id`,
      [venueId, user.rows[0]!.id],
    );
    const token = randomBytes(32).toString("base64url");
    await db.query(
      `insert into invites (venue_id, membership_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '2 days')`,
      [venueId, membership.rows[0]!.id, createHash("sha256").update(token).digest("hex")],
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/invite/${token}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Join West 4 Boho Karaoke");
    await expect(page.getByText("Hi Diego Test · you're joining as Front desk")).toBeVisible();
    await page.getByLabel("Your mobile number").fill("+12125550199");
    await page.getByRole("button", { name: "Text me a code" }).click();
    await expect(page.getByText("We texted a code to +12125550199")).toBeVisible();
    const text = await db.query<{ payload: { data: { code: string } } }>(
      "select payload from jobs where kind = 'text.send' and payload->>'to' = $1 order by created_at desc limit 1",
      ["+12125550199"],
    );
    await page.getByLabel("The code from the text").fill("000000");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("alert")).toHaveText("That code didn't work");
    await page.getByLabel("The code from the text").fill(text.rows[0]!.payload.data.code);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Choose your PIN");

    await page.getByLabel("Choose your PIN", { exact: true }).fill("1234");
    await page.getByLabel("Type it again").fill("1234");
    await page.getByRole("button", { name: "Set my PIN" }).click();
    await expect(page.getByRole("alert")).toHaveText("Not a run like 1234");
    // He picks Español here, on his own phone: it's saved on his membership.
    await page.getByRole("button", { name: "Switch to Español" }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Elige tu PIN");
    await page.getByLabel("Elige tu PIN", { exact: true }).fill("6358");
    await page.getByLabel("Escríbelo otra vez").fill("6358");
    await page.getByRole("button", { name: "Guardar mi PIN" }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Listo · inicia sesión con tu tarjeta o con tu nombre y PIN",
    );
    expect(await clippedText(page)).toEqual([]);

    const after = await db.query<{ status: string; pin_verifier: string; devices: string }>(
      `select m.status, m.pin_verifier, (select count(*) from devices d where d.user_id = m.user_id and d.kind = 'staff_phone')::text as devices
       from memberships m where m.id = $1`,
      [membership.rows[0]!.id],
    );
    expect(after.rows[0]!.status).toBe("active");
    expect(after.rows[0]!.pin_verifier).toMatch(/^\$argon2id\$/);
    expect(after.rows[0]!.devices).toBe("1");
    await page.goto(`/invite/${token}`);
    await expect(page.getByRole("status")).toHaveText("Este enlace ya se usó");

    // His phone now signs him in with his PIN alone, and every screen he reaches is in Spanish.
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Iniciar sesión");
    await typePin(page, "6358");
    // He isn't on the clock, so the time clock comes first (M7-01); "Ahora no" goes on.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Control horario");
    await page.getByRole("button", { name: "Ahora no" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Esta noche");
    await expect(page.locator(".tabs")).toContainText("Esta noche");
    await expect(page.locator(".tabs")).toContainText("Alertas");
    for (const path of ["/setup", "/admin"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await clippedText(page), `${path} on his phone`).toEqual([]);
    }
    await expect(page.getByRole("status")).toHaveText(
      "Admin necesita tu llave de acceso. Ábrelo en la app de escritorio o en un navegador.",
    );
    expect(await page.locator("body").innerText()).not.toMatch(/\d{4}/);

    // His next sign-in on the front-desk computer: tapping his tile puts the pad in his language.
    const desk = await page
      .context()
      .browser()!
      .newContext({ viewport: { width: 1280, height: 800 } });
    const deskPage = await desk.newPage();
    try {
      await deskPage.goto("/sign-in");
      await deskPage.getByRole("button", { name: "Pair this screen" }).click();
      await deskPage
        .getByLabel("Pairing code from Admin → Devices")
        .fill(await pairingCode(db, "front_desk", "Front desk"));
      await deskPage.getByRole("button", { name: "Pair", exact: true }).click();
      await expect(deskPage.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");
      await deskPage.getByRole("button", { name: /Diego Test/ }).click();
      await expect(deskPage.getByText("Diego Test · escribe tu PIN")).toBeVisible();
      await typePin(deskPage, "6358");
      await expect(deskPage.getByRole("heading", { level: 1 })).toHaveText("Control horario");
      await deskPage.getByRole("button", { name: "Ahora no" }).click();
      await expect(deskPage.getByRole("heading", { level: 1 })).toHaveText("Esta noche");
      await expect(deskPage.locator(".topbar .who")).toHaveText("Diego Test · Recepción");
    } finally {
      await desk.close();
    }
  } finally {
    await db.end();
  }
});

/**
 * The bar computer (M1-26): paired by a code, it shows name tiles. Maya's name
 * and PIN open her home, the bar POS; Andy's and Diego's open Tonight. The
 * sign-in screen reads the venue's 10:41 PM whatever the browser's clock says,
 * and says "badge or name and PIN".
 */
test("Maya's name and PIN on the bar computer open her home; Andy's and Diego's open Tonight", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    // The browser's clock stays real here: a paired screen signs its requests with it (±5 minutes at the API).
    // The time on screen is the venue's simulated 10:41 PM, which the real clock never is for long.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page
      .getByLabel("Pairing code from Admin → Devices")
      .fill(await pairingCode(db, "bar_computer", "Bar computer"));
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");
    await expect(page.locator(".clock-line time")).toHaveText("10:41 PM");
    await expect(page.getByText("No badge? Tap your name, then your PIN")).toBeVisible();
    await expect(
      page.getByText(
        "Refunds, cash counts and no-sale ask for the PIN again; Admin needs a passkey",
      ),
    ).toBeVisible();
    expect(await clippedText(page)).toEqual([]);

    const signIn = async (name: RegExp, pin: string, home: string) => {
      await page.getByRole("button", { name }).click();
      await typePin(page, pin);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(home);
      await page.getByRole("button", { name: "Lock" }).click();
      await expect(page.getByRole("status")).toHaveText("Locked · sign in to continue");
    };
    // A wrong PIN says so and nothing more.
    await page.getByRole("button", { name: /Maya S\./ }).click();
    await typePin(page, "0000");
    await expect(page.getByRole("alert")).toHaveText("We couldn't sign you in");
    await page.getByRole("button", { name: "Back" }).click();
    await signIn(/Maya S\./, "4071", "Bar POS");
    await signIn(/Andy C\./, "730915", "Tonight");
    await signIn(/Diego R\./, "6358", "Tonight");

    // Every word about PINs says "badge or name and PIN"; nothing says "Lock the iPad".
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/Lock the iPad/);
    expect(text.replace(/badge or name and PIN/g, "")).not.toMatch(/name and PIN/);
  } finally {
    await db.end();
  }
});

/**
 * Admin → Team (M1-31). Abhishek, the owner, opens Admin in a passkey session
 * and lands on Team. He sets Diego's language to Español and changes his role
 * (both behind the passkey, which the virtual authenticator answers); the
 * audit log names him. In Español, Team is all Spanish. Andy, the manager,
 * has no Team, Payments or Console. On the bar computer, Diego's next PIN
 * sign-in opens in Spanish.
 */
test("Abhishek's Admin → Team: Diego to Español behind the passkey, Andy has no Team, and Diego's next sign-in is Spanish", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(180_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  const reset = () =>
    request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } });
  const diegoRole = async () =>
    (
      await db.query<{ role: string; locale: string }>(
        "select role, locale from memberships where user_id = (select id from users where name = 'Diego R.')",
      )
    ).rows[0]!;
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    expect((await reset()).ok()).toBe(true);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    // Admin opens on Team for the owner, with the section list and its hint.
    await page.getByRole("link", { name: "Admin", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/team$/);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Team");
    await expect(
      page.getByRole("link", { name: /Team\s+People, roles, invites, badges and languages/ }),
    ).toBeVisible();
    const diegoRow = page.getByRole("row", { name: /Diego R\./ });
    await expect(diegoRow).toContainText("Active");
    // Who's waiting and for what (M9-08): Diego has his PIN and badge; alerts depend on his phone.
    const diegoPush = (
      await db.query<{ on: boolean }>(
        `select exists (select 1 from push_subscriptions s join devices d on d.id = s.device_id
            where s.revoked_at is null and d.revoked_at is null and d.kind = 'staff_phone'
              and d.user_id = (select id from users where name = 'Diego R.')) as on`,
      )
    ).rows[0]!.on;
    await expect(diegoRow.getByTestId("waiting")).toHaveText(diegoPush ? "Ready" : "Alerts off");
    await expect(page.getByTestId("team-waiting")).toHaveText(/^(Waiting: [1-4]|Nobody waiting)$/);
    expect(await clippedText(page)).toEqual([]);

    // Language: Diego to Español (the passkey is asked again; the virtual authenticator answers).
    await diegoRow.getByLabel("Language", { exact: true }).selectOption("es");
    await expect.poll(async () => (await diegoRole()).locale).toBe("es");
    await expect(diegoRow.getByText("Saved")).toBeVisible();

    // Role: Diego to Staff (runner) and back, both 4-digit roles; the audit log names Abhishek.
    await diegoRow.getByLabel("Role", { exact: true }).selectOption("staff");
    await expect.poll(async () => (await diegoRole()).role).toBe("staff");
    const audit = await db.query<{ actor_name: string; changed_fields: string[] }>(
      `select u.name as actor_name, a.changed_fields from audit_log a join users u on u.id = a.actor
        where a.action = 'memberships.update' and 'role' = any(a.changed_fields)
        order by a.id desc limit 1`,
    );
    expect(audit.rows[0]).toMatchObject({ actor_name: "Abhishek G." });
    await diegoRow.getByLabel("Role", { exact: true }).selectOption("front_desk");
    await expect.poll(async () => (await diegoRole()).role).toBe("front_desk");

    // With Abhishek in Español, every M1 Admin section is Spanish through and through.
    await page.getByRole("button", { name: "Switch to Español" }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Equipo");
    const es = matchers("es");
    const enOnly = matchers("en").filter((m) => !es.some((e) => e.source === m.source));
    // Data, not words: people's names and the devices' names (the seed's own, in English).
    const names = new Set(
      (
        await db.query<{ name: string }>(
          "select name from users union all select name from devices union all select name from rooms union all select name from guests union all select reason from room_states where reason is not null",
        )
      ).rows.map((r) => r.name),
    );
    const data = new Set(["West 4 Boho Karaoke", "English", "Español", "☰", "−", "+", ...names]);
    for (const path of ADMIN_SECTIONS) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Cargando" })).toHaveCount(0);
      // Guest-facing wording is the venue's own (English at West 4), not a staff-screen string.
      for (const text of await page.locator("[data-guest-text]").allInnerTexts())
        data.add(text.trim());
      // innerText joins a table row's cells with tabs: check each cell on its own.
      const cells = (await visibleTexts(page)).flatMap((line) =>
        line.split("\t").map((c) => c.trim()),
      );
      for (const text of cells) {
        if (
          text === "" ||
          data.has(text) ||
          text.includes("@") ||
          /\d{1,2}:\d{2}\s?([ap]\.\s?m\.|[AP]M)/.test(text)
        )
          continue;
        expect(
          es.some((m) => m.test(text)),
          `${path} not Spanish: "${text}"`,
        ).toBe(true);
        expect(
          !esExact.has(text) && enOnly.some((m) => m.test(text)),
          `${path} English on a Spanish screen: "${text}"`,
        ).toBe(false);
      }
      expect(await clippedText(page), path).toEqual([]);
    }
    await page.getByRole("button", { name: "Cambiar a English" }).click();

    // Andy's Admin: no Team, Payments or Console, and /admin/team says it's the owner's.
    const andyPage = await context.newPage();
    await andyPage.setViewportSize({ width: 1280, height: 800 });
    await andyPage.goto("/sign-in");
    await enrolPasskey(andyPage, request, db, ANDY);
    await andyPage.getByLabel("Email").fill(ANDY);
    await andyPage.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(andyPage.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await andyPage.getByRole("link", { name: "Admin", exact: true }).click();
    await expect(andyPage.getByRole("heading", { level: 1 })).toHaveText("Admin");
    const sections = andyPage.getByRole("navigation", { name: "Sections" });
    for (const name of ["Team", "Payments", "Console"]) {
      await expect(sections.getByRole("link", { name: new RegExp(`^${name}`) })).toHaveCount(0);
    }
    await andyPage.goto("/admin/team");
    await expect(andyPage.getByText("This section is the owner's")).toBeVisible();
    await andyPage.close();

    // Diego's next sign-in, on the bar computer, is Spanish.
    await page.getByRole("button", { name: "Lock" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page
      .getByLabel("Pairing code from Admin → Devices")
      .fill(await pairingCode(db, "bar_computer", "Bar computer"));
    expect((await reset()).ok()).toBe(true);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");
    await page.getByRole("button", { name: /Diego R\./ }).click();
    await typePin(page, "6358");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Esta noche");
  } finally {
    await db.query("update memberships set locale = 'en'");
    await db.end();
  }
});

/**
 * Admin → Features (M1-32). At West 4, 13 modules are on and Song system
 * control and Marketing texts are off; the four phase 2 modules don't show.
 * Bar screen & tickets carries the escalation sentence, and nothing says
 * "Orders ring the bar until accepted". Turning it off asks "Room orders would
 * have nowhere to ring…": Keep it on changes nothing; Turn off turns both off,
 * and they come back on in order.
 */
test("Admin → Features: 13 on and 2 off, no phase 2 modules, and the Bar screen & tickets confirm", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  const stateOf = async (id: string) =>
    (
      await db.query<{ state: string }>("select state from venue_modules where module_id = $1", [
        id,
      ])
    ).rows[0]!.state;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    await page.goto("/admin/features");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Features");
    await expect(page.getByText("13 on · 2 off")).toBeVisible();
    const stateGroup = (name: string) => page.getByRole("group", { name: `${name} · State` });
    for (const off of ["Song system control", "Marketing texts"]) {
      await expect(stateGroup(off).getByRole("button", { name: "Off" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
    await expect(
      stateGroup("Rooms & room clock").getByRole("button", { name: "On" }),
    ).toHaveAttribute("aria-pressed", "true");
    for (const phase2 of [
      "Kitchen & food",
      "Event sales",
      "Guests, loyalty & gift cards",
      "Multiple locations",
    ]) {
      await expect(page.getByText(phase2)).toHaveCount(0);
    }
    await expect(page.getByText("Always on")).toHaveCount(4);
    await expect(
      page.getByText(
        "Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup.",
      ),
    ).toBeVisible();
    expect((await visibleTexts(page)).some((t) => /ring the bar until/i.test(t))).toBe(false);
    expect(await clippedText(page)).toEqual([]);

    // The confirm: Keep it on changes nothing.
    const question = "Room orders would have nowhere to ring. Turn off Ordering from the room too?";
    await stateGroup("Bar screen & tickets").getByRole("button", { name: "Off" }).click();
    await expect(page.getByText(question)).toBeVisible();
    await page.getByRole("button", { name: "Keep it on" }).click();
    await expect(page.getByText(question)).toHaveCount(0);
    expect(await stateOf("bar_screen")).toBe("on");
    expect(await stateOf("room_ordering")).toBe("on");

    // Turn off turns both off; the side menu loses Bar orders at once; then back on, in order.
    await stateGroup("Bar screen & tickets").getByRole("button", { name: "Off" }).click();
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect.poll(() => stateOf("room_ordering")).toBe("off");
    expect(await stateOf("bar_screen")).toBe("off");
    await expect(page.getByText("11 on · 4 off")).toBeVisible();
    await stateGroup("Bar screen & tickets").getByRole("button", { name: "On" }).click();
    await expect.poll(() => stateOf("bar_screen")).toBe("on");
    await stateGroup("Ordering from the room").getByRole("button", { name: "On" }).click();
    await expect.poll(() => stateOf("room_ordering")).toBe("on");
    await expect(page.getByText("13 on · 2 off")).toBeVisible();
  } finally {
    await db.query(
      "update venue_modules set state = 'on' where module_id in ('bar_screen', 'room_ordering')",
    );
    await db.end();
  }
});

/**
 * Admin → Hours & prices, the M1 part (M1-33). West 4's hours read Mon to Fri
 * 4:00 PM to 4:00 AM and Sat and Sun 2:00 PM to 4:00 AM. A house last call of
 * 4:30 AM is refused on Save and publish with the rule pack's reason, and
 * 3:00 AM saves. Adding a special date writes a closures row and that date's
 * hours change.
 */
test("Admin → Hours & prices: West 4's week, a refused 4:30 AM last call, 3:00 AM saved, and a special date", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  const lastCall = async () =>
    (
      await db.query<{ last_call: string | null }>(
        "select value->>'lastCall' as last_call from venue_settings where key = 'hours' order by version desc limit 1",
      )
    ).rows[0]!.last_call;
  const baseVersion = (
    await db.query<{ v: number }>(
      "select coalesce(max(version), 0)::int as v from venue_settings where key = 'hours'",
    )
  ).rows[0]!.v;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    await page.goto("/admin/hours");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Hours & prices");
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
      await expect(page.getByLabel(`${day} · Opens`)).toHaveValue("16:00");
      await expect(page.getByLabel(`${day} · Closes`)).toHaveValue("04:00");
    }
    for (const day of ["Sat", "Sun"]) {
      await expect(page.getByLabel(`${day} · Opens`)).toHaveValue("14:00");
      await expect(page.getByLabel(`${day} · Closes`)).toHaveValue("04:00");
    }
    await expect(page.getByText("4:00 PM to 4:00 AM")).toHaveCount(5);
    await expect(page.getByText("2:00 PM to 4:00 AM")).toHaveCount(2);
    await expect(page.getByLabel("House last call", { exact: true })).toHaveValue("04:00");
    await expect(page.getByText("Google Business Profile · not connected")).toBeVisible();
    expect(await clippedText(page)).toEqual([]);

    // 4:30 AM is refused with the reason; nothing is saved.
    await page.getByLabel("House last call", { exact: true }).fill("04:30");
    await expect(page.getByText("1 unsaved change")).toBeVisible();
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(
      page.getByText(
        /Couldn't publish · nothing changed · .*can't be later than the rule pack's last sale/,
      ),
    ).toBeVisible();
    expect(await lastCall()).toBe("04:00");

    // 3:00 AM saves and publishes.
    await page.getByLabel("House last call", { exact: true }).fill("03:00");
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(page.getByText("Published")).toBeVisible();
    expect(await lastCall()).toBe("03:00");
    await page.reload();
    await expect(page.getByLabel("House last call", { exact: true })).toHaveValue("03:00");

    // A special date: Christmas Eve closes at 11:00 PM.
    await page.getByLabel("Date").fill("2026-12-24");
    await page.getByLabel("Kind").selectOption("special");
    await page.getByLabel("Closes", { exact: true }).fill("23:00");
    await page.getByLabel("Note").fill("Christmas Eve");
    await page.getByRole("button", { name: "Add the date" }).click();
    await expect(
      page.getByText("2026-12-24 saved · that day now reads 4:00 PM to 11:00 PM"),
    ).toBeVisible();
    const row = page.getByRole("row", { name: /2026-12-24/ });
    await expect(row).toContainText("Special hours");
    await expect(row).toContainText("Christmas Eve");
    const closure = await db.query<{ kind: string; closes: string }>(
      "select kind, closes::text from closures where date = '2026-12-24'",
    );
    expect(closure.rows[0]).toEqual({ kind: "special", closes: "23:00:00" });
    const hours = (await (
      await request.get(`/v1/venues/${await venueId(db)}/hours?business_date=2026-12-24`, {
        headers: { cookie: await sessionCookie(page) },
      })
    ).json()) as { closes: string; source: string };
    expect(hours.closes).toMatch(/^2026-12-24T23:00:00/);
  } finally {
    await db.query("delete from closures where date = '2026-12-24'");
    await db.query("delete from venue_settings where key = 'hours' and version > $1", [
      baseVersion,
    ]);
    await db.end();
  }
});

async function venueId(db: pg.Client): Promise<string> {
  return (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
}

async function sessionCookie(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Admin → Printers & devices, the M1 part (M1-34). West 4's list shows the
 * two computers, two badge readers, two receipt printers, both S710s, 14 room
 * tablets with Room 4's offline, the Up next TV and the router. A code made
 * here pairs a second browser as a device, and Revoke signs it out: the
 * revoked screen is back at "Pair this screen" by its next heartbeat.
 */
test("Admin → Printers & devices: West 4's devices, a code pairs a new browser, and Revoke signs it out", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  const other = await browser.newContext();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    await page.goto("/admin/devices");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Printers & devices");
    await expect(page.getByText("13 of 14 room tablets online")).toBeVisible();
    for (const name of [
      "Bar computer",
      "Front-desk computer",
      "Bar badge reader (USB)",
      "Front-desk badge reader (USB)",
      "Bar receipt printer",
      "Front-desk receipt printer",
      "Bar S710",
      "Front desk S710",
      "Up next TV",
      "Dual-WAN router",
    ]) {
      // Earlier tests pair extra "Bar computer" screens, so the seed's row is the first of its name.
      await expect(
        page.getByRole("row", { name: new RegExp(`^${escape(name)} `) }).first(),
      ).toContainText("Online");
    }
    await expect(page.getByRole("row", { name: /^Tablet · / })).toHaveCount(14);
    await expect(page.getByRole("row", { name: /^Tablet · Room 4 / })).toContainText("Offline");
    await expect(page.getByRole("row", { name: /^Tablet · Room 9 / })).toContainText("Online");
    expect(await clippedText(page)).toEqual([]);

    // Pair a device: a one-time code, shown once.
    await page.getByLabel("Kind").selectOption("front_desk");
    await page.getByLabel("Name", { exact: true }).fill("Smoke screen");
    await page.getByRole("button", { name: "Make a code" }).click();
    const shown = await page.getByText(/^Code [A-Z0-9]+ · enter it on the device/).textContent();
    const code = /^Code ([A-Z0-9]+) /.exec(shown ?? "")![1]!;

    // A new browser enters it at Sign in → Pair this screen and becomes "Smoke screen".
    const screen = await other.newPage();
    await screen.setViewportSize({ width: 1280, height: 800 });
    await screen.goto("/sign-in");
    await screen.getByRole("button", { name: "Pair this screen" }).click();
    await screen.getByLabel("Pairing code from Admin → Devices").fill(code);
    await screen.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(screen.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");
    await page.reload();
    const smoke = page.getByRole("row", { name: /^Smoke screen / });
    await expect(smoke).toBeVisible();
    await expect(smoke).toContainText("Front-desk computer");
    await expect(smoke).toContainText("Online");

    // Rename it, then revoke it: the paired browser is back at "Pair this screen" by its next heartbeat.
    await smoke.getByRole("button", { name: "Rename" }).click();
    await smoke.getByLabel("Name").fill("Smoke screen 2");
    await smoke.getByRole("button", { name: "Rename" }).click();
    const renamed = page.getByRole("row", { name: /^Smoke screen 2 / });
    await expect(renamed).toBeVisible();
    await renamed.getByRole("button", { name: "Revoke" }).click();
    await expect(
      page.getByText("Revoke Smoke screen 2? It signs out at once and has to be paired again."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Smoke screen 2 revoked")).toBeVisible();
    await expect(page.getByRole("row", { name: /^Smoke screen/ })).toHaveCount(0);
    const row = await db.query<{ revoked_at: string | null }>(
      "select revoked_at::text from devices where name = 'Smoke screen 2'",
    );
    expect(row.rows[0]?.revoked_at).toBeTruthy();
    await expect(screen.getByRole("button", { name: "Pair this screen" })).toBeVisible({
      timeout: 45_000,
    });
  } finally {
    // The revoked row stays: revoked devices are history, like everything else.
    await other.close();
    await db.end();
  }
});

/**
 * Rule-pack versions (M1-36). Two of our staff approve 2026.11 in the Console
 * (through its API here, each with a software security key) and publish it
 * effective Sat Sep 26. Andy opens Admin on business date Fri Sep 25 and reads
 * what changes and when, before it applies.
 */
test("Andy sees the next rule-pack version's changes and start date in Admin before it applies", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  const clean = async () => {
    await db.query("delete from rule_packs where version = '2026.11'");
    await db.query("delete from rule_pack_drafts where version = '2026.11'");
    await db.query("delete from console_sessions");
    await db.query("delete from console_challenges");
    await db.query("delete from console_credentials");
    await db.query("delete from console_staff where email = 'second@demo.west4.local'");
  };
  try {
    await clean();
    await db.query(
      "insert into console_staff (name, email) values ('Second approver', 'second@demo.west4.local')",
    );
    // Our two staff sign in to the Console's API, each with a security key, and publish 2026.11.
    const consoleSignIn = async (email: string) => {
      const ctx = request;
      const sso = await ctx.post("/v1/console/auth/local", { data: { email } });
      expect(sso.ok(), await sso.text()).toBe(true);
      const key = new SoftwarePasskey("localhost", "usb");
      const start = (await (
        await ctx.post("/v1/console/auth/key", { data: { step: "start" } })
      ).json()) as {
        mode: "register" | "login";
        options: { challenge: string };
      };
      const credential =
        start.mode === "register"
          ? key.register(start.options, "http://localhost:5174")
          : key.assert(start.options, "http://localhost:5174");
      const finish = await ctx.post("/v1/console/auth/key", {
        data: { step: "finish", credential },
      });
      expect(finish.status(), await finish.text()).toBe(201);
    };
    const current = (
      await db.query<{ data: Record<string, unknown> & { alcohol: Record<string, unknown> } }>(
        "select data from rule_packs where id = 'us-ny-new-york-county' and version = '2026.09'",
      )
    ).rows[0]!.data;
    await consoleSignIn("support@demo.west4.local");
    const made = await request.post("/v1/console/rule-packs/drafts", {
      data: {
        effective_on: "2026-09-26",
        data: {
          ...current,
          version: "2026.11",
          alcohol: { ...current.alcohol, lastSale: "03:00" },
        },
      },
    });
    expect(made.status(), await made.text()).toBe(201);
    const draftId = ((await made.json()) as { draft: { id: string } }).draft.id;
    expect((await request.post(`/v1/console/rule-packs/drafts/${draftId}/approve`)).ok()).toBe(
      true,
    );
    expect((await request.post(`/v1/console/rule-packs/drafts/${draftId}/publish`)).status()).toBe(
      400,
    );
    await request.post("/v1/console/auth/logout");
    await consoleSignIn("second@demo.west4.local");
    expect((await request.post(`/v1/console/rule-packs/drafts/${draftId}/approve`)).ok()).toBe(
      true,
    );
    const published = await request.post(`/v1/console/rule-packs/drafts/${draftId}/publish`);
    expect(published.status(), await published.text()).toBe(200);
    await request.post("/v1/console/auth/logout");

    // Andy, on business date Fri Sep 25, reads the notice in Admin.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await page.goto("/admin");
    await expect(
      page.getByText("Rules update 2026.11 starts Sat, Sep 26 (business date)"),
    ).toBeVisible();
    await expect(page.getByText("alcohol.lastSale: 04:00 → 03:00")).toBeVisible();
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await clean();
    await db.end();
  }
});

/**
 * Admin → Rooms (M2-04). West 4's 14 rooms in four tiers with Room 4 out of
 * service; switching Room 8 off and on; archiving a new room takes it off the
 * list and keeps its row; the cleaning flag saves through Save and publish.
 */
test("Admin → Rooms: West 4's 14 rooms, switch a room off and on, archive one, and save the cleaning flag", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  const baseVersion = (
    await db.query<{ v: number }>(
      "select coalesce(max(version), 0)::int as v from venue_settings where key = 'rooms'",
    )
  ).rows[0]!.v;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    await page.goto("/admin/rooms");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Rooms");
    const rows = page.locator(".rooms tbody tr");
    await expect(rows).toHaveCount(14);
    const row = (name: string) => page.getByRole("row", { name: new RegExp(`^${name} `) });
    await expect(row("Room 1")).toContainText("Small");
    await expect(row("Room 1")).toContainText("3–6");
    await expect(row("Room 7")).toContainText("Medium");
    await expect(row("Room 7")).toContainText("6–12");
    await expect(row("Room 12")).toContainText("12–20");
    await expect(row("VIP room")).toContainText("20–40");
    await expect(row("Room 4")).toContainText("Mic dead since Tue. Replacement ordered.");
    expect(await clippedText(page)).toEqual([]);

    // Switch Room 8 off, then on.
    await row("Room 8").getByRole("button", { name: "Switch off" }).click();
    await expect(row("Room 8")).toContainText("Switched off");
    await row("Room 8").getByRole("button", { name: "Switch on" }).click();
    await expect(row("Room 8")).toContainText("On");

    // A new room, archived: off the list, its row kept.
    await page.getByLabel("Name", { exact: true }).fill("Room 14");
    await page.getByRole("button", { name: "Add a room" }).last().click();
    await expect(rows).toHaveCount(15);
    await row("Room 14").getByRole("button", { name: "Archive" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Room 14 archived")).toBeVisible();
    await expect(rows).toHaveCount(14);
    const kept = await db.query<{ archived_at: string | null }>(
      "select archived_at::text from rooms where name = 'Room 14'",
    );
    expect(kept.rows[0]?.archived_at).toBeTruthy();

    // The cleaning flag goes through Save and publish.
    await page.getByLabel("Flag a room still cleaning after (minutes)").fill("10");
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(page.getByText("Published")).toBeVisible();
    const flag = await db.query<{ v: number }>(
      "select (value->>'cleaningFlagMin')::int as v from venue_settings where key = 'rooms' order by version desc limit 1",
    );
    expect(flag.rows[0]?.v).toBe(10);
  } finally {
    await db.query(
      "update room_states set state = 'available', reason = null where room_id = (select id from rooms where name = 'Room 8')",
    );
    await db.query("delete from venue_settings where key = 'rooms' and version > $1", [
      baseVersion,
    ]);
    await db.end();
  }
});

/**
 * The live room clock (M2-07). The device's clock is years off; Tonight still
 * reads Room 9 at 161 minutes and $322.00 from the server, and when two real
 * minutes pass on the device the tile ticks to 163 on the offset it measured,
 * never the device's own time. Room 10 offers to stay on by the minute.
 */
test("Tonight's room clocks tick on the server's offset while the device clock is wrong", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.clock.install({ time: new Date("2031-03-03T15:00:00Z") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    const room9 = page.getByRole("listitem", { name: "Room 9", exact: true });
    await expect(room9).toContainText("161 min");
    await expect(room9).toContainText("Room time so far $322.00");
    await expect(room9).toContainText("In room · 19 min left");
    const room10 = page.getByRole("listitem", { name: "Room 10", exact: true });
    await expect(room10).toContainText("Staying · 41 min past");
    await expect(room10).toContainText("Stay on by the minute until we close at 4 AM");
    await expect(page.getByRole("listitem", { name: "Room 7", exact: true })).toContainText(
      "Wrap-up",
    );
    expect(await clippedText(page)).toEqual([]);
    await page.clock.fastForward("02:00");
    await expect(room9).toContainText("163 min", { timeout: 20_000 });
    await expect(room9).toContainText("In room · 17 min left");
  } finally {
    await db.end();
  }
});

/**
 * Admin → Phone & texts and Admin → Texts (M2-10). West 4's number for calls
 * and texts; the 14 texts in order with West 4's wording; Reminder off and on;
 * the marketing texts locked off; and the reminder time empty until set.
 */
test("Admin → Phone & texts and Texts: West 4's number, the 14 texts, Reminder off, marketing locked", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    await page.goto("/admin/phone");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Phone & texts");
    await expect(page.getByLabel("Call number", { exact: true })).toHaveValue("+12122550011");
    await expect(page.getByLabel("Text number", { exact: true })).toHaveValue("+12122550011");
    await expect(page.getByText("Shows as +1 212 255 0011")).toHaveCount(2);
    // M8-22: the 10DLC campaign's status; the seed has no subaccount, so nothing is registered yet.
    const campaign = page.getByTestId("text-campaign");
    await expect(campaign).toContainText("Texting campaign");
    await expect(campaign).toContainText("Not registered");
    await expect(campaign).toContainText("Texts don't go out until the campaign is approved");
    expect(await clippedText(page)).toEqual([]);

    await page.goto("/admin/texts");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Texts");
    const items = page.locator(".text-list > li");
    await expect(items).toHaveCount(14);
    await expect(items.locator("h3")).toHaveText([
      "1. Booking confirmed",
      "2. Reminder",
      "3. Room code",
      "4. Room ready",
      "5. Offer expiring",
      "6. Please wrap up",
      "7. Booked time ending",
      "8. Receipt",
      "9. Deposit refund",
      "10. Payment link",
      "11. Running late reply",
      "12. You're up next",
      "13. Review ask",
      "14. Birthday",
    ]);
    await expect(
      page.getByText(
        "Booked. Room for 6 at 9:30 PM, Sat Sep 26. A 20% gratuity is added to room tabs. Deposit $60 paid, comes off your bill. Free to cancel until Fri 9:30 PM: west4karaoke.com/b/…",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "…Nobody's booked after you, so you can stay on by the minute until we close at 4 AM.".slice(
          1,
        ),
      ),
    ).toBeVisible();
    for (const name of ["Review ask", "Birthday"]) {
      await expect(page.getByRole("listitem", { name })).toContainText(
        "Off · needs the Marketing texts module and its own opt-in",
      );
      await expect(page.getByRole("listitem", { name }).getByRole("checkbox")).toHaveCount(0);
    }
    await expect(page.getByLabel("Reminder goes out at")).toHaveValue("");
    const reminder = page.getByRole("listitem", { name: "Reminder" });
    await reminder.getByRole("checkbox").uncheck();
    await expect(reminder).toContainText("Off");
    await expect
      .poll(
        async () =>
          (await db.query(`select "on" from message_templates where key = 'reminder'`)).rows[0].on,
      )
      .toBe(false);
    await reminder.getByRole("checkbox").check();
    await expect
      .poll(
        async () =>
          (await db.query(`select "on" from message_templates where key = 'reminder'`)).rows[0].on,
      )
      .toBe(true);
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.query(`update message_templates set "on" = true where key = 'reminder'`);
    await db.end();
  }
});

/**
 * The check-in sheet (M2-11), on the board at 1280 and on a phone at 390. At
 * 10:44 PM Sam O. is arriving; his sheet shows "3 guests · Fridays bill at
 * least 4" and his −$40.00 deposit, and checking him in gives Room 2 a new
 * code and check. On a phone, + Walk-in on Room 11 seats Leo M.'s party.
 */
test("the check-in sheet: Sam O. on the board, then a walk-in on a phone", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:44:00Z" } })).ok(),
    ).toBe(true);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    const sam = page.getByRole("listitem", { name: "Sam O.", exact: true });
    await expect(sam).toContainText("10:30 PM · Room 2");
    await expect(sam).toContainText("No-show from 10:45 PM");
    await expect(sam.getByRole("button", { name: "Mark no-show" })).toHaveCount(0);
    await sam.getByRole("button", { name: "Check in" }).click();
    const sheet = page.getByRole("dialog", { name: "Check in Sam O." });
    await expect(sheet).toContainText("3 guests · Fridays bill at least 4");
    await expect(sheet).toContainText("Deposit applied −$40.00");
    await expect(sheet).toContainText("3 of 3");
    expect(await clippedText(page)).toEqual([]);
    await sheet.getByRole("button", { name: "Check in" }).click();
    await expect(page.getByText(/^Room 2 · room code [A-Z3-9]{5} · check #\d{4}$/)).toBeVisible();
    const line = (await page.getByText(/^Room 2 · room code/).textContent()) ?? "";
    expect(/code ([A-Z3-9]{5})/.exec(line)![1]).not.toContain("2");
    await expect(page.getByRole("listitem", { name: "Sam O.", exact: true })).toHaveCount(0);
    await expect(page.getByRole("listitem", { name: "Room 2", exact: true })).toContainText(
      "In room",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    const room11 = page.getByRole("listitem", { name: "Room 11", exact: true });
    await room11.getByRole("button", { name: "+ Walk-in" }).click();
    const walkIn = page.getByRole("dialog", { name: "Walk-in · Room 11" });
    await walkIn.getByLabel("1 · Guests").fill("7");
    await expect(walkIn).toContainText("7 guests · Fridays bill at least 4");
    await walkIn.getByLabel("Guest's name").fill("Leo M.");
    expect(await clippedText(page)).toEqual([]);
    await walkIn.getByRole("button", { name: "Seat them" }).click();
    await expect(page.getByText(/^Room 11 · room code [A-Z2-9]{5} · check #\d{4}$/)).toBeVisible();
  } finally {
    await db.end();
  }
});

/**
 * ID checks (M2-12). Room 1 reads "ID ✓ 3 of 4 · the runner checks the last
 * ID" and Room 5 "ID ✓ 4 of 4", with a Scan ID button. With Safety & ID
 * records off, the button is gone and the count stays.
 */
test("the ID chip and Scan ID, with Safety & ID records on and off", async ({ page, request }) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    const room1 = page.getByRole("listitem", { name: "Room 1", exact: true });
    const room5 = page.getByRole("listitem", { name: "Room 5", exact: true });
    await expect(room1).toContainText("ID ✓ 3 of 4 · the runner checks the last ID");
    await expect(room5).toContainText("ID ✓ 4 of 4");
    await expect(room5.getByRole("button", { name: "Scan ID" })).toBeVisible();

    await db.query("update venue_modules set state = 'off' where module_id = 'safety'");
    await page.reload();
    await expect(room5).toContainText("ID ✓ 4 of 4");
    await expect(page.getByRole("button", { name: "Scan ID" })).toHaveCount(0);
  } finally {
    await db.query("update venue_modules set state = 'on' where module_id = 'safety'");
    await db.end();
  }
});

/**
 * The Approvals inbox (M2-15, N18). Andy signs in with his passkey and turns on
 * alerts, which makes this browser his staff_phone. Diego's comp over the
 * limit waits for him: "Approvals · 1" shows the line, amount, reason, who
 * asked and when, and Approve (signed with this phone's own key) puts the comp
 * on Room 9's check. Andy's own request reads "Waiting for Abhishek G.".
 */
test("Andy's phone: Approvals · 1, Diego's comp approved onto Room 9, and his own request waits for Abhishek", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      const fake = {
        endpoint: "https://push.example.test/send/andy-approvals",
        toJSON: () => ({
          endpoint: "https://push.example.test/send/andy-approvals",
          keys: { p256dh: "fake-p256dh", auth: "fake-auth" },
        }),
        unsubscribe: async () => true,
      };
      let subscribed = false;
      // Headless Chromium answers "denied" whatever the grant: the phone says yes here.
      Object.defineProperty(Notification, "permission", { get: () => "granted" });
      Notification.requestPermission = async () => "granted";
      PushManager.prototype.subscribe = async () => {
        subscribed = true;
        return fake as unknown as PushSubscription;
      };
      PushManager.prototype.getSubscription = async () =>
        (subscribed ? fake : null) as unknown as PushSubscription;
      Object.defineProperty(Notification, "permission", { get: () => "default" });
      Notification.requestPermission = async () => "granted";
    });
    await db.query(
      "update memberships set locale = 'en' where user_id = (select id from users where lower(email) = $1)",
      [ANDY],
    );
    await db.query("delete from approvals");
    await page.goto("/");
    await enrolPasskey(page, request, db);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await page.goto("/setup");
    await page.getByRole("button", { name: "Turn on alerts" }).click();
    await expect(page.getByRole("status")).toHaveText("Alerts are on");

    const people = Object.fromEntries(
      (
        await db.query<{ name: string; id: string }>(
          "select name, id from users where name in ('Diego R.', 'Andy C.', 'Abhishek G.')",
        )
      ).rows.map((r) => [r.name.split(" ")[0]!.toLowerCase(), r.id]),
    );
    const v = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    const room9 = (
      await db.query<{ id: string }>(
        "select row_id as id from seed_ids where venue_id = $1 and slug = 'chk_room9'",
        [v],
      )
    ).rows[0]!.id;
    const payload = {
      check_id: room9,
      description: "15 min of room time",
      amount_cents: 3000,
      tax_category: "room_time",
      business_date: "2026-09-25",
    };
    await db.query(
      `insert into approvals (venue_id, kind, target_kind, target_id, amount_cents, reason, payload, requested_by, requested_at, routed_to)
         values ($1, 'comp', 'check', $2, 3000, 'Mic died for 15 minutes', $3, $4, '2026-09-25T22:39:00-04:00', $5),
                ($1, 'comp', 'check', $2, 2000, 'Song system down', $3, $5, '2026-09-25T22:40:00-04:00', $6)`,
      [v, room9, JSON.stringify(payload), people["diego"], people["andy"], people["abhishek"]],
    );

    await page.goto("/tonight");
    await expect(page.getByText("Waiting for Abhishek G.")).toBeVisible();
    await page.getByRole("link", { name: "Approvals" }).last().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Approvals · 1");
    await expect(page.getByText("Comp · 15 min of room time")).toBeVisible();
    await expect(page.getByText("$30.00")).toBeVisible();
    await expect(page.getByText("Reason: Mic died for 15 minutes")).toBeVisible();
    await expect(page.getByText(/Diego R\. asked at 10:39\s?PM/)).toBeVisible();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Approvals · 0");
    await expect(page.getByText("Nothing to approve")).toBeVisible();
    const line = await db.query<{ amount_cents: string; approved_by: string }>(
      "select amount_cents::text, approved_by from check_lines where check_id = $1 and kind = 'comp'",
      [room9],
    );
    expect(line.rows).toEqual([{ amount_cents: "-3000", approved_by: people["andy"] }]);
  } finally {
    await db.end();
  }
});

/**
 * Report a fault on the board (M2-16, N14). Room 4 reads "Out of service"
 * with its note; a fault in Room 5 with Comp 15 min writes the −$10.00 comp at
 * once; a fault in Room 9 with Pause the clock waits for approval (Andy's own
 * goes to Abhishek); Fixed takes a fault off its tile.
 */
test("Report a fault: Room 4 out of service, a comp in Room 5, a pause in Room 9 waiting for Abhishek, then Fixed", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await db.query("delete from approvals");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    const room4 = page.getByRole("listitem", { name: "Room 4", exact: true });
    await expect(room4).toContainText("Out of service");
    await expect(room4).toContainText("Mic dead since Tue. Replacement ordered.");

    const room5 = page.getByRole("listitem", { name: "Room 5", exact: true });
    await room5.getByRole("button", { name: "Report a fault" }).click();
    let sheet = page.getByRole("dialog", { name: "Report a fault · Room 5" });
    await sheet.getByLabel("What's wrong").fill("Mic 2 cuts out");
    await sheet.getByLabel("Comp 15 min of room time").check();
    expect(await clippedText(page)).toEqual([]);
    await sheet.getByRole("button", { name: "Log the fault" }).click();
    await expect(page.getByText("Fault logged in Room 5 · Comp of $10.00 added")).toBeVisible();
    await expect(room5).toContainText("Mic 2 cuts out");

    const room9 = page.getByRole("listitem", { name: "Room 9", exact: true });
    await room9.getByRole("button", { name: "Report a fault" }).click();
    sheet = page.getByRole("dialog", { name: "Report a fault · Room 9" });
    await sheet.getByLabel("What's wrong").fill("TV keeps rebooting");
    await sheet.getByLabel(/Pause the clock/).check();
    await sheet.getByRole("button", { name: "Log the fault" }).click();
    await expect(page.getByText("Fault logged in Room 9 · Waiting for Abhishek G.")).toBeVisible();
    await expect(page.getByRole("list").getByText("Waiting for Abhishek G.")).toBeVisible();

    await room5.getByRole("button", { name: "Fixed" }).click();
    await expect(room5).not.toContainText("Mic 2 cuts out");
    const lines = await db.query<{ amount_cents: string }>(
      "select l.amount_cents::text from room_faults f join check_lines l on l.id = f.comp_line_id where f.text = 'Mic 2 cuts out'",
    );
    expect(lines.rows).toEqual([{ amount_cents: "-1000" }]);
  } finally {
    await db.end();
  }
});

/** The party-size control on the board (M2-17, N13): Room 9 from 12 to 13 shows $130.00 an hour and the chip follows. */
test("the party-size control: Room 9 one guest more shows the new rate and ID 12 of 13", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    const room9 = page.getByRole("listitem", { name: "Room 9", exact: true });
    const before = Number(/(\d+) guests/.exec((await room9.textContent()) ?? "")![1]);
    await room9.getByRole("button", { name: "One guest more" }).click();
    await expect(room9).toContainText(`${before + 1} guests`);
    await expect(room9).toContainText(`$${(before + 1) * 10}.00 an hour · bills at least 4`);
    await expect(room9).toContainText(`12 of ${before + 1}`);
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * The move sheet from the board's alert (M2-18, N12): Room 7 reads "Needed
 * now" with the Parks booked at 11:00; Move lists Room 11, free all night,
 * greys out Room 8 (booked next), and the move gives a new room code.
 */
test("the move sheet: Rob & Kim from Room 7 to Room 11 with a new code", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    // Earlier tests seat a walk-in in Room 11; this one starts from a fresh load of the demo seed at 10:41 PM.
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    const room7 = page.getByRole("listitem", { name: "Room 7", exact: true });
    await expect(room7).toContainText("Needed now");
    // The board's alert also offers the wrap-up text (M2-24).
    await expect(room7.getByRole("button", { name: /^Text .+: please wrap up$/ })).toBeVisible();
    await room7.getByRole("button", { name: "Move" }).click();
    const sheet = page.getByRole("dialog", { name: "Move Room 7" });
    await expect(sheet.getByRole("button", { name: "Room 11 · free all night" })).toBeVisible();
    await expect(sheet).toContainText("Room 8 · booked next");
    await expect(sheet).toContainText("Room 1 · too small");
    expect(await clippedText(page)).toEqual([]);
    // Rob's phone, joined from his Room code text before the move (M3-08).
    const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const robsPhone = await guest.newPage();
    const hostToken = createHash("sha256")
      .update("host-token:sess_room7")
      .digest("base64url")
      .slice(0, 32);
    await robsPhone.goto(`http://localhost:3001/r/${hostToken}`);
    await expect(robsPhone.getByRole("heading", { level: 1 })).toHaveText(
      /^Room 7 · Code [A-Z2-9]{5}$/,
    );
    await sheet.getByRole("button", { name: "Room 11 · free all night" }).click();
    const moved = page.getByText(/^Moved to Room 11 · new code [A-Z2-9]{5}$/);
    await expect(moved).toBeVisible();
    const newCode = (await moved.innerText()).slice(-5);
    // His phone shows the move and the new code; the old code stops working.
    await robsPhone.reload();
    await expect(robsPhone.getByRole("status")).toHaveText(
      `You've moved to Room 11 · new code ${newCode}`,
    );
    await expect(robsPhone.getByRole("heading", { level: 1 })).toHaveText(
      `Room 11 · Code ${newCode}`,
    );
    await guest.close();
    await expect(page.getByRole("listitem", { name: "Room 11", exact: true })).toContainText(
      "7 guests",
    );
  } finally {
    await db.end();
  }
});

/**
 * Cleaning, room notes and lost and found on the board (M2-19, N15). Room 6
 * needs a wipe since 10:33 PM and keeps its note; Mark clean makes it Open; a
 * lost item logged in Room 9 reads "Found in Room 9 · kept at the bar", then
 * "claimed by Marcus T.".
 */
test("cleaning and the lost-and-found log: Room 6 marked clean, a scarf found in Room 9 and claimed", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    const room6 = page.getByRole("listitem", { name: "Room 6", exact: true });
    await expect(room6).toContainText(/Needs a wipe · left 10:33\s?PM \(\d+ min\)/);
    await expect(room6).toContainText("TV remote goes missing. Check under the couch.");
    await room6.getByRole("button", { name: "Mark clean" }).click();
    await expect(room6.getByRole("button", { name: "+ Walk-in" })).toBeVisible();
    await expect(room6).toContainText("TV remote goes missing. Check under the couch.");

    await page.getByRole("button", { name: "Log a lost item" }).click();
    const form = page.getByRole("form", { name: "Log a lost item" });
    await form.getByLabel("What it is").fill("Green scarf");
    await form.getByLabel("Where it was found").selectOption({ label: "Room 9" });
    await form.getByLabel("Kept at").fill("the bar");
    expect(await clippedText(page)).toEqual([]);
    await form.getByRole("button", { name: "Log it" }).click();
    const scarf = page.getByRole("listitem", { name: "Green scarf" });
    await expect(scarf).toContainText("Found in Room 9 · kept at the bar");
    await scarf.getByRole("button", { name: "Claimed" }).click();
    await scarf.getByLabel("Who claimed it").fill("Marcus T.");
    await scarf.getByRole("button", { name: "Hand over" }).click();
    await expect(scarf).toContainText("Found in Room 9 · kept at the bar · claimed by Marcus T.");
  } finally {
    await db.end();
  }
});

/**
 * The Calls list on a phone (M2-20, N19): Room 9's "Another mic, please" shows
 * on Andy's phone and on the board; On it clears it everywhere and records him.
 */
test("the Calls list on a phone: Room 9's mic call, On it clears it on the board too", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    // The board in a second window, signed in as the same person.
    const board = await browser.newPage({ storageState: await page.context().storageState() });
    await board.setViewportSize({ width: 1280, height: 800 });
    await board.goto("/tonight");
    const boardCall = board
      .getByRole("list", { name: "Alerts" })
      .getByRole("listitem", { name: /^Room 9 called for another mic, \d+ min ago\.$/ });
    await expect(boardCall).toBeVisible();

    await page.getByRole("link", { name: "Calls" }).last().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Calls");
    const call = page.getByRole("listitem", { name: "Room 9 · Another mic, please" });
    await expect(call).toContainText("min ago");
    expect(await clippedText(page)).toEqual([]);
    await call.getByRole("button", { name: "On it" }).click();
    await expect(page.getByText("No calls")).toBeVisible();
    await expect(boardCall).toHaveCount(0);
    const acked = await db.query<{ name: string }>(
      "select u.name from room_calls k join users u on u.id = k.acked_by where k.kind = 'mic'",
    );
    expect(acked.rows).toEqual([{ name: "Andy C." }]);
    await board.close();
  } finally {
    await db.end();
  }
});

/**
 * The damage fee on a phone with a fake camera (M2-21): Room 9's Damage fee
 * takes a photo and a reason, and the $150.00 line shows the photo's thumbnail.
 */
test("the damage fee on a phone: a camera photo and a reason add $150.00 with its thumbnail", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    const room9 = page.getByRole("listitem", { name: "Room 9", exact: true });
    await room9.getByRole("button", { name: "Damage fee" }).click();
    const sheet = page.getByRole("dialog", { name: "Damage fee · Room 9" });
    await expect(sheet.getByRole("button", { name: "Add the damage fee" })).toBeDisabled();
    // The fake camera: a 1×1 PNG handed to the capture input.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await sheet.getByLabel("Photo of the damage").setInputFiles({
      name: "camera.png",
      mimeType: "image/png",
      buffer: png,
    });
    await sheet.getByLabel("What happened").fill("Broken mic stand");
    expect(await clippedText(page)).toEqual([]);
    await sheet.getByRole("button", { name: "Add the damage fee" }).click();
    const line = sheet.getByRole("listitem", { name: "Damage fee $150.00" });
    await expect(line).toContainText("Broken mic stand");
    await expect(line.getByRole("img", { name: "Broken mic stand" })).toBeVisible();
    await expect(line.getByRole("img", { name: "Broken mic stand" })).toHaveJSProperty(
      "naturalWidth",
      1,
    );
    await expect(sheet.getByRole("status")).toContainText(/^Tab so far \$[\d,]+\.\d{2}$/);
  } finally {
    await db.end();
  }
});

/**
 * Messages on the desktop and the phone (M2-22). From a fresh seed: Sam O.'s
 * "running 15 late" is unread; Reply "no problem" sends the Running late reply
 * and the board's arrival reads held until 10:45 PM; a reply with a link is
 * refused; Marcus T.'s thread reads as in the seed on a phone; both screens
 * list the 14 automatic texts in Admin's order.
 */
test("Messages on desktop and phone: Sam O.'s running late, Reply no problem, a link refused, the 14 texts", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    // Earlier tests check Sam O. in; this one starts from a fresh load of the demo seed at 10:41 PM.
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    const names = (
      await db.query<{ key: string }>("select key from message_templates order by position")
    ).rows.map((r) => catalogs.en[`texts.name.${r.key}` as keyof typeof catalogs.en]);
    expect(names).toHaveLength(14);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await expect(page.getByRole("link", { name: /Messages 1/ }).first()).toBeVisible();
    await page
      .getByRole("link", { name: /Messages/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Messages");
    const samButton = page.getByRole("button", { name: "Sam O." });
    await expect(samButton).toContainText("1 unread");
    await expect(page.locator(".texts-list li")).toHaveText(names.map((n) => new RegExp(`^${n}`)));
    expect(await clippedText(page)).toEqual([]);
    await samButton.click();
    const thread = page.getByRole("region", { name: "Sam O." });
    await expect(thread).toContainText(/Sam O\. · 10:24\s?PM/);
    await expect(thread).toContainText("running 15 late");
    await thread.getByRole("button", { name: 'Reply "no problem"' }).click();
    await expect(thread).toContainText("No problem. We'll hold your room until 10:45 PM.");
    await thread.getByLabel("Reply").fill("Book again at west4karaoke.com/book");
    await thread.getByRole("button", { name: "Send" }).click();
    await expect(thread.getByRole("alert")).toHaveText(
      "A reply can't carry a link. For a deposit, send the Payment link text.",
    );
    await page.goto("/tonight");
    await expect(page.getByRole("listitem", { name: "Sam O.", exact: true })).toContainText(
      /Room 2 · Open · held for Sam O\. until 10:45\s?PM/,
    );

    const phone = await browser.newPage({ storageState: await page.context().storageState() });
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto("/messages");
    await expect(phone.locator(".texts-list li")).toHaveText(names.map((n) => new RegExp(`^${n}`)));
    await phone.getByRole("button", { name: "Marcus T." }).click();
    const marcus = phone.getByRole("region", { name: "Marcus T." });
    await expect(marcus.locator(".text")).toHaveText([
      /Booked\. Room for 12 at 8:00 PM, Fri Sep 25\. Deposit \$120 paid, comes off your bill\.$/,
      /if we're having fun can we stay past 11\?(Mark as an opt-out)?$/,
      /Nobody has Room 9 after you tonight, so you can stay on by the minute until we close at 4 AM\.$/,
    ]);
    await expect(phone.getByRole("button", { name: "Sam O." })).toBeHidden();
    expect(await clippedText(phone)).toEqual([]);
    await phone.close();
  } finally {
    await db.end();
  }
});

/**
 * The waitlist drawer on the board (M2-25, N11), from a fresh seed: "Waitlist
 * · 3" opens Amara B. (7), Nadia K. (6) and Chris P. (3, bills as 4); Remove
 * takes Amara off the drawer and the count.
 */
test("the waitlist drawer: Waitlist · 3, the three parties, and Remove", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await page.getByRole("button", { name: "Waitlist · 3" }).click();
    const drawer = page.getByRole("complementary", { name: "Waitlist" });
    const amara = drawer.getByRole("listitem", { name: "Amara B." });
    await expect(amara).toContainText("7 guests");
    await expect(amara).toContainText(/Joined 10:15\s?PM · waited 26 min/);
    await expect(amara).toContainText("Quoted 25 min");
    await expect(drawer.getByRole("listitem", { name: "Nadia K." })).toContainText("6 guests");
    await expect(drawer.getByRole("listitem", { name: "Chris P." })).toContainText(
      "3 guests · bills as 4",
    );
    expect(await clippedText(page)).toEqual([]);
    await amara.getByRole("button", { name: "Remove" }).click();
    await expect(drawer.getByRole("listitem", { name: "Amara B." })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Waitlist · 2" })).toBeVisible();
  } finally {
    await db.end();
  }
});

/**
 * Offering a room (M2-26), from a fresh seed. The board's lime alert offers
 * Room 11 to Amara B. and the drawer counts down. After Sam O.'s no-show at
 * 10:45 PM, a guest who joined fourth at the door is offered Room 2, and their
 * page reads "Room 2 is ready · 10:00 to claim it".
 */
test("offers: Room 11 to Amara with a countdown, and Room 2 on the fourth guest's page", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await expect(
      page.getByText("Room 11 is free all night, and Amara B. (7) has waited 26 min."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Offer Room 11 · 10 min to claim" }).click();
    const amara = page
      .getByRole("complementary", { name: "Waitlist" })
      .getByRole("listitem", { name: "Amara B." });
    await expect(amara.getByRole("timer")).toHaveText(/^Room 11 · (10:00|9:\d\d) to claim$/);
    expect(await clippedText(page)).toEqual([]);

    // The fourth guest joins at the door; Sam O. no-shows at 10:45; the guest is offered Room 2.
    const slug = (await db.query<{ slug: string }>("select slug from venues limit 1")).rows[0]!
      .slug;
    const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await guest.goto(`http://localhost:3001/v/${slug}/waitlist`);
    await guest.getByLabel("Your name").fill("Jordan L.");
    await guest.getByLabel("Mobile number").fill("2125550145");
    await guest.getByLabel("How many of you").fill("4");
    await guest.getByRole("button", { name: "Join the waitlist" }).click();
    await expect(guest.getByRole("status")).toHaveText("3 parties ahead");
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:45:00Z" } })).ok(),
    ).toBe(true);
    const v = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    const sam = (
      await db.query<{ id: string }>(
        "select row_id as id from seed_ids where venue_id = $1 and slug = 'bk_sam'",
        [v],
      )
    ).rows[0]!.id;
    expect(
      (await page.request.post(`/v1/venues/${v}/bookings/${sam}/no-show`, { data: {} })).ok(),
    ).toBe(true);
    const jordan = (
      await db.query<{ id: string }>(
        "select w.id from waitlist_entries w join guests g on g.id = w.guest_id where g.name = 'Jordan L.'",
      )
    ).rows[0]!.id;
    const offered = await page.request.post(`/v1/venues/${v}/waitlist/${jordan}/offer`);
    expect(offered.status(), await offered.text()).toBe(201);
    await guest.reload();
    await expect(guest.getByRole("status")).toHaveText(
      /^Room 2 is ready · (10:00|9:5\d) to claim it$/,
    );
    await expect(guest.getByRole("button", { name: "Give it away" })).toBeVisible();
    await guest.close();
  } finally {
    await db.end();
  }
});

/**
 * The headcount and the door counter (M2-28, N31), from a fresh seed: 93
 * inside (77 in rooms, 16 waiting), "Limit not set · Admin → Safety" and no
 * limit number; + makes it 94 and − takes it back; Admin → Safety shows the
 * limit empty and the 90% warning share.
 */
test("the headcount: 93 inside, limit not set, the door counter, and Admin → Safety", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    const count = page.getByRole("group", { name: "Headcount" });
    await expect(count).toContainText("93 inside");
    await expect(count).toContainText("77 in rooms · 16 waiting");
    await expect(count).toContainText("Limit not set · Admin → Safety");
    await expect(count).not.toContainText(/Limit \d/);
    await count.getByRole("button", { name: "One person in" }).click();
    await expect(count).toContainText("94 inside");
    await count.getByRole("button", { name: "One person out" }).click();
    await expect(count).toContainText("93 inside");
    expect(await clippedText(page)).toEqual([]);

    await count.getByRole("link", { name: "Limit not set · Admin → Safety" }).click();
    await expect(page.getByLabel("Occupancy limit")).toHaveValue("");
    await expect(page.getByLabel("Warn at (% of the limit)")).toHaveValue("90");
  } finally {
    await db.end();
  }
});

/**
 * The Tonight board read against the seed file (M2-29): from a fresh load at
 * 10:41 PM, every tile's words, every "Room time so far" and "Tab so far" to
 * the cent, and the counts.
 */
test("the Tonight board at 10:41 PM matches seed/west4-friday.json tile by tile", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const seed = JSON.parse(readFileSync("seed/west4-friday.json", "utf8")) as {
    rooms: { id: string; name: string; board_label: string }[];
    sessions: { id: string; room: string }[];
    checks: {
      room_session?: string;
      expected_at_now?: { room_time_cents?: number; tab_so_far_cents?: number };
    }[];
    counts: {
      rooms: { in_use_or_wrap_up: number; open: number; cleaning: number; out_of_service: number };
    };
  };
  const dollars = (cents: number) =>
    `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    const c = seed.counts.rooms;
    await expect(page.getByLabel("Room counts")).toHaveText(
      `${c.in_use_or_wrap_up} in use · ${c.open} open · ${c.cleaning} cleaning · ${c.out_of_service} out of service`,
    );
    for (const room of seed.rooms) {
      const tile = page.getByRole("listitem", { name: room.name, exact: true });
      // Browsers may put a narrow space before PM; the words are otherwise exact.
      const words = room.board_label
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/ (AM|PM)/g, "\\s?$1");
      await expect(tile, room.name).toContainText(new RegExp(words));
    }
    for (const check of seed.checks.filter((x) => x.room_session && x.expected_at_now)) {
      const session = seed.sessions.find((s) => s.id === check.room_session)!;
      const room = seed.rooms.find((r) => r.id === session.room)!;
      const tile = page.getByRole("listitem", { name: room.name, exact: true });
      await expect(tile, room.name).toContainText(
        `Room time so far ${dollars(check.expected_at_now!.room_time_cents!)}`,
      );
      await expect(tile, room.name).toContainText(
        `Tab so far ${dollars(check.expected_at_now!.tab_so_far_cents!)}`,
      );
    }
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * The board's alerts (M2-30), from a fresh seed, against `board_alerts` in the
 * seed file less Room 5's order (M3): pink, amber, lime, grey in that order;
 * [Move a room…] opens the move sheet on Room 7; [Offer Room 11 · 10 min to
 * claim] makes the offer; the waitlist party is Nadia K., never Priya K.
 */
test("the alerts band: the seed's alerts in order, Move a room… and the offer", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const seed = JSON.parse(readFileSync("seed/west4-friday.json", "utf8")) as {
    board_alerts: { rank: number; color: string; text: string }[];
  };
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    const band = page.getByRole("list", { name: "Alerts" });
    const expected = seed.board_alerts;
    await expect(band.getByRole("listitem")).toHaveCount(expected.length);
    const items = band.getByRole("listitem");
    // The colors in the seed's order, and each alert's key facts.
    for (const [i, a] of expected.entries())
      await expect(items.nth(i)).toHaveClass(new RegExp(`\\b${a.color}\\b`));
    await expect(items.nth(0)).toContainText(
      "Room 7 is 11 min past its time, and The Parks (8) are booked into Room 7 at 11:00.",
    );
    await expect(items.nth(1)).toContainText("Room 9 called for another mic, 2 min ago.");
    // The 2-minute escalation (M3-16), with Show taking the bar to its orders.
    await expect(items.nth(2)).toContainText(
      /Room 5's order has been ringing 2:1\d \(4 × Bud Light\)\./,
    );
    await expect(items.nth(2).getByRole("button", { name: "Show" })).toBeVisible();
    await expect(items.nth(3)).toContainText(
      "Room 3: 4 min left, and Jae & co. are booked at 11:00.",
    );
    await expect(items.nth(4)).toContainText(
      "Room 11 is free all night, and Amara B. (7) has waited 26 min.",
    );
    await expect(items.nth(5)).toContainText(
      "Rooms 6 and 13 need a wipe (8 and 5 min), and Nadia K. and Chris P. are waiting.",
    );
    await expect(items.nth(6)).toContainText(
      'Sam O. texted "running 15 late" for the 10:30 in Room 2, and it\'s held until 10:45.',
    );
    await expect(page.getByText("Priya K.")).toHaveCount(0);
    expect(await clippedText(page)).toEqual([]);

    await items.nth(0).getByRole("button", { name: "Move a room…" }).click();
    await expect(page.getByRole("dialog", { name: "Move Room 7" })).toBeVisible();
    await page
      .getByRole("dialog", { name: "Move Room 7" })
      .getByRole("button", { name: "Cancel" })
      .click();
    await items.nth(4).getByRole("button", { name: "Offer Room 11 · 10 min to claim" }).click();
    await expect(
      page
        .getByRole("complementary", { name: "Waitlist" })
        .getByRole("listitem", { name: "Amara B." })
        .getByRole("timer"),
    ).toHaveText(/^Room 11 · (10:00|9:\d\d) to claim$/);
  } finally {
    await db.end();
  }
});

/**
 * DeskRoom and the Room phone (M2-31), from a fresh seed: Room 9's clock,
 * rate, running tab and deposit; Room 10's stay-on line; Room 3's wrap-up
 * prompt; "Tab & close out →" on a phone opens Room 9's tab.
 */
test("DeskRoom and the Room phone: Room 9's running tab, Room 10 staying on, Room 3 wrapping up", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    const readRoom9 = async (p: Page) => {
      await expect(p.getByRole("heading", { level: 1 })).toHaveText("Room 9");
      await expect(p.getByLabel("Room clock")).toHaveText("161 min · $2.00 a minute");
      const tab = p.getByRole("region", { name: "Running tab" });
      await expect(tab).toContainText("Room time so far$322.00");
      await expect(tab).toContainText("Drinks$158.00");
      await expect(tab).toContainText("Tab so far$480.00");
      await expect(tab).toContainText("Deposit $120.00 · comes off at settle-up");
      await expect(tab).not.toContainText("Margarita · Peach");
      expect(await clippedText(p)).toEqual([]);
    };
    await page
      .getByRole("listitem", { name: "Room 9", exact: true })
      .getByRole("link", { name: "Tab & close out →" })
      .click();
    await readRoom9(page);

    const v = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    const roomId = async (name: string) =>
      (
        await db.query<{ id: string }>("select id from rooms where venue_id = $1 and name = $2", [
          v,
          name,
        ])
      ).rows[0]!.id;
    await page.goto(`/room/${await roomId("Room 10")}`);
    await expect(page.getByText("Stay on by the minute until we close at 4 AM")).toBeVisible();
    await page.goto(`/room/${await roomId("Room 3")}`);
    await expect(page.getByText("Wrap up · Jae & co. at 11:00")).toBeVisible();

    const phone = await browser.newPage({
      storageState: await page.context().storageState(),
      viewport: { width: 390, height: 844 },
    });
    await phone.goto("/tonight");
    await phone
      .getByRole("listitem", { name: "Room 9", exact: true })
      .getByRole("link", { name: "Tab & close out →" })
      .click();
    await readRoom9(phone);
    await phone.close();
  } finally {
    await db.end();
  }
});

/**
 * The staff phone's tabs (M2-32), on a phone, from a fresh seed. Andy's
 * Tonight lists the 11 bookings as the seed's table has them, with Leo M.'s
 * walk-in in the room view; Sam O.'s Details offer Check in and Mark no-show
 * only from 10:45; Marcus T.'s seated booking offers neither; turning off
 * Walk-in waitlist removes the Waitlist tab at once. A runner's phone shows
 * check-in, the waitlist and Calls, and no Approvals.
 */
test("the staff phone: Andy's Tonight, booking actions by status, and a runner's tabs", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    const tabs = page.locator(".tabs");
    await tabs.getByRole("link", { name: "Tonight", exact: true }).click();
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByLabel("Room counts")).toHaveText(
      "8 in room · 3 open · 2 cleaning · 1 out of service",
    );
    const rows = page.getByRole("list", { name: "Bookings tonight" }).getByRole("listitem");
    await expect(rows).toHaveText([
      /^7:00\sPM · Tanya W\. · 9 · Room 10 · 3 hr · \$90\.00Seated$/,
      /^8:00\sPM · Marcus T\. · 12 · Room 9 · 3 hr · \$120\.00Seated$/,
      /^8:30\sPM · Rob & Kim · 7 · Room 7 · 2 hr · \$70\.00Seated$/,
      /^8:45\sPM · Priya R\. · 5 · Room 3 · 2 hr · \$50\.00Seated$/,
      /^9:00\sPM · Omar F\. · 14 · Room 12 · 3 hr · \$140\.00Seated$/,
      /^9:30\sPM · Dana K\. · 4 · Room 1 · 2 hr · \$40\.00Seated$/,
      /^9:30\sPM · Bianca L\. · 22 · VIP room · 3 hr · \$250\.00Seated$/,
      /^10:30\sPM · Sam O\. · 3 · Room 2 · 1 hr · \$40\.00Late · held until 10:45\sPM$/,
      /^11:00\sPM · Jae & co\. · 5 · Room 3 · 2 hr · \$50\.00Booked$/,
      /^11:00\sPM · The Parks · 8 · Room 7 · 2 hr · \$80\.00Booked$/,
      /^11:00\sPM · The Nguyens · 6 · Room 8 · 2 hr · \$60\.00Booked$/,
    ]);
    await expect(
      page.getByRole("list", { name: "Room by room" }).getByRole("listitem", { name: "Room 5" }),
    ).toHaveText("Room 5 Leo M. · 4");
    expect(await clippedText(page)).toEqual([]);

    await page.getByRole("listitem", { name: "Sam O." }).getByRole("button").click();
    let sheet = page.getByRole("dialog", { name: "Sam O." });
    await expect(sheet.getByRole("button", { name: "Check in" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Mark no-show" })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("listitem", { name: "Marcus T." }).getByRole("button").click();
    sheet = page.getByRole("dialog", { name: "Marcus T." });
    await expect(sheet.getByRole("button", { name: "Check in" })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Mark no-show" })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Cancel" }).click();
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:45:00Z" } })).ok(),
    ).toBe(true);
    await page.reload();
    await page.getByRole("listitem", { name: "Sam O." }).getByRole("button").click();
    await expect(
      page.getByRole("dialog", { name: "Sam O." }).getByRole("button", { name: "Mark no-show" }),
    ).toBeVisible();

    // Walk-in waitlist off: the Waitlist tab goes at once.
    await expect(tabs.getByRole("link", { name: "Waitlist" })).toBeVisible();
    const v = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    await db.query(
      "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'waitlist'",
      [v],
    );
    await db.query(
      "insert into venue_events (venue_id, type, entity_id, entity_version, audience) values ($1::uuid, 'settings.changed', $1::text, 0, 'venue')",
      [v],
    );
    await expect(tabs.getByRole("link", { name: "Waitlist" })).toHaveCount(0);
    await db.query(
      "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'waitlist'",
      [v],
    );

    // A runner's phone, signed in the way staff are: an invite, a texted code, their own PIN.
    const RUNNER = "runner-test@demo.west4.local";
    const RUNNER_PHONE = "+12125550177";
    await db.query(
      "delete from auth_sessions where user_id in (select id from users where email = $1)",
      [RUNNER],
    );
    await db.query("delete from users where email = $1", [RUNNER]);
    const user = await db.query<{ id: string }>(
      "insert into users (name, email) values ('Rae T.', $1) returning id",
      [RUNNER],
    );
    const membership = await db.query<{ id: string }>(
      `insert into memberships (venue_id, user_id, role, status, pin_digits, locale)
         values ($1, $2, 'staff', 'invited', 4, 'en') returning id`,
      [v, user.rows[0]!.id],
    );
    const token = randomBytes(32).toString("base64url");
    await db.query(
      `insert into invites (venue_id, membership_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '2 days')`,
      [v, membership.rows[0]!.id, createHash("sha256").update(token).digest("hex")],
    );
    const runner = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await runner.goto(`/invite/${token}`);
    await runner.getByLabel("Your mobile number").fill(RUNNER_PHONE);
    await runner.getByRole("button", { name: "Text me a code" }).click();
    await expect(runner.getByText(`We texted a code to ${RUNNER_PHONE}`)).toBeVisible();
    const code = await db.query<{ payload: { data: { code: string } } }>(
      "select payload from jobs where kind = 'text.send' and payload->>'to' = $1 order by created_at desc limit 1",
      [RUNNER_PHONE],
    );
    await runner.getByLabel("The code from the text").fill(code.rows[0]!.payload.data.code);
    await runner.getByRole("button", { name: "Confirm" }).click();
    await runner.getByLabel("Choose your PIN", { exact: true }).fill("7193");
    await runner.getByLabel("Type it again").fill("7193");
    await runner.getByRole("button", { name: "Set my PIN" }).click();
    await expect(runner.getByRole("status")).toContainText("You're set");
    await runner.goto("/sign-in");
    await typePin(runner, "7193");
    await expect(runner.getByRole("heading", { level: 1 })).toHaveText("Time clock");
    await runner.getByRole("button", { name: "Not now" }).click();
    const runnerTabs = runner.locator(".tabs");
    await expect(runnerTabs.getByRole("link", { name: "Tonight", exact: true })).toBeVisible();
    await expect(runnerTabs.getByRole("link", { name: "Calls" })).toBeVisible();
    await expect(runnerTabs.getByRole("link", { name: "Waitlist" })).toBeVisible();
    await expect(runnerTabs.getByRole("link", { name: "Approvals" })).toHaveCount(0);
    await expect(runnerTabs.getByRole("link", { name: "Rooms" })).toHaveCount(0);
    await runner.close();
  } finally {
    await db.end();
  }
});

/**
 * The Calendar on desktop and phone (M2-33), from a fresh seed: Tonight's 11
 * bookings and not Leo M.; a 22-guest booking at 11:00 PM tonight is refused
 * (Bianca L. holds the VIP room) and one at 9:00 PM too (past); blocking Sat
 * Sep 26 lists the bookings it affects and marks the day closed.
 */
test("the Calendar: tonight's 11 bookings, refused slots, and blocking Sat Sep 26", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await page.getByRole("link", { name: "Calendar" }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Calendar");
    const readTonight = async (p: Page) => {
      await expect(p.getByRole("heading", { level: 2 }).first()).toContainText(
        "Tonight · Fri, Sep 25",
      );
      const list = p.getByRole("list", { name: "Bookings" }).getByRole("listitem");
      await expect(list).toHaveCount(11);
      await expect(p.getByRole("list", { name: "Bookings" })).not.toContainText("Leo M.");
      expect(await clippedText(p)).toEqual([]);
    };
    await readTonight(page);

    const tryBooking = async (time: string, expected: string) => {
      await page.getByRole("button", { name: "New booking" }).click();
      const form = page.getByRole("form", { name: "New booking" });
      await form.getByLabel("Name").fill("Test Party");
      await form.getByLabel("Guests").fill("22");
      await form.getByLabel("Time").fill(time);
      await form.getByRole("button", { name: "Book it" }).click();
      await expect(page.getByRole("alert")).toHaveText(expected);
      await form.getByRole("button", { name: "Cancel" }).click();
    };
    await tryBooking("23:00", "That room isn't free then");
    await tryBooking("21:00", "That time has passed");

    await page.getByRole("button", { name: /^Sat, Sep 26/ }).click();
    const saturday = await db.query<{ n: number }>(
      "select count(*)::int as n from bookings where business_date = '2026-09-26' and status in ('pending', 'confirmed')",
    );
    await page.getByRole("button", { name: "Block this date" }).click();
    const dialog = page.getByRole("dialog", { name: "Block this date" });
    await expect(dialog).toContainText(`This date has ${saturday.rows[0]!.n} bookings:`);
    await expect(dialog.getByRole("listitem")).toHaveCount(saturday.rows[0]!.n);
    await dialog.getByRole("button", { name: "Block the date" }).click();
    await expect(page.getByRole("button", { name: /^Sat, Sep 26/ })).toContainText("Closed");

    const phone = await browser.newPage({
      storageState: await page.context().storageState(),
      viewport: { width: 390, height: 844 },
    });
    await phone.goto("/calendar");
    await readTonight(phone);
    await phone.close();
  } finally {
    await db.end();
  }
});

/**
 * Admin → Hours & prices and Alerts & rules (M2-34), from a fresh seed: West
 * 4's prices in every field; a band with a 15-minute step saves and publishes;
 * a 15-minute room-ending warning turns Room 9 amber at 15 minutes left and
 * not at 16; Alerts & rules has no alarm toggle.
 */
test("Admin prices and alerts: West 4's prices, a 15-minute band, and a 15-minute warning", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await page.goto("/admin/hours");
    await expect(page.getByLabel("How rooms are priced", { exact: true })).toHaveValue("perPerson");
    await expect(page.getByLabel("Per person an hour ($)", { exact: true })).toHaveValue("10.00");
    await expect(page.getByLabel("Billed in steps of", { exact: true })).toHaveValue("1");
    await expect(page.getByLabel("At least this many guests, weeknights")).toHaveValue("3");
    await expect(page.getByLabel("At least this many guests, Friday and Saturday")).toHaveValue(
      "4",
    );
    await expect(page.getByLabel("Bill at least the first hour")).toBeChecked();
    await expect(page.getByText("No time bands: one price all night")).toBeVisible();
    await expect(page.getByLabel("A flat VIP rate for big parties")).toBeChecked();
    await expect(page.getByLabel("VIP room")).toBeChecked();
    await expect(page.getByLabel("VIP an hour ($)")).toHaveValue("250.00");
    await expect(page.getByLabel("From this many guests")).toHaveValue("20");
    await expect(page.getByLabel("Damage fee ($)")).toHaveValue("150.00");
    await expect(page.getByText("Off: no room has a minimum spend")).toBeVisible();
    expect(await clippedText(page)).toEqual([]);

    await page.getByRole("button", { name: "Add a time band" }).click();
    await page.getByLabel("Band 1: Billed in steps of").selectOption("15");
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(page.getByText("Published")).toBeVisible();
    const bands = await db.query<{ step: number }>(
      "select (value->'bands'->0->'billing'->>'incrementMin')::int as step from venue_settings where key = 'prices' order by version desc limit 1",
    );
    expect(bands.rows).toEqual([{ step: 15 }]);

    await page.goto("/admin/alerts");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Alerts & rules");
    await expect(page.getByText(/ring the bar/i)).toHaveCount(0);
    await page.getByLabel("Warn this many minutes before a room's booked end").fill("15");
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(page.getByText("Published")).toBeVisible();

    // Room 9 ends at 11:00 PM: not amber at 10:44 (16 min left), amber at 10:45 (15).
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:44:00Z" } })).ok(),
    ).toBe(true);
    await page.goto("/tonight");
    const room9 = page.getByRole("listitem", { name: "Room 9", exact: true });
    await expect(room9).toContainText("In room · 16 min left");
    await expect(room9).not.toHaveClass(/amber/);
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:45:00Z" } })).ok(),
    ).toBe(true);
    await page.reload();
    await expect(room9).toHaveClass(/amber/);
  } finally {
    await db.end();
  }
});

/**
 * The seed's M2 scenarios (M2-35; seed `scenarios`), each from a fresh load at
 * 10:41 PM, on desktop and phone sizes.
 */
const SIZES = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;

async function signInAndy(page: Page, request: APIRequestContext, db: pg.Client) {
  await db.query("update memberships set locale = 'en'");
  await page.goto("/");
  await enrolPasskey(page, request, db, ANDY);
  await page.getByLabel("Email").fill(ANDY);
  await page.getByRole("button", { name: "Continue with a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
}
/**
 * A timed staff task (M6-28; spec 10 · How we'll know it works): its taps and seconds are recorded on
 * the test as a "timed task" annotation (the JSON reporter keeps them), then checked against the target.
 */
const timedTask = (task: string, taps: number, ms: number, targetMs: number) => {
  test.info().annotations.push({
    type: "timed task",
    description: `${task} · ${taps} ${taps === 1 ? "tap" : "taps"} · ${(ms / 1000).toFixed(2)} s · target under ${targetMs / 1000} s`,
  });
  expect(ms, `${task}: under ${targetMs / 1000} s`).toBeLessThan(targetMs);
};
const setClock = async (request: APIRequestContext, iso: string) =>
  expect((await request.post("/v1/ops/clock", { data: { server_time: iso } })).ok()).toBe(true);
const dbClient = async () => {
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  return db;
};

for (const size of SIZES) {
  test.describe(`M2 scenarios on ${size.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
    });

    test(`sam_check_in (${size.name}): at 10:44 Sam O. checks in with 3, billed as 4 with the first-hour minimum`, async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);
      const db = await dbClient();
      try {
        await signInAndy(page, request, db);
        await setClock(request, "2026-09-26T02:44:00Z");
        await page.reload();
        await page
          .getByRole("listitem", { name: "Sam O.", exact: true })
          .getByRole("button", { name: "Check in" })
          .click();
        const sheet = page.getByRole("dialog", { name: "Check in Sam O." });
        await expect(sheet).toContainText("3 guests · Fridays bill at least 4");
        await expect(sheet).toContainText("Deposit applied −$40.00");
        await sheet.getByRole("button", { name: "Check in" }).click();
        await expect(
          page.getByText(/^Room 2 · room code [A-Z2-9]{5} · check #\d{4}$/),
        ).toBeVisible();
        const texted = await db.query<{ body: string }>(
          "select m.body from messages m join message_templates t on t.id = m.template_id where t.key = 'room_code' order by m.created_at desc limit 1",
        );
        expect(texted.rows[0]!.body).toMatch(
          /^Welcome to Room 2\..*room code [A-Z2-9]{5}\. Or open http/,
        );
        const room2 = page.getByRole("listitem", { name: "Room 2", exact: true });
        await expect(room2).toContainText("Room time so far $40.00");
        expect(await clippedText(page)).toEqual([]);
      } finally {
        await db.end();
      }
    });

    test(`sam_no_show (${size.name}): Mark no-show only from 10:45, Room 2 frees, the fourth guest's page offers it`, async ({
      page,
      browser,
      request,
    }) => {
      test.setTimeout(120_000);
      const db = await dbClient();
      try {
        const slug = (await db.query<{ slug: string }>("select slug from venues limit 1")).rows[0]!
          .slug;
        const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
        await guest.goto(`http://localhost:3001/v/${slug}/waitlist`);
        await guest.getByLabel("Your name").fill("Jordan L.");
        await guest.getByLabel("Mobile number").fill("2125550145");
        await guest.getByLabel("How many of you").fill("4");
        await guest.getByRole("button", { name: "Join the waitlist" }).click();
        await expect(guest.getByRole("status")).toHaveText("3 parties ahead");

        await signInAndy(page, request, db);
        const sam = page.getByRole("listitem", { name: "Sam O.", exact: true });
        await expect(sam).toContainText(/No-show from 10:45\s?PM/);
        await expect(sam.getByRole("button", { name: "Mark no-show" })).toHaveCount(0);
        await setClock(request, "2026-09-26T02:45:00Z");
        await page.reload();
        await sam.getByRole("button", { name: "Mark no-show" }).click();
        await expect(page.getByRole("listitem", { name: "Sam O.", exact: true })).toHaveCount(0);
        await expect(page.getByRole("listitem", { name: "Room 2", exact: true })).toContainText(
          "Open",
        );

        await page.getByRole("button", { name: /^Waitlist · \d$/ }).click();
        await page
          .getByRole("complementary", { name: "Waitlist" })
          .getByRole("listitem", { name: "Jordan L." })
          .getByRole("button", { name: "Offer a room" })
          .click();
        await guest.reload();
        await expect(guest.getByRole("status")).toHaveText(
          /^Room 2 is ready · (10:00|9:5\d) to claim it$/,
        );
        await guest.close();
      } finally {
        await db.end();
      }
    });

    test(`offer_room11 (${size.name}): Room 11 held 10 minutes for Amara B., Not delivered · Call, then Seat`, async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);
      const db = await dbClient();
      try {
        await signInAndy(page, request, db);
        const band = page.getByRole("list", { name: "Alerts" });
        await band.getByRole("button", { name: "Offer Room 11 · 10 min to claim" }).click();
        const drawer = page.getByRole("complementary", { name: "Waitlist" });
        const amara = drawer.getByRole("listitem", { name: "Amara B." });
        await expect(amara.getByRole("timer")).toHaveText(/^Room 11 · (10:00|9:\d\d) to claim$/);
        const text = await db.query<{ id: string; body: string }>(
          "select m.id, m.body from messages m join message_templates t on t.id = m.template_id where t.key = 'room_ready' order by m.created_at desc limit 1",
        );
        expect(text.rows[0]!.body).toBe(
          "Your room is ready: Room 11. You have 10 minutes to claim it at the front desk.",
        );
        // The text fails (as Twilio would report it): the row says so, with her number.
        await db.query("update messages set status = 'failed' where id = $1", [text.rows[0]!.id]);
        await page.reload();
        await page.getByRole("button", { name: /^Waitlist · \d$/ }).click();
        await expect(amara).toContainText("Not delivered · Call (347) 555-0177");
        await amara.getByRole("button", { name: "Seat" }).click();
        await amara.getByLabel("IDs checked").fill("7");
        await amara.getByRole("button", { name: "Check in" }).click();
        await expect(drawer.getByRole("listitem", { name: "Amara B." })).toHaveCount(0);
        await expect(page.getByRole("listitem", { name: "Room 11", exact: true })).toContainText(
          "Amara B. · 7",
        );
        expect(await clippedText(page)).toEqual([]);
      } finally {
        await db.end();
      }
    });

    test(`room7_move (${size.name}): Move a room… from Room 7's alert to Room 11 with a new code; Room 7 goes to cleaning`, async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);
      const db = await dbClient();
      try {
        await signInAndy(page, request, db);
        await page
          .getByRole("list", { name: "Alerts" })
          .getByRole("listitem")
          .first()
          .getByRole("button", { name: "Move a room…" })
          .click();
        const sheet = page.getByRole("dialog", { name: "Move Room 7" });
        await expect(sheet.getByRole("button")).toHaveText(["Room 11 · free all night", "Cancel"]);
        await expect(sheet).toContainText("Room 8 · booked next");
        await sheet.getByRole("button", { name: "Room 11 · free all night" }).click();
        await expect(page.getByText(/^Moved to Room 11 · new code [A-Z2-9]{5}$/)).toBeVisible();
        await expect(page.getByRole("listitem", { name: "Room 7", exact: true })).toContainText(
          "Needs a wipe",
        );
        const moved = await db.query(
          "select 1 from venue_events where type = 'session.moved' order by seq desc limit 1",
        );
        expect(moved.rowCount).toBe(1);
        const parks = await db.query<{ name: string }>(
          "select r.name from bookings b join guests g on g.id = b.guest_id join rooms r on r.id = b.room_id where g.name = 'The Parks'",
        );
        expect(parks.rows).toEqual([{ name: "Room 7" }]);
      } finally {
        await db.end();
      }
    });
  });
}

/**
 * A manager's own phone signs in with a 6-digit PIN (a founder's report): the
 * pad waits for all six digits instead of trying the first four.
 */
test("a manager's phone: the PIN pad waits for all 6 digits", async ({ page, request }) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    const v = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    await db.query(
      "delete from auth_credentials where user_id = (select id from users where email = $1)",
      [ANDY],
    );
    await db.query("update memberships set locale = 'en'");
    const token = randomBytes(32).toString("base64url");
    await db.query(
      `insert into invites (venue_id, membership_id, token_hash, expires_at)
         select m.venue_id, m.id, $2, now() + interval '2 days'
           from memberships m join users u on u.id = m.user_id where m.venue_id = $1 and u.email = $3`,
      [v, createHash("sha256").update(token).digest("hex"), ANDY],
    );
    await page.setViewportSize({ width: 390, height: 844 });
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
    await page.goto(`/invite/${token}`);
    await page.getByLabel("Your mobile number").fill("+12125550166");
    await page.getByRole("button", { name: "Text me a code" }).click();
    await expect(page.getByText("We texted a code to +12125550166")).toBeVisible();
    const code = await db.query<{ payload: { data: { code: string } } }>(
      "select payload from jobs where kind = 'text.send' and payload->>'to' = $1 order by created_at desc limit 1",
      ["+12125550166"],
    );
    await page.getByLabel("The code from the text").fill(code.rows[0]!.payload.data.code);
    await page.getByRole("button", { name: "Confirm" }).click();
    await page.getByLabel("Choose your PIN", { exact: true }).fill("502330");
    await page.getByLabel("Type it again").fill("502330");
    await page.getByRole("button", { name: "Set my PIN" }).click();
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(page.getByText("You're set · sign in with your passkey")).toBeVisible();
    // A new session on this phone: its owner's PIN, all six digits.
    await page.context().clearCookies();
    await page.goto("/sign-in");
    await expect(page.getByText("Your PIN")).toBeVisible();
    await typePin(page, "5023");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await typePin(page, "30");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    void request;
  } finally {
    await db.end();
  }
});

/**
 * Admin → Menu (M3-04): the seed's menu with a Button name and an Alcohol
 * column, Margarita's button renamed to "Marg" while its full name stays, a
 * Friday happy hour refused at $6.00 with its reason and saved at $6.50,
 * Bud Light hidden off the guest menu, and with Packages & specials off,
 * no packages or happy hours in Admin.
 */
test("Admin → Menu: button names, a refused $6.00 happy hour, $6.50 saved, a hidden item, and Packages off", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    await page.goto("/admin/menu");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Menu");
    const rows = page.locator(".menu-category tbody tr");
    await expect(rows).toHaveCount(127);
    await expect(page.getByRole("columnheader", { name: "Button name" }).first()).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Alcohol" }).first()).toBeVisible();
    const row = (name: string) => page.getByRole("row", { name: new RegExp(`^${name} `) });
    await expect(row("Margarita")).toContainText("$13.00");
    await expect(row("Margarita")).toContainText("Alcohol");
    await expect(row("Hoegaarden")).toContainText("86'd tonight");
    expect(await clippedText(page)).toEqual([]);

    // Margarita's button becomes "Marg"; its full name stays for tickets and receipts.
    await page.getByRole("button", { name: "Edit · Margarita" }).click();
    const editor = page.locator(".menu-editor");
    await editor.getByLabel("Button name").fill("Marg");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Margarita saved")).toBeVisible();
    await expect(row("Margarita")).toContainText("Marg");
    const marg = await db.query<{ name: string; button_name: string }>(
      "select name, button_name from menu_items where name = 'Margarita'",
    );
    expect(marg.rows[0]).toEqual({ name: "Margarita", button_name: "Marg" });

    // A Friday happy hour from 8 PM: $6.00 is refused with its reason, $6.50 saves.
    const ruleForm = page.locator("form", {
      has: page.getByRole("heading", { name: "Add a happy hour or special" }),
    });
    await ruleForm.getByLabel("Name", { exact: true }).fill("Friday happy hour");
    await ruleForm.getByLabel("Item", { exact: true }).selectOption({ label: "Margarita" });
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Sat", "Sun"])
      await ruleForm.getByLabel(day, { exact: true }).uncheck();
    await ruleForm.getByLabel("From", { exact: true }).fill("20:00");
    await ruleForm.getByLabel("Price ($)").fill("6.00");
    await ruleForm.getByRole("button", { name: "Save the happy hour or special" }).click();
    await expect(page.getByRole("alert")).toContainText("the lowest allowed is $6.50");
    expect((await db.query("select count(*)::int as n from price_rules")).rows[0].n).toBe(0);
    await ruleForm.getByLabel("Price ($)").fill("6.50");
    await ruleForm.getByRole("button", { name: "Save the happy hour or special" }).click();
    await expect(page.getByText("Friday happy hour saved")).toBeVisible();
    await expect(page.locator(".rules-table")).toContainText("Fri · 20:00");
    await expect(page.locator(".rules-table")).toContainText("$6.50");

    // Hiding Bud Light takes it off the guest menu after Save.
    await page.getByRole("button", { name: "Edit · Bud Light" }).click();
    await page.locator(".menu-editor").getByLabel("Shown on the menus").uncheck();
    await page.locator(".menu-editor").getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Bud Light saved")).toBeVisible();
    await expect(row("Bud Light")).toContainText("Hidden");
    const guest = await request.get("http://127.0.0.1:3000/v1/public/venues/west4karaoke/menu");
    const names = (
      (await guest.json()) as { categories: { items: { name: string }[] }[] }
    ).categories.flatMap((c) => c.items.map((i) => i.name));
    expect(names).toContain("Margarita");
    expect(names).not.toContain("Bud Light");

    // With Packages & specials off, Admin shows no packages or happy hours.
    await expect(page.getByRole("heading", { name: "Packages", exact: true })).toBeVisible();
    await db.query("update venue_modules set state = 'off' where module_id = 'packages'");
    await page.reload();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Menu");
    await expect(rows).toHaveCount(127);
    await expect(page.getByRole("heading", { name: "Packages", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Happy hours and specials" })).toHaveCount(0);
  } finally {
    await db.query("update venue_modules set state = 'on' where module_id = 'packages'");
    await db.end();
  }
});

/**
 * Adding drinks to a room (M3-07). Maya, signed in on the bar computer,
 * opens Room 9's tab: 2 × Margarita stays amber until she picks Peach and
 * Send names the missing flavor; Hoegaarden is 86'd tonight and can't be
 * added. Her unsent drinks survive a reload, show on the Room phone layout,
 * and never touch the check. Send puts them on Room 9's check at once with
 * a ticket, and the order shows Being made.
 */
test("Adding drinks to Room 9: an amber Margarita until Peach, Hoegaarden 86'd, unsent drinks kept, then Send", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page
      .getByLabel("Pairing code from Admin → Devices")
      .fill(await pairingCode(db, "bar_computer", "Bar computer"));
    expect(
      (
        await page.request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })
      ).ok(),
    ).toBe(true);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.getByRole("button", { name: /Maya S\./ }).click();
    await typePin(page, "4071");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");

    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room 9");
    const drinks = page.getByRole("region", { name: "Add drinks" });
    const tab = page.getByRole("region", { name: "Running tab" });
    await expect(tab).toContainText("Drinks$158.00");

    // Two taps make two; the flavor has no default, so the line is amber and Send names it.
    await drinks.getByLabel("Search the menu").fill("Marg");
    await drinks.getByRole("button", { name: "Margarita · $13.00" }).click();
    await expect(drinks.locator(".unsent-line")).toContainText("1 × Margarita");
    await drinks.getByRole("button", { name: "Margarita · $13.00" }).click();
    await expect(drinks.locator(".unsent-line")).toContainText("2 × Margarita");
    await expect(drinks.locator(".unsent-line.amber")).toHaveCount(1);
    const send = drinks.locator("button.send");
    await expect(send).toHaveText("Pick flavor for Margarita");
    await expect(send).toBeDisabled();

    // Hoegaarden is 86'd tonight and can't be added.
    await drinks.getByLabel("Search the menu").fill("Hoe");
    const hoe = drinks.getByRole("button", { name: "Hoegaarden · 86'd tonight" });
    await expect(hoe).toBeDisabled();
    await expect(hoe).toContainText("86'd tonight");

    // Unsent drinks survive a reload and never touch the check.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room 9");
    await expect(drinks.locator(".unsent-line")).toContainText("2 × Margarita");
    await expect(tab).toContainText("Drinks$158.00");

    // They show on the Room phone layout too.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room 9");
    await expect(drinks.locator(".unsent-line")).toContainText("2 × Margarita");
    expect(await clippedText(page)).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Peach, then Send: on the check at once, a ticket, and Being made.
    await drinks.getByLabel("Margarita · Flavor").selectOption({ label: "Peach" });
    await expect(drinks.locator(".unsent-line.amber")).toHaveCount(0);
    await expect(send).toHaveText("Send 2 to the bar");
    await send.click();
    await expect(drinks.getByRole("status")).toHaveText(
      "Sent · on the tab, ticket printing at the bar",
    );
    await expect(tab).toContainText("2 × Margarita · Peach$26.00");
    await expect(tab).toContainText("Drinks$184.00");
    await expect(drinks.locator(".room-orders")).toContainText(
      "2 × Margarita · Peach · Being made",
    );
    const ticket = await db.query<{ n: number }>(
      `select count(*)::int as n from print_jobs p join orders o on o.id = p.order_id
        where o.source = 'staff' and p.kind = 'ticket'`,
    );
    expect(ticket.rows[0]!.n).toBe(1);
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * A ticket that didn't print (M3-13): with the bar printer unplugged, o4's
 * ticket for Room 1 fails and the board reads "Room 1 · Ticket didn't print"
 * with Reprint; the reprint is REPRINT 2, and when that fails too, REPRINT 3.
 */
test("Ticket didn't print: the board's Reprint makes REPRINT 2, then REPRINT 3", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    // The print watch's verdict on o4's ticket, as it gives it after three polls with no printer.
    const fail = (where: string) =>
      db.query(
        `update print_jobs set status = 'failed', failed_at = '2026-09-25T22:41:00-04:00', confirmed_at = null ${where}`,
      );
    await fail("where order_id = (select row_id from seed_ids where slug = 'order_o4')");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    const alert = page.locator(".alert", { hasText: "Room 1 · Ticket didn't print" });
    await expect(alert).toBeVisible();
    await alert.getByRole("button", { name: "Reprint" }).click();
    await expect(alert).toHaveCount(0);
    const reprints = async () =>
      (
        await db.query<{ n: number }>(
          "select reprint_n as n from print_jobs where reprint_of is not null order by reprint_n",
        )
      ).rows.map((r) => r.n);
    expect(await reprints()).toEqual([2]);

    await fail("where reprint_n = 2");
    await page.reload();
    await expect(alert).toBeVisible();
    await alert.getByRole("button", { name: "Reprint" }).click();
    await expect(alert).toHaveCount(0);
    expect(await reprints()).toEqual([2, 3]);
  } finally {
    await db.end();
  }
});

/**
 * The bar orders screen (M3-15) on the bar computer, from the seed at 10:41
 * PM, at 900 × 640 and 1280 × 800: o1 and o2 ringing under Waiting for you
 * (o2 amber), o3 and o4 ready for a runner with o4's ID line; Maya's Accept on
 * o1 stamps her name and moves it to Being made, its ticket printed once the
 * printer confirms; nothing offers Ready on an order that isn't accepted; and
 * with Bar screen & tickets off, the screen and its menu entry are gone.
 */
for (const size of [
  { width: 900, height: 640 },
  { width: 1280, height: 800 },
]) {
  test(`the bar orders screen at ${size.width} × ${size.height}: the seed's orders, Accept as Maya, and the module off`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const db = new pg.Client({
      connectionString:
        process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
    });
    await db.connect();
    try {
      await db.query("update memberships set locale = 'en'");
      await page.setViewportSize(size);
      await page.goto("/sign-in");
      await page.getByRole("button", { name: "Pair this screen" }).click();
      await page
        .getByLabel("Pairing code from Admin → Devices")
        .fill(await pairingCode(db, "bar_computer", "Bar computer"));
      expect(
        (
          await page.request.post("/v1/ops/clock", {
            data: { server_time: "2026-09-26T02:41:00Z" },
          })
        ).ok(),
      ).toBe(true);
      await page.getByRole("button", { name: "Pair", exact: true }).click();
      await page.getByRole("button", { name: /Maya S\./ }).click();
      await typePin(page, "4071");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");
      await page.goto("/bar-orders");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar orders");

      const column = (name: string) => page.getByRole("region", { name });
      const waiting = column("Waiting for you");
      const o1 = waiting.locator(".bar-order", { hasText: "Room 9" });
      const o2 = waiting.locator(".bar-order", { hasText: "Room 5" });
      await expect(o1).toContainText(/Ringing · 0:4\d/);
      await expect(o2).toContainText(/Ringing · 2:1\d/);
      await expect(o2).toHaveClass(/amber/);
      await expect(o2).toContainText("Leo M. · 4");
      await expect(o2).toContainText("ID ✓ 4 of 4");
      const ready = column("Ready for a runner");
      await expect(ready.locator(".bar-order", { hasText: "Room 3" })).toContainText(
        /Ready for a runner · 4:0\d/,
      );
      const o4 = ready.locator(".bar-order", { hasText: "Room 1" });
      await expect(o4).toContainText(/Ready for a runner · 1:[34]\d/);
      await expect(o4).toContainText("ID ✓ 3 of 4 · the runner checks the last ID");
      await expect(page.getByText("Ages on screen: amber at 2 min, pink at 4")).toBeVisible();
      // Nothing waiting offers Ready or Delivered.
      await expect(waiting.getByRole("button", { name: /^(Ready|Delivered)$/ })).toHaveCount(0);
      expect(await clippedText(page)).toEqual([]);

      await o1.getByRole("button", { name: "Accept · print ticket" }).click();
      const making = column("Being made").locator(".bar-order", { hasText: "Room 9" });
      await expect(making).toContainText(
        /Accepted by Maya S\. · 10:4\d · on Room 9's tab · ticket printing/,
      );
      // The bar printer confirms the ticket.
      await db.query(
        "update print_jobs set status = 'printed', confirmed_at = now() where order_id = (select row_id from seed_ids where slug = 'order_o1')",
      );
      await page.reload();
      await expect(making).toContainText("ticket printed");

      await db.query("update venue_modules set state = 'off' where module_id = 'bar_screen'");
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Bar orders");
      await expect(page.getByRole("link", { name: "Bar orders" })).toHaveCount(0);
    } finally {
      await db.query("update venue_modules set state = 'on' where module_id = 'bar_screen'");
      await db.end();
    }
  });
}

/**
 * The board's count and the chime's Mute (M3-16): at 10:41 PM the side menu
 * reads "Bar orders · 2" (o1 and o2); on the bar orders screen, Mute silences
 * the chime for 60 seconds while the colors keep changing.
 */
test("Bar orders · 2 in the side menu, and Mute for 60 seconds on the bar orders screen", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ANDY);
    await page.getByLabel("Email").fill(ANDY);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    const link = page.getByRole("link", { name: "Bar orders · 2" });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar orders");
    await page.getByRole("button", { name: "Mute the chime for 60 s" }).click();
    await expect(
      page.getByRole("button", { name: /^Chime muted · back in (60|59|58) s$/ }),
    ).toBeDisabled();
    // The colors keep going while it's muted.
    await expect(
      page.getByRole("region", { name: "Waiting for you" }).locator(".bar-order.amber"),
    ).toHaveCount(1);
  } finally {
    await db.end();
  }
});

/**
 * A locked bar computer (M3-16): with nobody signed in, the orders waiting at
 * the bar still show on its sign-in screen, and a new one adds to them.
 */
test("a locked bar computer still shows the orders waiting at the bar", async ({ page }) => {
  test.setTimeout(120_000);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page
      .getByLabel("Pairing code from Admin → Devices")
      .fill(await pairingCode(db, "bar_computer", "Bar computer"));
    expect(
      (
        await page.request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })
      ).ok(),
    ).toBe(true);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");
    await expect(page.getByText("Bar orders · 2 waiting")).toBeVisible();
    // A guest's order rings while the screen is locked.
    await db.query(
      `insert into orders (venue_id, check_id, session_id, source, placed_at, business_date)
       select s.venue_id, s.check_id, s.id, 'room', '2026-09-25T22:41:00-04:00', '2026-09-25'
         from room_sessions s where s.id = (select row_id from seed_ids where slug = 'sess_room9')`,
    );
    await expect(page.getByText("Bar orders · 3 waiting")).toBeVisible({ timeout: 15_000 });
  } finally {
    await db.end();
  }
});

/**
 * Runs on Andy's phone (M3-18): I've got it on o3 reads "On its way · Andy
 * C.", Delivered at 10:52 PM takes it off and adds nothing to Room 3's check;
 * o4 sent back with "Someone looks too drunk" shows under Returned tonight
 * with "Cut off Room 1?", which only someone who may cut off is offered; and
 * Room 1's last ID is recorded from the run.
 */
test("Runs on a phone: I've got it, Delivered at 10:52, a too-drunk return offering Cut off Room 1?, and an ID", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await setClock(request, "2026-09-26T02:41:00Z");
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndy(page, request, db);
    await page.goto("/runs");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Runs");
    const o3 = page.locator(".run", { hasText: "Room 3" });
    const o4 = page.locator(".run", { hasText: "Room 1" });
    await expect(o3).toContainText(/Ready for a runner · 4:\d\d/);
    await expect(o4).toContainText("ID ✓ 3 of 4 · the runner checks the last ID");
    expect(await clippedText(page)).toEqual([]);

    await o3.getByRole("button", { name: "I've got it" }).click();
    await expect(o3).toContainText("On its way · Andy C.");
    const lines = async () =>
      (
        await db.query<{ n: number }>(
          "select coalesce(sum(amount_cents), 0)::int as n from check_lines where check_id = (select row_id from seed_ids where slug = 'chk_room3')",
        )
      ).rows[0]!.n;
    const before = await lines();
    await setClock(request, "2026-09-26T02:52:00Z");
    await o3.getByRole("button", { name: "Delivered" }).click();
    await expect(o3).toHaveCount(0);
    const delivered = await db.query<{ at: string }>(
      "select to_char(delivered_at at time zone 'America/New_York', 'HH24:MI') as at from orders where id = (select row_id from seed_ids where slug = 'order_o3')",
    );
    expect(delivered.rows[0]!.at).toBe("22:52");
    expect(await lines()).toBe(before);

    // Room 1's last ID, checked at the room.
    await o4.getByRole("button", { name: "Record an ID checked here" }).click();
    await expect(o4).toContainText("ID ✓ 4 of 4");

    await o4.getByRole("button", { name: "Couldn't serve…" }).click();
    await o4
      .getByLabel("Why couldn't you serve it?")
      .selectOption({ label: "Someone looks too drunk" });
    await o4.getByRole("button", { name: "Send it back to the bar" }).click();
    const back = page.getByRole("region", { name: "Returned tonight" });
    await expect(back).toContainText("Couldn't serve: Someone looks too drunk · Andy C.");
    await expect(back.getByRole("link", { name: "Cut off Room 1?" })).toBeVisible();
    const refusals = await db.query<{ n: number }>(
      "select count(*)::int as n from alcohol_refusals where reason = 'too_drunk'",
    );
    expect(refusals.rows[0]!.n).toBe(1);
  } finally {
    await db.end();
  }
});

/**
 * The fix panel across two screens (M3-19): Maya's panel reads "$63.00 left
 * this shift" on DeskRoom and on the Room phone layout alike, from her $12.00
 * comp tonight; she comps one $13.00 Margarita on Room 9 with a reason, no
 * approval, and both read "$50.00 left this shift".
 */
test("the fix panel: $63.00 left on both screens, a $13.00 comp with a reason, then $50.00 left", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page
      .getByLabel("Pairing code from Admin → Devices")
      .fill(await pairingCode(db, "bar_computer", "Bar computer"));
    expect(
      (
        await page.request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })
      ).ok(),
    ).toBe(true);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.getByRole("button", { name: /Maya S\./ }).click();
    await typePin(page, "4071");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");
    // o1 accepted at the bar: 2 × Margarita · Peach on Room 9.
    await page.goto("/bar-orders");
    await page
      .getByRole("region", { name: "Waiting for you" })
      .locator(".bar-order", { hasText: "Room 9" })
      .getByRole("button", { name: "Accept · print ticket" })
      .click();
    await expect(page.getByRole("region", { name: "Being made" })).toContainText("Room 9");

    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    const fix = page.getByRole("region", { name: "Fix a sent drink" });
    await expect(fix).toContainText("$63.00 left this shift");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(fix).toContainText("$63.00 left this shift");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();

    await fix.getByRole("button", { name: "Fix · Margarita · Peach" }).click();
    await fix.getByLabel("How many").fill("1");
    await fix.getByLabel("Reason", { exact: true }).fill("Spilled on the way");
    await fix.getByRole("button", { name: "COMP · the house pays for it" }).click();
    await expect(fix.getByRole("status")).toHaveText("Comped: Margarita · Peach");
    await expect(fix).toContainText("$50.00 left this shift");
    await expect(page.getByRole("region", { name: "Running tab" })).toContainText(
      "COMP · Margarita · Peach-$13.00",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(fix).toContainText("$50.00 left this shift");
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/** The alcohol window on DeskRoom (M3-20): at 4:00 AM alcohol is greyed with the reason in words. */
test("at 4:00 AM DeskRoom greys alcohol with the reason; a Red Bull still adds", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    // Signed in at 4:00 AM itself: moving the clock five hours on would end a session as idle.
    await setClock(request, "2026-09-26T08:00:30Z");
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    const drinks = page.getByRole("region", { name: "Add drinks" });
    await drinks.getByLabel("Search the menu").fill("Bud");
    const bud = drinks.getByRole("button", {
      name: "Bud Light · No alcohol now · the window has closed",
    });
    await expect(bud).toBeDisabled();
    await drinks.getByLabel("Search the menu").fill("Red Bull");
    await expect(drinks.getByRole("button", { name: "Red Bull · $6.00" })).toBeEnabled();
  } finally {
    await db.end();
  }
});

/**
 * Cutting off Room 9 (M3-21) from the board's tile panel at 10:41 PM: the
 * board, DeskRoom and the Room phone read "Cut off by Andy at 10:41 PM", o1
 * shows "Cancelled · cut off by Andy" under Returned on the bar orders screen,
 * and the guest's phone hides alcohol with the glossary's words.
 */
test("Cut off Room 9 from the board: every screen reads it, o1 is cancelled, the guest's phone pauses alcohol", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await setClock(request, "2026-09-26T02:41:00Z");
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    const tile = page.getByRole("listitem", { name: "Room 9", exact: true });
    await tile.getByRole("button", { name: "No more alcohol for this room" }).click();
    const sheet = page.getByRole("dialog", { name: "No more alcohol for this room" });
    await sheet.getByLabel("Why is Room 9 cut off?").fill("Someone looks too drunk");
    await sheet.getByRole("button", { name: "Cut off", exact: true }).click();
    await expect(tile).toContainText(/Cut off by Andy at 10:4\d PM/);

    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await expect(page.getByText(/Cut off by Andy at 10:4\d PM/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByText(/Cut off by Andy at 10:4\d PM/)).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto("/bar-orders");
    await expect(
      page.getByRole("region", { name: "Returned" }).locator(".bar-order", { hasText: "Room 9" }),
    ).toContainText("Cancelled · cut off by Andy");

    const token = createHash("sha256")
      .update("host-token:sess_room9")
      .digest("base64url")
      .slice(0, 32);
    const phone = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    await phone.goto(`http://localhost:3001/r/${token}`);
    await expect(
      phone.getByText("Your server has paused alcohol for this room").first(),
    ).toBeVisible();
    await expect(phone.getByRole("button", { name: /^Bud Light/ })).toHaveCount(0);
    await phone.context().close();
  } finally {
    await db.end();
  }
});

/**
 * The bar orders screen after the 4:00 AM stop (M3-22): an order the stop
 * cancelled reads "Cancelled at 4:00 AM" under Returned, and an alcohol order
 * still waiting offers no Decline.
 */
test("after 4:00 AM the bar orders screen lists Cancelled at 4:00 AM and offers no Decline", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page
      .getByLabel("Pairing code from Admin → Devices")
      .fill(await pairingCode(db, "bar_computer", "Bar computer"));
    expect(
      (
        await page.request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T08:00:30Z" } })
      ).ok(),
    ).toBe(true);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.getByRole("button", { name: /Maya S\./ }).click();
    await typePin(page, "4071");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");
    // The stop has cancelled o1 (the worker's sweep, which the smoke run doesn't start); o2 still waits.
    await db.query(
      `update orders set status = 'cancelled', cancel_reason = 'alcohol_closed', cancelled_at = '2026-09-26T04:00:00-04:00'
        where id = (select row_id from seed_ids where slug = 'order_o1')`,
    );
    await page.goto("/bar-orders");
    await expect(
      page.getByRole("region", { name: "Returned" }).locator(".bar-order", { hasText: "Room 9" }),
    ).toContainText("Cancelled at 4:00 AM");
    const o2 = page
      .getByRole("region", { name: "Waiting for you" })
      .locator(".bar-order", { hasText: "Room 5" });
    await expect(o2).toBeVisible();
    await expect(o2.getByRole("button", { name: "Decline…" })).toHaveCount(0);
  } finally {
    await db.end();
  }
});

/**
 * The seed's M3 scenarios (M3-25), each from a fresh load of the demo seed.
 * The rest of them run above: runner_o3 in "Runs on a phone", reason_only in
 * "the fix panel", and the room-order half of alcohol_stop in "after 4:00 AM
 * the bar orders screen".
 */
test.describe("M3 scenarios", () => {
  const hostLink = (slug: string) =>
    `http://localhost:3001/r/${createHash("sha256").update(`host-token:${slug}`).digest("base64url").slice(0, 32)}`;
  const phone = async (browser: Browser) =>
    (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const seedRow = async (db: pg.Client, slug: string) =>
    (await db.query<{ id: string }>("select row_id as id from seed_ids where slug = $1", [slug]))
      .rows[0]!.id;

  test("accept_o1: Room 9's 2 × Margarita · Peach joins the tab at Accept, prints, and the phone reads Being made", async ({
    page,
    browser,
    request,
  }) => {
    test.setTimeout(150_000);
    const db = await dbClient();
    try {
      await setClock(request, "2026-09-26T02:41:00Z");
      const marcus = await phone(browser);
      await marcus.goto(hostLink("sess_room9"));
      const bill = marcus.getByRole("region", { name: "Tonight so far" });
      await expect(bill).toContainText("Drinks on your tab$158.00");
      await expect(bill).toContainText("Tab so far$480.00");
      const o1 = marcus.locator(".order", { hasText: "2 × Margarita · Peach" });
      await expect(o1.locator(".status")).toHaveText("Sent to the bar · you can still cancel");

      await page.setViewportSize({ width: 1280, height: 800 });
      await signInAndy(page, request, db);
      await page.getByRole("link", { name: "Bar orders · 2" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar orders");
      await page
        .getByRole("region", { name: "Waiting for you" })
        .locator(".bar-order", { hasText: "Room 9" })
        .getByRole("button", { name: "Accept · print ticket" })
        .click();
      await expect(
        page
          .getByRole("region", { name: "Being made" })
          .locator(".bar-order", { hasText: "Room 9" }),
      ).toContainText(/Accepted by Andy C\. · 10:4\d · on Room 9's tab · ticket printing/);
      await expect(page.getByRole("link", { name: "Bar orders · 1" })).toBeVisible({
        timeout: 15_000,
      });
      const tickets = await db.query<{ n: number }>(
        "select count(*)::int as n from print_jobs where order_id = $1",
        [await seedRow(db, "order_o1")],
      );
      expect(tickets.rows[0]!.n).toBe(1);

      await expect(o1.locator(".status")).toHaveText("Being made · on your tab", {
        timeout: 15_000,
      });
      await marcus.reload();
      await expect(bill).toContainText("Drinks on your tab$184.00");
      await expect(bill).toContainText("Tab so far$506.00");
      await marcus.context().close();
    } finally {
      await db.end();
    }
  });

  test("ask_room5_wait and accept_o2: Asked to wait keeps aging at 2, then Accept puts $32.00 on Room 5's tab", async ({
    page,
    browser,
    request,
  }) => {
    test.setTimeout(150_000);
    const db = await dbClient();
    try {
      await setClock(request, "2026-09-26T02:41:00Z");
      const leo = await phone(browser);
      await leo.goto(hostLink("sess_room5"));
      const bill = leo.getByRole("region", { name: "Tonight so far" });
      await expect(bill).toContainText("Tab so far$40.00");
      const o2 = leo.locator(".order", { hasText: "4 × Bud Light" });

      await page.setViewportSize({ width: 1280, height: 800 });
      await signInAndy(page, request, db);
      await page.goto("/bar-orders");
      const waiting = page.getByRole("region", { name: "Waiting for you" });
      const card = waiting.locator(".bar-order", { hasText: "Room 5" });
      await card.getByRole("button", { name: "Ask the room to wait" }).click();
      await expect(card).toContainText(/Asked to wait · 2:\d\d/);
      await expect(page.getByRole("link", { name: "Bar orders · 2" })).toBeVisible();
      await expect(waiting.getByRole("button", { name: /^(Ready|Delivered)$/ })).toHaveCount(0);
      await expect(o2.locator(".status")).toHaveText("The bar needs a few minutes", {
        timeout: 15_000,
      });

      await card.getByRole("button", { name: "Accept · print ticket" }).click();
      await expect(
        page
          .getByRole("region", { name: "Being made" })
          .locator(".bar-order", { hasText: "Room 5" }),
      ).toContainText(/Accepted by Andy C\./);
      await leo.reload();
      await expect(bill).toContainText("Tab so far$72.00");
      await leo.context().close();

      await page.goto("/tonight");
      await expect(page.getByRole("listitem", { name: "Room 5", exact: true })).toContainText(
        "ID ✓ 4 of 4",
      );
    } finally {
      await db.end();
    }
  });

  test("runner_returns_o4: No ID for someone who ordered, back at the bar, and the $36.00 void waits for approval", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const db = await dbClient();
    try {
      await setClock(request, "2026-09-26T02:41:00Z");
      await page.setViewportSize({ width: 390, height: 844 });
      await signInAndy(page, request, db);
      await page.goto("/runs");
      const o4 = page.locator(".run", { hasText: "Room 1" });
      await o4.getByRole("button", { name: "Couldn't serve…" }).click();
      await o4
        .getByLabel("Why couldn't you serve it?")
        .selectOption({ label: "No ID for someone who ordered" });
      await o4.getByRole("button", { name: "Send it back to the bar" }).click();
      await expect(page.getByRole("region", { name: "Returned tonight" })).toContainText(
        "Couldn't serve: No ID for someone who ordered · Andy C.",
      );

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/bar-orders");
      const back = page
        .getByRole("region", { name: "Returned" })
        .locator(".bar-order", { hasText: "Room 1" });
      await expect(back).toContainText("Couldn't serve: No ID for someone who ordered · Andy C.");
      await expect(back.getByRole("button", { name: "Void · made (waste)" })).toBeVisible();
      await expect(back.getByRole("button", { name: "Remake" })).toBeVisible();
      await back.getByRole("button", { name: "Void · not made" }).click();
      // $36.00 is over the $25.00 reason-only limit; Andy's own request goes to Abhishek.
      await expect(back.getByRole("status")).toHaveText("Waiting for Abhishek G.");
      await expect(back.getByRole("button", { name: "Void · not made" })).toHaveCount(0);
      const voids = await db.query<{ n: number }>(
        "select count(*)::int as n from check_lines where check_id = $1 and kind = 'void'",
        [await seedRow(db, "chk_room1")],
      );
      expect(voids.rows[0]!.n).toBe(0);
      const asked = await db.query<{ amount_cents: string }>(
        "select amount_cents::text from approvals where target_kind = 'order' and target_id = $1 and status = 'pending'",
        [await seedRow(db, "order_o4")],
      );
      expect(asked.rows).toEqual([{ amount_cents: "3600" }]);
    } finally {
      await db.end();
    }
  });

  test("andy_approves_void: Approvals · 1 on Andy's phone, and Tariq A.'s drinks go from $79.00 to $9.00", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const db = await dbClient();
    try {
      await setClock(request, "2026-09-26T02:41:00Z");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(() => {
        const fake = {
          endpoint: "https://push.example.test/send/andy-void",
          toJSON: () => ({
            endpoint: "https://push.example.test/send/andy-void",
            keys: { p256dh: "fake-p256dh", auth: "fake-auth" },
          }),
          unsubscribe: async () => true,
        };
        let subscribed = false;
        PushManager.prototype.subscribe = async () => {
          subscribed = true;
          return fake as unknown as PushSubscription;
        };
        PushManager.prototype.getSubscription = async () =>
          (subscribed ? fake : null) as unknown as PushSubscription;
        Object.defineProperty(Notification, "permission", { get: () => "default" });
        Notification.requestPermission = async () => "granted";
      });
      await signInAndy(page, request, db);
      await page.goto("/setup");
      await page.getByRole("button", { name: "Turn on alerts" }).click();
      await expect(page.getByRole("status")).toHaveText("Alerts are on");

      const tariq = await seedRow(db, "chk_t5");
      const drinks = async () =>
        (
          await db.query<{ n: number }>(
            "select coalesce(sum(amount_cents), 0)::int as n from check_lines where check_id = $1 and tax_category = 'drink'",
            [tariq],
          )
        ).rows[0]!.n;
      expect(await drinks()).toBe(7900);

      await page.goto("/tonight");
      await page.getByRole("link", { name: "Approvals" }).last().click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Approvals · 1");
      await expect(page.getByText("Void · Large bucket · 10 beers")).toBeVisible();
      await expect(page.getByText("$70.00")).toBeVisible();
      await expect(page.getByText("Reason: rang it wrong")).toBeVisible();
      await expect(page.getByText(/Diego R\. asked at 10:39\s?PM/)).toBeVisible();
      await page.getByRole("button", { name: "Approve" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Approvals · 0");

      const line = await db.query<{ amount_cents: string; approved_by: string; added_by: string }>(
        "select amount_cents::text, approved_by, added_by from check_lines where check_id = $1 and kind = 'void'",
        [tariq],
      );
      expect(line.rows).toEqual([
        {
          amount_cents: "-7000",
          approved_by: await seedRow(db, "andy"),
          added_by: await seedRow(db, "diego"),
        },
      ]);
      expect(await drinks()).toBe(900);
    } finally {
      await db.end();
    }
  });
});

/**
 * Admin → Payments (M4-01, N37), the owner's alone. With West 4's account
 * made (the ops command's job, done here against the fake Stripe), it reads
 * what Stripe still needs; Connect with Stripe opens Stripe's onboarding and
 * comes back with card payments on. Connections lists Stripe, Twilio and email.
 */
test("Admin → Payments: Stripe needs more information, Connect with Stripe, then card payments are on", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    const made = await request.post("http://127.0.0.1:12111/v2/core/accounts", {
      headers: {
        authorization: "Bearer rk_test_fake_payments",
        "idempotency-key": `e2e-${Date.now()}`,
      },
      data: { display_name: "West 4 Boho Karaoke", contact_email: ABHISHEK },
    });
    const accountId = ((await made.json()) as { id: string }).id;
    await db.query("update organizations set stripe_account_id = $1", [accountId]);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    await page.goto("/admin/payments");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Payments");
    const banner = page.getByRole("alert");
    await expect(banner).toContainText("Stripe needs more information");
    await expect(banner).toContainText("2 things left to finish in Stripe's setup");
    await expect(page.getByText("Card payments aren't on yet")).toBeVisible();
    await expect(page.getByText("No payouts yet")).toBeVisible();
    await page.getByRole("button", { name: "Connect with Stripe" }).click();
    await expect(page).toHaveURL(/\/admin\/payments\?onboarded=1$/);
    await expect(page.getByText("Card payments are on")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open the Stripe Dashboard" })).toBeVisible();
    expect(await clippedText(page)).toEqual([]);

    await page.goto("/admin/connections");
    await expect(page.getByRole("listitem", { name: "Stripe · card payments" })).toContainText(
      "Connected",
    );
    await expect(page.getByRole("listitem", { name: "Twilio · texts" })).toBeVisible();
    await expect(page.getByRole("listitem", { name: "Email" })).toBeVisible();
  } finally {
    await db.end();
  }
});

/**
 * The router on Admin → Printers & devices (M8-02): at 10:41 PM the seed's
 * router reads "Backup internet · on" on the wired line, the Board shows no
 * banner, and the monthly failover test is due until a result is kept.
 */
test("Admin → Printers & devices: the router's backup internet and its monthly failover test", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await expect(page.getByTestId("banner-backup")).toHaveCount(0);
    await page.goto("/admin/devices");
    const router = page.getByRole("region", { name: "Router" });
    await expect(router).toContainText("Backup internet · on · On the wired line");
    await expect(router).toContainText("Failover test due");
    await expect(router).toContainText("Never tested");
    await router.getByLabel("Seconds to switch").fill("42");
    await router.getByRole("button", { name: "Keep the result" }).click();
    await expect(router).toContainText("Sep 25, 2026 · Passed · switched in 42 s");
    await expect(router).toContainText("Next test due Oct 25, 2026");
    await expect(router).not.toContainText("Failover test due");
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * Card readers on Admin → Printers & devices (M4-02): the seed's two S710s
 * wait to be registered; registering the Bar S710 with the code it shows
 * makes it an S710 with cellular at $10.00 a month.
 */
test("Admin → Printers & devices: register the Bar S710 with its code", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    const made = await request.post("http://127.0.0.1:12111/v2/core/accounts", {
      headers: {
        authorization: "Bearer rk_test_fake_payments",
        "idempotency-key": `e2e-r-${Date.now()}`,
      },
      data: { display_name: "West 4 Boho Karaoke" },
    });
    await db.query("update organizations set stripe_account_id = $1", [
      ((await made.json()) as { id: string }).id,
    ]);
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await page.goto("/admin/devices");
    const readers = page.getByRole("region", { name: "Card readers" });
    const bar = readers.getByRole("listitem", { name: "Bar S710" });
    await expect(bar).toContainText("Not registered with Stripe yet");
    await expect(readers).toContainText("Only the S710 has cellular backup");
    await readers.getByLabel("Name staff pick").fill("Bar S710");
    await readers.getByLabel("Registration code").fill("simulated-s710");
    await readers.getByRole("button", { name: "Register" }).click();
    await expect(readers.getByRole("status")).toHaveText("Bar S710 is registered");
    await expect(bar).toContainText("S710");
    await expect(bar).toContainText("Cellular on · $10.00 a month");
    await readers.getByLabel("Name staff pick").fill("Bar M2");
    await readers.getByLabel("Registration code").fill("simulated-m2");
    await readers.getByRole("button", { name: "Register" }).click();
    await expect(readers.getByRole("alert")).toHaveText(
      "Only the S710, S700 and WisePOS E work here.",
    );
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * Present the check (M4-08): on Room 9's screen, Present is refused while o1
 * rings and names it in the glossary's words; with o1 cancelled it presents,
 * and Room 9's phone reads "Your bill is ready · ordering is closed".
 */
test("Present the check: blocked while 2 × Margarita · Peach rings, then presented, and Room 9's phone reads the bill is ready", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await setClock(request, "2026-09-26T02:41:00Z");
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room 9");
    const present = page.getByRole("region", { name: "Present the check" });
    await present.getByRole("button", { name: "Present the check" }).click();
    await expect(present.getByRole("alert")).toHaveText(
      "2 × Margarita · Peach is ringing at the bar · accept or cancel it first",
    );
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    await present.getByRole("button", { name: "Present the check" }).click();
    await expect(present.getByRole("status")).toHaveText("Check presented · ordering is closed");
    await expect(present.getByRole("button", { name: "Reopen the check" })).toBeVisible();

    const marcus = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    const token = createHash("sha256")
      .update("host-token:sess_room9")
      .digest("base64url")
      .slice(0, 32);
    await marcus.goto(`http://localhost:3001/r/${token}`);
    await expect(marcus.getByText("Your bill is ready · ordering is closed")).toBeVisible();
    await marcus.context().close();
  } finally {
    await db.end();
  }
});

/**
 * Tap at the reader (M4-11) on Room 9, after Present: the reader picker,
 * "Waiting for a tap on the front-desk reader · Cancel", a declined card,
 * Tap again on the same payment, and Paid. The night's Stripe side (both
 * readers, the deposits) comes from stripe:seed on the fake.
 */
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
test("the hold grows: a round past the $50.00 hold raises it to $80.00, and the chip shows what's left", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await signInMayaAtTheBar(page, request, db);
    const ids = (
      await db.query<{ reader: string; account: string }>(
        `select d.stripe_reader_id as reader, o.stripe_account_id as account
           from devices d join venues v on v.id = d.venue_id join organizations o on o.id = v.org_id
          where d.name = 'Bar S710' and not d.sandbox`,
      )
    ).rows[0]!;
    const headers = {
      authorization: "Bearer rk_test_fake_payments",
      "stripe-account": ids.account,
    };
    const panel = page.getByRole("complementary");
    await page.getByRole("button", { name: "New tab" }).click();
    await panel.getByRole("button", { name: "Read to guest ✓" }).click();
    await expect
      .poll(async () => {
        const r = await request.get(`http://127.0.0.1:12111/v1/terminal/readers/${ids.reader}`, {
          headers,
        });
        return ((await r.json()) as { action?: { status?: string } }).action?.status;
      })
      .toBe("in_progress");
    const r = await request.post(
      `http://127.0.0.1:12111/v1/test_helpers/terminal/readers/${ids.reader}/present_payment_method`,
      {
        headers: { ...headers, "idempotency-key": `e2e-present-${Date.now()}-${Math.random()}` },
        form: { "card_present[number]": "5555555555552281" },
      },
    );
    expect(r.ok(), await r.text()).toBe(true);
    await panel.getByRole("button", { name: "Seat 4" }).click();
    await panel.getByRole("button", { name: "Open", exact: true }).click();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Seat 4");
    await expect(panel).toContainText("Hold $50.00");
    await expect(panel).toContainText("Hold · $50.00 left");

    // A small bucket: $43.55 and $10.00 reserved for the tip pass $50.00, so the hold grows first.
    await page.getByRole("tab", { name: "Buckets" }).click();
    await page.getByRole("button", { name: /^Small bucket · 6 beers · \$/ }).click();
    await panel.getByRole("button", { name: "Send 1 to the bar" }).click();
    await expect(panel).toContainText("Hold $80.00");
    await expect(panel).toContainText("Hold · $26.45 left");
    const pay = (
      await db.query<{ used: number; authorized: number }>(
        `select p.increments_used as used, p.authorized_cents::int as authorized
           from tabs t join payments p on p.id = t.payment_id where t.name = 'Seat 4'`,
      )
    ).rows[0]!;
    expect(pay).toEqual({ used: 1, authorized: 8000 });
  } finally {
    await db.end();
  }
});
test("Close tab: Close to the card, $6.00 picked on the bar reader captures $38.66 in 2 taps under 20 s", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await signInMayaAtTheBar(page, request, db);
    const ids = (
      await db.query<{ reader: string; account: string }>(
        `select d.stripe_reader_id as reader, o.stripe_account_id as account
           from devices d join venues v on v.id = d.venue_id join organizations o on o.id = v.org_id
          where d.name = 'Bar S710' and not d.sandbox`,
      )
    ).rows[0]!;
    const headers = {
      authorization: "Bearer rk_test_fake_payments",
      "stripe-account": ids.account,
    };
    const readerAction = async () => {
      const r = await request.get(`http://127.0.0.1:12111/v1/terminal/readers/${ids.reader}`, {
        headers,
      });
      const action = ((await r.json()) as { action?: { type?: string; status?: string } }).action;
      return `${action?.type ?? ""}:${action?.status ?? ""}`;
    };
    const panel = page.getByRole("complementary");
    await page.getByRole("button", { name: "New tab" }).click();
    await panel.getByRole("button", { name: "Read to guest ✓" }).click();
    await expect.poll(readerAction).toBe("collect_payment_method:in_progress");
    const tapped = await request.post(
      `http://127.0.0.1:12111/v1/test_helpers/terminal/readers/${ids.reader}/present_payment_method`,
      {
        headers: { ...headers, "idempotency-key": `e2e-present-${Date.now()}-${Math.random()}` },
        form: { "card_present[number]": "4000003800000008" },
      },
    );
    expect(tapped.ok(), await tapped.text()).toBe(true);
    await panel.getByRole("button", { name: "Seat 7" }).click();
    await panel.getByRole("button", { name: "Open", exact: true }).click();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Seat 7");

    // Jess P.'s round: 2 × Modelo and a Jäger Bomb, $32.66.
    await page.getByRole("tab", { name: "Beer" }).click();
    await page.getByRole("button", { name: /^Modelo · \$/ }).click();
    await page.getByRole("button", { name: /^Modelo · \$/ }).click();
    await page.getByRole("tab", { name: "Shots" }).click();
    await page.getByRole("button", { name: /^Jäger Bomb · \$/ }).click();
    await panel.getByRole("button", { name: "Send 3 to the bar" }).click();
    await expect(panel.locator(".total").first()).toContainText("$32.66");

    // Two taps on the tab, then the guest tips on the reader.
    const started = Date.now();
    await panel.getByRole("button", { name: "Close tab" }).click();
    await panel.getByRole("button", { name: /^Close to the card/ }).click();
    const closing = panel.getByRole("region", { name: "Close tab" });
    await expect(closing).toContainText("Waiting for the tip on the bar reader");
    const choices = closing.getByRole("list", { name: "Tip choices on the reader" });
    await expect(choices.getByRole("listitem")).toHaveText([
      "$5.40",
      "$6.00",
      "$6.60",
      "Custom",
      "No tip",
    ]);
    await expect.poll(readerAction).toBe("collect_inputs:in_progress");
    const picked = await request.post(
      `http://127.0.0.1:12111/v1/test_helpers/terminal/readers/${ids.reader}/succeed_input_collection`,
      {
        headers: { ...headers, "idempotency-key": `e2e-tip-${Date.now()}-${Math.random()}` },
        form: { selection: "tip_1" },
      },
    );
    expect(picked.ok(), await picked.text()).toBe(true);
    await expect(closing).toContainText("Paid $38.66 with a tip of $6.00");
    timedTask("Close a tab with a tip", 2, Date.now() - started, 20_000);
    const pay = (
      await db.query<{ status: string; amount: number; tip: number; tab: string }>(
        `select p.status, p.amount_cents::int as amount, p.tip_cents::int as tip, t.state as tab
           from tabs t join payments p on p.id = t.payment_id where t.name = 'Seat 7'`,
      )
    ).rows[0]!;
    expect(pay).toEqual({ status: "captured", amount: 3266, tip: 600, tab: "captured" });

    // The receipt: Print, then Done; the tab is in Closed tonight.
    await closing.getByRole("button", { name: "Print" }).click();
    await closing.getByRole("button", { name: "Done" }).click();
    await expect(panel.getByRole("button", { name: "Close tab" })).toHaveCount(0);
  } finally {
    await db.end();
  }
});
/**
 * Split a tab (M6-10): Jess P.'s $32.66 in two is $16.33 + $16.33, kept on the server, so a share paid in
 * cash is still paid after switching tabs and reloading ("Partly paid · $16.33 of $32.66"), and the last
 * share goes on her held Visa ··4417, with the tip on the reader.
 */
test("Split a $32.66 tab: a cash share survives switching tabs, and Visa ··4417 pays the rest", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await signInMayaAtTheBar(page, request, db);
    const tabs = page.getByRole("list", { name: "Bar tabs" });
    const panel = page.getByRole("complementary");
    const ids = (
      await db.query<{ reader: string; account: string }>(
        `select d.stripe_reader_id as reader, o.stripe_account_id as account
           from devices d join venues v on v.id = d.venue_id join organizations o on o.id = v.org_id
          where d.name = 'Bar S710' and not d.sandbox`,
      )
    ).rows[0]!;
    const headers = {
      authorization: "Bearer rk_test_fake_payments",
      "stripe-account": ids.account,
    };
    const readerAction = async () => {
      const r = await request.get(`http://127.0.0.1:12111/v1/terminal/readers/${ids.reader}`, {
        headers,
      });
      return ((await r.json()) as { action?: { type?: string } }).action?.type ?? "";
    };
    // A tab opened card first on a Visa ··4417, with Jess P.'s round: 2 × Modelo and a Jäger Bomb.
    await page.getByRole("button", { name: "New tab" }).click();
    await panel.getByRole("button", { name: "Read to guest ✓" }).click();
    await expect.poll(readerAction).toBe("collect_payment_method");
    const tapped = await request.post(
      `http://127.0.0.1:12111/v1/test_helpers/terminal/readers/${ids.reader}/present_payment_method`,
      {
        headers: { ...headers, "idempotency-key": `e2e-present-${Date.now()}-${Math.random()}` },
        form: { "card_present[number]": "4000000000004417" },
      },
    );
    expect(tapped.ok(), await tapped.text()).toBe(true);
    await panel.getByRole("button", { name: "Seat 7" }).click();
    await panel.getByRole("button", { name: "Open", exact: true }).click();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Seat 7");
    await page.getByRole("tab", { name: "Beer" }).click();
    await page.getByRole("button", { name: /^Modelo · \$/ }).click();
    await page.getByRole("button", { name: /^Modelo · \$/ }).click();
    await page.getByRole("tab", { name: "Shots" }).click();
    await page.getByRole("button", { name: /^Jäger Bomb · \$/ }).click();
    await panel.getByRole("button", { name: "Send 3 to the bar" }).click();
    await expect(panel.locator(".total").first()).toContainText("$32.66");

    await panel.getByRole("button", { name: "Split", exact: true }).click();
    await panel.getByRole("button", { name: "Split 2 ways" }).click();
    const split = panel.getByRole("region", { name: "Split" });
    await expect(split.getByRole("listitem")).toHaveText([
      /Share 1 of 2 · \$16\.33.*On Visa ··4417 · charged last/,
      /Share 2 of 2 · \$16\.33/,
    ]);
    await split
      .getByRole("listitem", { name: "Share 2 of 2" })
      .getByRole("button", { name: "Pay this share" })
      .click();
    await panel.getByRole("button", { name: "Exact $16.33" }).click();
    await panel.getByRole("button", { name: "Take $16.33 in cash" }).click();
    await expect(split.getByRole("listitem", { name: "Share 2 of 2" })).toContainText("Paid");

    // Another tab, then back, then a reload: the paid share is still paid.
    await tabs.getByRole("button", { name: /Jess P\./ }).click();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Jess P.");
    await expect(tabs.getByRole("button", { name: /Seat 7/ })).toContainText(
      "Partly paid · $16.33 of $32.66",
    );
    await page.reload();
    await tabs.getByRole("button", { name: /Seat 7/ }).click();
    await expect(split.getByRole("listitem", { name: "Share 2 of 2" })).toContainText("Paid");

    // The last share on her held card, with the tip on the reader.
    await split.getByRole("button", { name: "Charge Visa ··4417" }).click();
    const closing = panel.getByRole("region", { name: "Close tab" });
    await expect(closing).toContainText("$16.33");
    await closing.getByRole("button", { name: /^Close to the card/ }).click();
    await expect(closing).toContainText("Waiting for the tip on the bar reader");
    await expect.poll(readerAction).toBe("collect_inputs");
    const picked = await request.post(
      `http://127.0.0.1:12111/v1/test_helpers/terminal/readers/${ids.reader}/succeed_input_collection`,
      {
        headers: { ...headers, "idempotency-key": `e2e-tip-${Date.now()}-${Math.random()}` },
        form: { selection: "none" },
      },
    );
    expect(picked.ok(), await picked.text()).toBe(true);
    await expect(closing).toContainText("Paid $16.33");
    const states = (
      await db.query<{ state: string }>(
        `select s.state from split_shares s join check_splits k on k.id = s.split_id
           join tabs t on t.check_id = k.check_id where t.name = 'Seat 7' order by s.share_no`,
      )
    ).rows.map((r) => r.state);
    expect(states).toEqual(["paid", "paid"]);
  } finally {
    await db.end();
  }
});
/**
 * Pay a tab another way (M6-11): a new card that's declined leaves the $50.00 hold standing; cash then
 * pays the $32.66 in one tap, and the hold on the tab's card is released and the tab closes.
 */
test("Pay a tab another way: a declined new card keeps the hold, then cash closes the tab and releases it", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await signInMayaAtTheBar(page, request, db);
    const panel = page.getByRole("complementary");
    const ids = (
      await db.query<{ reader: string; account: string }>(
        `select d.stripe_reader_id as reader, o.stripe_account_id as account
           from devices d join venues v on v.id = d.venue_id join organizations o on o.id = v.org_id
          where d.name = 'Bar S710' and not d.sandbox`,
      )
    ).rows[0]!;
    const headers = {
      authorization: "Bearer rk_test_fake_payments",
      "stripe-account": ids.account,
    };
    const readerAction = async () => {
      const r = await request.get(`http://127.0.0.1:12111/v1/terminal/readers/${ids.reader}`, {
        headers,
      });
      return ((await r.json()) as { action?: { type?: string } }).action?.type ?? "";
    };
    const hold = async () =>
      (
        await db.query<{ status: string; state: string }>(
          `select p.status, t.state from tabs t join payments p on p.id = t.payment_id where t.name = 'Seat 7'`,
        )
      ).rows[0];
    await page.getByRole("button", { name: "New tab" }).click();
    await panel.getByRole("button", { name: "Read to guest ✓" }).click();
    await expect.poll(readerAction).toBe("collect_payment_method");
    const tapped = await request.post(
      `http://127.0.0.1:12111/v1/test_helpers/terminal/readers/${ids.reader}/present_payment_method`,
      {
        headers: { ...headers, "idempotency-key": `e2e-present-${Date.now()}-${Math.random()}` },
        form: { "card_present[number]": "4000000000005120" },
      },
    );
    expect(tapped.ok(), await tapped.text()).toBe(true);
    await panel.getByRole("button", { name: "Seat 7" }).click();
    await panel.getByRole("button", { name: "Open", exact: true }).click();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Seat 7");
    await page.getByRole("tab", { name: "Beer" }).click();
    await page.getByRole("button", { name: /^Modelo · \$/ }).click();
    await page.getByRole("button", { name: /^Modelo · \$/ }).click();
    await page.getByRole("tab", { name: "Shots" }).click();
    await page.getByRole("button", { name: /^Jäger Bomb · \$/ }).click();
    await panel.getByRole("button", { name: "Send 3 to the bar" }).click();
    await expect(panel.locator(".total").first()).toContainText("$32.66");

    await panel.getByRole("button", { name: "Close tab", exact: true }).click();
    const closing = panel.getByRole("region", { name: "Close tab" });
    await closing.getByRole("button", { name: "Another card" }).click();
    const tap = closing.getByRole("region", { name: "Tap at the reader" });
    await tap.getByLabel("Bar S710").check();
    await tap.getByRole("button", { name: "Send $32.66 to the reader" }).click();
    await expect.poll(readerAction).toBe("process_payment_intent");
    await presentCard(request, db, "Bar S710", "4000000000000002");
    await expect(tap.getByRole("alert")).toContainText("Declined · try another card or cash");
    expect(await hold()).toEqual({ status: "authorized", state: "open" });

    await closing.getByRole("button", { name: "Back to Close tab" }).click();
    await closing.getByRole("button", { name: "Cash", exact: true }).click();
    await closing.getByRole("button", { name: "Exact $32.66" }).click();
    await expect(closing).toContainText("Logged to Maya");
    await expect(closing.getByRole("status").first()).toBeVisible();
    await expect(closing).toContainText("Paid · the hold on the tab's card is released");
    await expect.poll(hold).toEqual({ status: "canceled", state: "closed" });
    expect(await clippedText(page)).toEqual([]);
    await closing.getByRole("button", { name: "Done" }).click();
  } finally {
    await db.end();
  }
});
/**
 * Reopen a settled tab (M6-12): a $272.19 tab (Moët & Chandon · bottle and Large bucket · 10 beers) closed
 * to its card with No tip is in Closed tonight; Reopen brings it back as "Paid $272.19 · no hold" with no
 * pay buttons. A new Modelo makes $9.80 due, Close tab offers no "Close to the card", and Charge the saved
 * card goes through once the guest taps Yes on the bar reader.
 */
test("Reopen a $272.19 tab: Paid · no hold, then a Modelo on the saved card after the guest's Yes", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await signInMayaAtTheBar(page, request, db);
    const panel = page.getByRole("complementary");
    const ids = (
      await db.query<{ reader: string; account: string }>(
        `select d.stripe_reader_id as reader, o.stripe_account_id as account
           from devices d join venues v on v.id = d.venue_id join organizations o on o.id = v.org_id
          where d.name = 'Bar S710' and not d.sandbox`,
      )
    ).rows[0]!;
    const headers = {
      authorization: "Bearer rk_test_fake_payments",
      "stripe-account": ids.account,
    };
    const readerAction = async () => {
      const r = await request.get(`http://127.0.0.1:12111/v1/terminal/readers/${ids.reader}`, {
        headers,
      });
      const a = ((await r.json()) as { action?: { type?: string; status?: string } }).action;
      return a ? `${a.type}:${a.status}` : "";
    };
    const guestPicks = async (selection: string) => {
      const r = await request.post(
        `http://127.0.0.1:12111/v1/test_helpers/terminal/readers/${ids.reader}/succeed_input_collection`,
        {
          headers: { ...headers, "idempotency-key": `e2e-pick-${Date.now()}-${Math.random()}` },
          form: { selection },
        },
      );
      expect(r.ok(), await r.text()).toBe(true);
    };
    const tabState = async () =>
      (await db.query<{ state: string }>("select state from tabs where name = 'Seat 7'")).rows[0]
        ?.state;

    // A tab card first, then the $272.19 round.
    await page.getByRole("button", { name: "New tab" }).click();
    await panel.getByRole("button", { name: "Read to guest ✓" }).click();
    await expect.poll(readerAction).toBe("collect_payment_method:in_progress");
    const tapped = await request.post(
      `http://127.0.0.1:12111/v1/test_helpers/terminal/readers/${ids.reader}/present_payment_method`,
      {
        headers: { ...headers, "idempotency-key": `e2e-present-${Date.now()}-${Math.random()}` },
        form: { "card_present[number]": "4242424242424242" },
      },
    );
    expect(tapped.ok(), await tapped.text()).toBe(true);
    await panel.getByRole("button", { name: "Seat 7" }).click();
    await panel.getByRole("button", { name: "Open", exact: true }).click();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Seat 7");
    const search = page.getByRole("searchbox", { name: "Search the menu" });
    await search.fill("Moët");
    await page.getByRole("button", { name: /^Moët & Chandon · bottle · \$/ }).click();
    await search.fill("Large bucket");
    await page.getByRole("button", { name: /^Large bucket · 10 beers · \$/ }).click();
    await panel.getByRole("button", { name: "Send 2 to the bar" }).click();
    await expect(panel.locator(".total").first()).toContainText("$272.19");

    // Closed to the card with No tip on the reader.
    await panel.getByRole("button", { name: "Close tab" }).click();
    await panel.getByRole("button", { name: /^Close to the card/ }).click();
    const closing = panel.getByRole("region", { name: "Close tab" });
    await expect.poll(readerAction).toBe("collect_inputs:in_progress");
    await guestPicks("none");
    await expect(closing).toContainText("Paid $272.19 with a tip of $0.00");
    await closing.getByRole("button", { name: "No receipt" }).click();
    await closing.getByRole("button", { name: "Done" }).click();
    expect(await tabState()).toBe("captured");

    // Closed tonight, then Reopen: "Paid $272.19 · no hold", no Close to card, nothing to pay.
    const nav = page.getByRole("navigation");
    await nav.getByText(/^Closed tonight · \d+$/).click();
    const row = nav.locator("li.closed-tab", { hasText: "Seat 7" });
    await expect(row.getByRole("button", { name: "Refund" })).toHaveCount(0);
    await row.getByRole("button", { name: "Reopen" }).click();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Seat 7");
    await expect(panel.locator(".chips")).toContainText("Paid $272.19 · no hold");
    await expect(panel.getByRole("button", { name: "Close tab" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Split" })).toHaveCount(0);
    expect(await tabState()).toBe("open");

    // A Modelo: $9.80 due; Close tab offers the saved card, never Close to the card.
    await search.fill("Modelo");
    await page.getByRole("button", { name: /^Modelo · \$/ }).click();
    await panel.getByRole("button", { name: "Send 1 to the bar" }).click();
    await expect(panel.locator(".total").first()).toContainText("$281.99");
    await panel.getByRole("button", { name: "Close tab" }).click();
    await expect(closing.getByRole("button", { name: /^Close to the card/ })).toHaveCount(0);
    await closing.getByRole("button", { name: "Charge the saved card · Visa ··4242" }).click();
    const saved = closing.getByRole("region", { name: "Charge the saved card" });
    await saved.getByRole("button", { name: "Ask the guest on the bar reader" }).click();
    await expect(saved).toContainText("Waiting for the guest's Yes on the bar reader");
    await expect.poll(readerAction).toBe("collect_inputs:in_progress");
    expect(await clippedText(page)).toEqual([]);
    await guestPicks("yes");
    await expect(closing).toContainText("Paid");
    await expect(closing.getByRole("region", { name: "Receipt" })).toBeVisible();
    await expect.poll(tabState).toBe("closed");
    const charged = (
      await db.query<{ amount: number; method: string; status: string }>(
        `select p.amount_cents::int as amount, p.method, p.status from payments p
           join payment_allocations a on a.payment_id = p.id join tabs t on t.check_id = a.check_id
          where t.name = 'Seat 7' and p.method = 'card_on_file'`,
      )
    ).rows;
    expect(charged).toEqual([{ amount: 980, method: "card_on_file", status: "captured" }]);
    await closing.getByRole("button", { name: "Done" }).click();
  } finally {
    await db.end();
  }
});
const presentCard = async (
  request: APIRequestContext,
  db: pg.Client,
  readerName: string,
  number = "4242424242424242",
) => {
  const ids = (
    await db.query<{ reader: string; account: string }>(
      `select d.stripe_reader_id as reader, o.stripe_account_id as account
         from devices d join venues v on v.id = d.venue_id join organizations o on o.id = v.org_id where d.name = $1 and not d.sandbox`,
      [readerName],
    )
  ).rows[0]!;
  const r = await request.post(
    `http://127.0.0.1:12111/v1/test_helpers/terminal/readers/${ids.reader}/present_payment_method`,
    {
      headers: {
        authorization: "Bearer rk_test_fake_payments",
        "stripe-account": ids.account,
        "idempotency-key": `e2e-present-${Date.now()}-${Math.random()}`,
      },
      form: { "card_present[number]": number },
    },
  );
  expect(r.ok(), await r.text()).toBe(true);
  return ids;
};

test("Tap at the reader: Room 9's $498.60 waits on the front-desk reader, a decline, Tap again, then Paid", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await setClock(request, "2026-09-26T02:41:00Z");
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await page
      .getByRole("region", { name: "Present the check" })
      .getByRole("button", { name: "Present the check" })
      .click();
    const tap = page.getByRole("region", { name: "Tap at the reader" });
    await expect(tap.getByText("Pick a reader first")).toBeVisible();
    // Nothing goes to a reader until one is picked.
    await expect(tap.getByRole("button", { name: "Send $498.60 to the reader" })).toBeDisabled();
    await tap.getByLabel("Front desk S710").check();
    await tap.getByRole("button", { name: "Send $498.60 to the reader" }).click();
    await expect(tap.getByRole("status")).toHaveText(
      "Waiting for a tap on the front-desk reader · Cancel",
    );

    const ids = await presentCard(request, db, "Front desk S710", "4000000000000002");
    await expect(tap.getByRole("alert")).toHaveText("Declined · try another card or cash");
    await tap.getByRole("button", { name: "Tap again" }).click();
    await expect(tap.getByRole("status")).toHaveText(
      "Waiting for a tap on the front-desk reader · Cancel",
    );
    await presentCard(request, db, "Front desk S710");
    // Paid in full: the room goes to cleaning, and "Paid" stays on the screen.
    await expect(page.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible({
      timeout: 15_000,
    });

    // One PaymentIntent for $498.60, and the reader skipped its tip screen.
    const reader = await request.get(`http://127.0.0.1:12111/v1/terminal/readers/${ids.reader}`, {
      headers: { authorization: "Bearer rk_test_fake_payments", "stripe-account": ids.account },
    });
    expect(
      ((await reader.json()) as { action: { process_payment_intent: { process_config: unknown } } })
        .action,
    ).toMatchObject({
      status: "succeeded",
      process_payment_intent: { process_config: { skip_tipping: "true" } },
    });
    const payment = await db.query<{ amount: number; attempts: number; status: string }>(
      `select p.amount_cents::int as amount, p.status,
              (select count(*)::int from payment_attempts a where a.payment_id = p.id) as attempts
         from payments p where p.method = 'card_present' order by p.created_at desc limit 1`,
    );
    expect(payment.rows[0]).toEqual({ amount: 49860, attempts: 2, status: "captured" });
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

test("on the Room phone, Cancel while waiting frees the $498.60 for another way to pay", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await setClock(request, "2026-09-26T02:41:00Z");
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndy(page, request, db);
    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await page
      .getByRole("region", { name: "Present the check" })
      .getByRole("button", { name: "Present the check" })
      .click();
    const tap = page.getByRole("region", { name: "Tap at the reader" });
    await tap.getByLabel("Bar S710").check();
    await tap.getByRole("button", { name: "Send $498.60 to the reader" }).click();
    await expect(tap.getByRole("status")).toHaveText(
      "Waiting for a tap on the bar reader · Cancel",
    );
    await tap.getByRole("button", { name: "Cancel" }).click();
    await expect(tap.getByRole("status")).toHaveText("Canceled · nothing was charged");
    await expect(tap.getByRole("button", { name: "Send $498.60 to the reader" })).toBeVisible();
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * Cash (M4-13): Diego at the front-desk computer, paired to the front-desk
 * drawer, takes Room 9's $498.60 with $500.00: "Change $1.40" in large type,
 * the drawer kick queued, and "Logged to Diego · front-desk drawer"; then
 * "Wrong amount? Fix the change". On Andy's phone, Room 5's cash goes into
 * his staff bank.
 */
test("Cash at the front desk: Room 9's $498.60 with $500.00, $1.40 change, logged to Diego · front-desk drawer", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await db.query("update memberships set locale = 'en'");
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page
      .getByLabel("Pairing code from Admin → Devices")
      .fill(await pairingCode(db, "front_desk", "Front desk"));
    expect(
      (
        await page.request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })
      ).ok(),
    ).toBe(true);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.getByRole("button", { name: /Diego R\./ }).click();
    await typePin(page, "6358");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    // The newly paired screen rings cash into the front-desk drawer (PATCH /devices/{d} in Admin).
    await db.query(
      `update devices set cash_drawer_id = (select row_id from seed_ids where slug = 'drawer_front')
        where kind = 'front_desk' and cash_drawer_id is null`,
    );
    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await page
      .getByRole("region", { name: "Present the check" })
      .getByRole("button", { name: "Present the check" })
      .click();
    const cash = page.getByRole("region", { name: "Cash" });
    await cash.getByRole("button", { name: "$500.00" }).click();
    await expect(cash.getByLabel("Change")).toHaveText("Change $1.40");
    await cash.getByRole("button", { name: "Take $498.60 in cash" }).click();
    const result = page.getByRole("region", { name: "Cash taken" });
    await expect(result.getByRole("status")).toHaveText("Logged to Diego · front-desk drawer");
    await expect(result.getByLabel("Change")).toHaveText("Change $1.40");
    const kick = await db.query("select count(*)::int as n from print_jobs where kind = 'drawer'");
    expect(kick.rows[0].n).toBe(1);
    await result.getByRole("button", { name: "Wrong amount? Fix the change" }).click();
    await result.getByLabel("Handed over").fill("600");
    await result.getByRole("button", { name: "Fix the change" }).click();
    await expect(result.getByLabel("Change")).toHaveText("Change $101.40");
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

test("Cash on Andy's phone: Room 5's $51.55 with the next $20, $8.45 change, into his staff bank", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await setClock(request, "2026-09-26T02:41:00Z");
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o2')",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndy(page, request, db);
    const room5 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 5'"))
      .rows[0]!.id;
    await page.goto(`/room/${room5}`);
    await page
      .getByRole("region", { name: "Present the check" })
      .getByRole("button", { name: "Present the check" })
      .click();
    const cash = page.getByRole("region", { name: "Cash" });
    await cash.getByRole("button", { name: "$60.00" }).click();
    await expect(cash.getByLabel("Change")).toHaveText("Change $8.45");
    await cash.getByRole("button", { name: "Take $51.55 in cash" }).click();
    await expect(page.getByRole("region", { name: "Cash taken" }).getByRole("status")).toHaveText(
      "Logged to Andy · their staff bank",
    );
    const bank = await db.query(
      "select cash_cents::int as cash from staff_banks where user_id = (select row_id from seed_ids where slug = 'andy')",
    );
    expect(bank.rows[0].cash).toBe(5155);
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * Split (M4-14) on DeskRoom: Room 9's $498.60 split evenly three ways shows
 * three $166.20 shares; share 1 paid in cash is still paid after the tab is
 * opened again; Stop splitting leaves the rest, $332.40, as one payment.
 */
test("Split on DeskRoom: three $166.20 shares, share 1 in cash kept after a reload, then Stop splitting", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await setClock(request, "2026-09-26T02:41:00Z");
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await page
      .getByRole("region", { name: "Present the check" })
      .getByRole("button", { name: "Present the check" })
      .click();
    const split = page.getByRole("region", { name: "Split" });
    await split.getByLabel("How many ways").fill("3");
    await split.getByRole("button", { name: "Split evenly" }).click();
    for (const n of [1, 2, 3])
      await expect(split.getByRole("listitem", { name: `Share ${n} of 3` })).toContainText(
        "$166.20",
      );
    await split
      .getByRole("listitem", { name: "Share 1 of 3" })
      .getByRole("button", { name: "Pay this share" })
      .click();
    const cash = page.getByRole("region", { name: "Cash" });
    await cash.getByRole("button", { name: "Exact $166.20" }).click();
    await cash.getByRole("button", { name: "Take $166.20 in cash" }).click();
    await expect(split.getByRole("listitem", { name: "Share 1 of 3" })).toContainText("Paid");

    await page.reload();
    await expect(split.getByRole("listitem", { name: "Share 1 of 3" })).toContainText("Paid");
    await expect(split.getByRole("listitem", { name: "Share 2 of 3" })).toContainText("To pay");
    await split.getByRole("button", { name: "Stop splitting · charge the rest to …" }).click();
    await expect(split.getByRole("button", { name: "Split evenly" })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Cash" })
        .getByRole("button", { name: "Take $332.40 in cash" }),
    ).toBeVisible();
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * Card on file (M4-17; screens N8, DeskRoom note 2) on Room 9 after Present:
 * Andy picks the card on file, DeskRoom waits for Marcus, Marcus taps "Pay
 * with Amex ··1005" on his phone's bill, and the check is paid off-session.
 */
test("Card on file: Room 9 waits for Marcus, the guest taps Pay with Amex ··1005 on the phone, Paid", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await setClock(request, "2026-09-26T02:41:00Z");
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await page
      .getByRole("region", { name: "Present the check" })
      .getByRole("button", { name: "Present the check" })
      .click();
    const onFile = page.getByRole("region", { name: "Card on file · Amex ··1005" });
    await onFile.getByRole("button", { name: "Card on file · Amex ··1005" }).click();
    await expect(onFile.getByRole("status")).toHaveText(
      "Waiting for Marcus to confirm on their phone · Cancel",
    );
    await expect(onFile.getByRole("button", { name: "Ask a manager to approve" })).toBeVisible();

    const phone = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    const hostToken = createHash("sha256")
      .update("host-token:sess_room9")
      .digest("base64url")
      .slice(0, 32);
    await phone.goto(`http://localhost:3001/r/${hostToken}`);
    const bill = phone.getByRole("region", { name: "Your bill · #1042" });
    await bill.getByRole("button", { name: "Pay with Amex ··1005" }).click();
    await expect(
      phone.getByRole("status").filter({ hasText: "Paid in full · thank you" }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /^Paid$/ })
        .first(),
    ).toBeVisible({
      timeout: 15_000,
    });
    const paid = await db.query<{ status: string; mit_reason: string | null }>(
      "select status, mit_reason from payments where method = 'card_on_file'",
    );
    expect(paid.rows).toEqual([{ status: "captured", mit_reason: null }]);
    await phone.context().close();
  } finally {
    await db.end();
  }
});

/**
 * Pay my share (M4-18; screens N6, DeskRoom note 9): after Present, Kevin
 * joins Room 9 on his phone, takes an even share (1 of 12) with its tax and
 * gratuity shown first, pays $41.55 on the payment page, and DeskRoom reads
 * "Paid by a guest · Kevin (share 1 of 12) $41.55" within seconds.
 */
test("Pay my share: Kevin pays 1 of 12 on the phone and DeskRoom shows it", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await setClock(request, "2026-09-26T02:41:00Z");
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await page
      .getByRole("region", { name: "Present the check" })
      .getByRole("button", { name: "Present the check" })
      .click();
    await expect(page.getByText("Check presented · ordering is closed")).toBeVisible();

    const kevin = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    await kevin.goto(`http://localhost:3001/v/west4karaoke/room/${room9}`);
    await kevin.getByLabel("Room code").fill("KX4M7");
    await kevin.getByRole("button", { name: "Join" }).click();
    const bill = kevin.getByRole("region", { name: "Your bill · #1042" });
    const share = bill.getByRole("group", { name: "Pay my share" });
    await share.getByLabel("Your name, for the bill").fill("Kevin");
    await share.getByRole("button", { name: "An even share (1 of 12)" }).click();
    await expect(share.getByText("Your share 1 of 12 · $41.55")).toBeVisible();
    await expect(share.getByText("Includes $3.55 tax and $8.00 gratuity")).toBeVisible();
    await share.getByRole("link", { name: "Pay $41.55" }).click();
    await expect(kevin).toHaveURL(/^http:\/\/pay\.localhost:3001\/pay\//);
    await kevin.getByRole("button", { name: "Pay $41.55" }).click();
    await expect(kevin.getByRole("status")).toHaveText("Paid $41.55 · thank you");

    await expect(page.getByRole("region", { name: "Payments" })).toContainText(
      "Paid by a guest · Kevin (share 1 of 12) $41.55",
      { timeout: 10_000 },
    );
    await kevin.context().close();
  } finally {
    await db.end();
  }
});

/**
 * room9_closeout (M4-20; Payment flows · Room close-out; screens N21,
 * DeskRoom) at desktop size: Present shows #1042 at $618.60 with the $120.00
 * deposit off and $498.60 to pay; a tap on the front-desk reader (which skips
 * its tip screen) pays it; the receipt choices follow, and once one is picked
 * "Room 9 goes to cleaning" and its Board tile is cleaning.
 */
test("Close-out on DeskRoom: Room 9's #1042 at $618.60, paid by tap, the receipt, then cleaning", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await setClock(request, "2026-09-26T02:41:00Z");
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await page
      .getByRole("region", { name: "Present the check" })
      .getByRole("button", { name: "Present the check" })
      .click();
    const check = page.getByRole("region", { name: "#1042" });
    await expect(check).toContainText("Total$618.60");
    await expect(check).toContainText("Deposit−$120.00");
    await expect(check).toContainText("Left to pay$498.60");
    // Cash is always offered.
    await expect(page.getByRole("region", { name: "Cash" })).toBeVisible();

    const tap = page.getByRole("region", { name: "Tap at the reader" });
    await tap.getByLabel("Front desk S710").check();
    await tap.getByRole("button", { name: "Send $498.60 to the reader" }).click();
    await expect(tap.getByRole("status")).toHaveText(
      "Waiting for a tap on the front-desk reader · Cancel",
    );
    const ids = await presentCard(request, db, "Front desk S710");
    await expect(page.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible({
      timeout: 15_000,
    });
    const reader = await request.get(`http://127.0.0.1:12111/v1/terminal/readers/${ids.reader}`, {
      headers: { authorization: "Bearer rk_test_fake_payments", "stripe-account": ids.account },
    });
    expect(
      ((await reader.json()) as { action: { process_payment_intent: { process_config: unknown } } })
        .action,
    ).toMatchObject({ process_payment_intent: { process_config: { skip_tipping: "true" } } });

    const receipt = page.getByRole("region", { name: "Receipt" });
    for (const choice of ["Text", "Email", "Print", "No receipt"])
      await expect(receipt.getByRole("button", { name: choice, exact: true })).toBeVisible();
    await receipt.getByRole("button", { name: "Print", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Room 9 goes to cleaning" }),
    ).toBeVisible();
    const state = await db.query<{ state: string }>(
      `select s.state from room_states s join rooms r on r.id = s.room_id
        where r.name = 'Room 9' and s.until is null order by s.since desc limit 1`,
    );
    expect(state.rows[0]?.state).toBe("cleaning");
    expect(
      (await db.query("select count(*)::int as n from print_jobs where kind = 'receipt'")).rows[0]
        .n,
    ).toBe(1);
  } finally {
    await db.end();
  }
});

/**
 * Close-out on Andy's phone (M4-20; Staff note 4): "Tab & close out →" on
 * Priya R.'s row opens Room 3's tab, no one-tap Done exists, and Room 9's
 * close-out in Español fits at 390 px with every string in Spanish.
 */
test("Close-out on the phone: Tab & close out → from Priya R.'s row, no Done, and Spanish that fits", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await setClock(request, "2026-09-26T02:41:00Z");
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndy(page, request, db);
    await page.goto("/today");
    await page
      .getByRole("list", { name: "Bookings tonight" })
      .getByRole("listitem")
      .filter({ hasText: "Priya R." })
      .click();
    await page.getByRole("link", { name: "Tab & close out →" }).click();
    const room3 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 3'"))
      .rows[0]!.id;
    await expect(page).toHaveURL(new RegExp(`/room/${room3}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room 3");
    await expect(page.getByRole("button", { name: /^Done/ })).toHaveCount(0);

    // Room 9's close-out in Español.
    await db.query(
      "update memberships set locale = 'es' where user_id = (select id from users where lower(email) = $1)",
      [ANDY],
    );
    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await page.reload();
    await page.getByRole("button", { name: "Presentar la cuenta" }).first().click();
    const check = page.getByRole("region", { name: "#1042" });
    await expect(check).toContainText("Por pagar$498.60");
    await expect(
      page.getByRole("region", { name: "Pagar con tarjeta en el lector" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Efectivo" })).toBeVisible();
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.query(
      "update memberships set locale = 'en' where user_id = (select id from users where lower(email) = $1)",
      [ANDY],
    );
    await db.end();
  }
});

/**
 * Refund from check on the phone (M4-22; screens N22, Staff note 5): Andy's
 * sheet on Marcus's booking starts empty, caps his Amex at $120.00 and ends
 * on "Send to Abhishek"; in Español it reads in Spanish.
 */
test("Refund from check on the phone: Marcus's sheet starts empty, caps at $120.00, Send to Abhishek, and in Spanish", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await setClock(request, "2026-09-26T02:41:00Z");
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndy(page, request, db);
    await page.goto("/today");
    const marcus = () =>
      page.getByRole("listitem").filter({ hasText: /^8:00/ }).filter({ hasText: "Marcus T." });
    await marcus().click();
    await page.getByRole("button", { name: "Refund", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Refund from check #1042" });
    await expect(sheet.getByText("Amex ··1005 · up to $120.00")).toBeVisible();
    // Nothing is picked or filled in.
    for (const box of await sheet.getByRole("checkbox").all()) await expect(box).not.toBeChecked();
    for (const input of await sheet.getByRole("textbox").all()) await expect(input).toHaveValue("");
    const send = sheet.getByRole("button", { name: "Send to Abhishek" });
    await expect(send).toBeDisabled();
    await sheet.getByRole("button", { name: "Close" }).click();

    await db.query(
      "update memberships set locale = 'es' where user_id = (select id from users where lower(email) = $1)",
      [ANDY],
    );
    await page.reload();
    await marcus().click();
    await page.getByRole("button", { name: "Reembolsar", exact: true }).click();
    const hoja = page.getByRole("dialog", { name: "Reembolso de la cuenta #1042" });
    await expect(hoja.getByText("Amex ··1005 · hasta $120.00")).toBeVisible();
    await expect(hoja.getByRole("button", { name: "Enviar a Abhishek" })).toBeVisible();
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.query(
      "update memberships set locale = 'en' where user_id = (select id from users where lower(email) = $1)",
      [ANDY],
    );
    await db.end();
  }
});

/**
 * Refund from check on DeskRoom (M4-22): Room 9 paid in cash, Andy refunds
 * $20.00 of it with a reason, confirms with his passkey, and the sheet reads
 * "Waiting for Abhishek"; Abhishek's approval and Stripe's answer are in
 * apps/api/src/routes/refunds.int.test.ts.
 */
test("Refund from check on DeskRoom: Room 9 paid, $20.00 back, Waiting for Abhishek", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await setClock(request, "2026-09-26T02:41:00Z");
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = (select row_id from seed_ids where slug = 'order_o1')",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    const room9 = (await db.query<{ id: string }>("select id from rooms where name = 'Room 9'"))
      .rows[0]!.id;
    await page.goto(`/room/${room9}`);
    await page
      .getByRole("region", { name: "Present the check" })
      .getByRole("button", { name: "Present the check" })
      .click();
    const cash = page.getByRole("region", { name: "Cash" });
    await cash.getByRole("button", { name: /^Exact/ }).click();
    await cash.getByRole("button", { name: "Take $498.60 in cash" }).click();
    await page.getByRole("button", { name: "Refund", exact: true }).click({ timeout: 15_000 });
    const sheet = page.getByRole("dialog", { name: "Refund from check #1042" });
    const cashLine = sheet.getByLabel(/^Cash · up to \$498\.60/);
    await cashLine.fill("20.00");
    await sheet.getByLabel("Reason").fill("The mic was out for twenty minutes");
    await sheet.getByRole("button", { name: "Send to Abhishek" }).click();
    await expect(sheet.getByRole("status")).toHaveText("Waiting for Abhishek");
    const asked = await db.query<{ status: string; amount_cents: number }>(
      "select status, amount_cents::int from refunds",
    );
    expect(asked.rows).toEqual([{ status: "pending", amount_cents: 2000 }]);
  } finally {
    await db.end();
  }
});

/**
 * A lower party size after the gratuity applies (M4-23; screens N13, N18) on
 * the Board: Andy's "One guest fewer" on Room 9 waits for Abhishek, and the
 * room still bills 12 until he approves.
 */
test("Party size down on the Board: Room 9's one guest fewer waits for Abhishek and keeps billing 12", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await setClock(request, "2026-09-26T02:41:00Z");
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    await page.goto("/tonight");
    await page
      .getByRole("listitem", { name: "Room 9" })
      .getByRole("button", { name: "One guest fewer" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Waiting for Abhishek" }),
    ).toBeVisible();
    const s = await db.query<{ party_size: number }>(
      "select party_size from room_sessions where id = (select row_id from seed_ids where slug = 'sess_room9')",
    );
    expect(s.rows[0]!.party_size).toBe(12);
    const asked = await db.query<{ kind: string; status: string }>(
      "select kind, status from approvals where kind = 'party_size_down'",
    );
    expect(asked.rows).toEqual([{ kind: "party_size_down", status: "pending" }]);
  } finally {
    await db.end();
  }
});

/**
 * Admin → Payments · Disputes (M4-24; screens N37): a dispute on Room 9's
 * check shows its deadline and the evidence already gathered.
 */
test("Disputes inbox: a dispute on #1042 shows its deadline and the evidence gathered", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await setClock(request, "2026-09-26T02:41:00Z");
    await db.query(
      `insert into disputes (venue_id, check_id, stripe_dispute_id, reason, amount_cents, status, due_by, evidence, opened_at)
       select k.venue_id, k.id, 'dp_e2e', 'fraudulent', 49860, 'needs_response', '2026-10-02T23:59:59Z',
              jsonb_build_object('receipt', jsonb_build_object('check_id', k.id, 'number', '#1042'),
                'clock', jsonb_build_array('Room 9 · 8:00 PM to close-out'), 'policy', null,
                'damage_photos', '[]'::jsonb, 'served', jsonb_build_array('2 × Chamisul Fresh'), 'note', null),
              now()
         from checks k where k.id = (select row_id from seed_ids where slug = 'chk_room9')`,
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    await page.goto("/admin/disputes");
    const inbox = page.getByRole("region", { name: "Disputes" });
    const item = inbox.getByRole("listitem", { name: "Disputed $498.60" });
    await expect(item).toContainText("Answer by");
    await expect(item).toContainText("Receipt for check #1042");
    await expect(item).toContainText("Room clock times (1)");
    await expect(item).toContainText("No accepted policy on this booking");
    await expect(item).toContainText("Who served (1 orders)");
    await expect(item.getByRole("button", { name: "Submit the evidence" })).toBeVisible();
  } finally {
    await db.end();
  }
});

/**
 * Admin → Card fee & gratuity (M4-26; screens AdminDesk notes 18 and 26):
 * West 4's card fee off, a 20% gratuity on room checks, tips of 18, 20 and
 * 22%, tip review at 25%, $50.00 and 2 hours, Pay my share on; a change to a
 * tip choice reaches the readers' configuration.
 */
test("Admin → Card fee & gratuity: West 4's settings, and a tip change reaches the readers", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await setClock(request, "2026-09-26T02:41:00Z");
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    await page.goto("/admin/card-fee");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Card fee & gratuity");
    await expect(page.getByRole("radio", { name: "Off" })).toBeChecked();
    await expect(page.getByText("No card fee: every card pays the price shown")).toBeVisible();
    await expect(page.getByLabel("Added to")).toHaveValue("rooms");
    await expect(page.getByLabel("Gratuity percent")).toHaveValue("20");
    await expect(page.getByLabel("Tip choice 1 (%)")).toHaveValue("18");
    await expect(page.getByLabel("Tip choice 2 (%)")).toHaveValue("20");
    await expect(page.getByLabel("Tip choice 3 (%)")).toHaveValue("22");
    await expect(
      page.getByText("A tip over 25% or $50.00, or entered 2 hours late, needs approval"),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", {
        name: "Pay my share: guests pay their own share from their phones",
      }),
    ).toBeChecked();

    await page.getByLabel("Tip choice 1 (%)").fill("15");
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(page.getByLabel("Tip choice 1 (%)")).toHaveValue("15", { timeout: 10_000 });
    const ids = (
      await db.query<{ config: string; account: string }>(
        `select v.stripe_terminal_config_id as config, o.stripe_account_id as account
           from venues v join organizations o on o.id = v.org_id where v.slug = 'west4karaoke'`,
      )
    ).rows[0]!;
    await expect
      .poll(
        async () => {
          const r = await request.get(
            `http://127.0.0.1:12111/v1/terminal/configurations/${ids.config}`,
            {
              headers: {
                authorization: "Bearer rk_test_fake_payments",
                "stripe-account": ids.account,
              },
            },
          );
          const tipping = ((await r.json()) as { tipping?: { usd?: { percentages?: string[] } } })
            .tipping;
          return tipping?.usd?.percentages?.map(String);
        },
        { timeout: 10_000 },
      )
      .toEqual(["15", "20", "22"]);
  } finally {
    await db.end();
  }
});

/**
 * The go-live checklist in Admin → Payments (M4-29), the owner's: the
 * merchant category matches Stripe's, Andy and Abhishek each have a Dashboard
 * login and a Tap to Pay phone confirmed, and West 4 passes.
 */
test("Go-live checklist: the merchant category, Andy and Abhishek confirmed, and West 4 passes", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    const account = (
      await db.query<{ a: string }>("select stripe_account_id as a from organizations limit 1")
    ).rows[0]!.a;
    // The account's onboarding is done in the fake, so it reports its merchant category.
    expect((await request.get(`http://127.0.0.1:12111/fake/onboarding/${account}`)).ok()).toBe(
      true,
    );
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await page.goto("/admin/payments");
    const list = page.getByRole("region", { name: "Go-live checklist" });
    await expect(list.getByRole("status")).toHaveText("Not yet: finish each check below");
    // A reload of the checklist landing between the fill and the click wipes the field (seen once in
    // the full run), so the entry is made again until the saved answer shows; saving is idempotent.
    await expect(async () => {
      await list.getByLabel("The category we expect").fill("5813");
      await list.getByRole("button", { name: "Save the category" }).click();
      await expect(list.getByText("Checked: Stripe has 5813")).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    // Each box follows the server's answer, so it's ticked a moment after the click.
    for (const name of ["Abhishek", "Andy"])
      for (const label of ["has a Stripe Dashboard login", "has a Tap to Pay phone"]) {
        const box = list.getByRole("checkbox", { name: new RegExp(`^${name}.* ${label}$`) });
        await box.click();
        await expect(box).toBeChecked();
      }
    await expect(list.getByRole("status")).toHaveText("Passes: West 4 is ready to take payments");
    await expect(list.getByText(/^Confirmed by Abhishek/).first()).toBeVisible();
  } finally {
    await db.end();
  }
});

/**
 * Admin → Website (M5-02): new hero words, published, show on the live
 * homepage, and version 1 published again brings the old ones back; a photo
 * can't be saved without alt text; Packages can't be switched on while its
 * module is off, and says why.
 */
test("Admin → Website: new hero words go live, version 1 comes back, alt text and a module-off section", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const db = await dbClient();
  try {
    await db.query("update venue_modules set state = 'off' where module_id = 'packages'");
    await signInAndy(page, request, db);
    await page.goto("/admin/website");
    await expect(page.getByRole("heading", { level: 2, name: "Website" })).toBeVisible();
    await expect(page.getByText("Live: version 1")).toBeVisible();

    // Packages: off, with the reason.
    const packages = page.getByRole("checkbox", { name: "Packages" });
    await expect(packages).toBeDisabled();
    await expect(page.getByText("Turn on Packages & specials in Features first.")).toBeVisible();

    // A photo without alt text isn't saved.
    await page.getByLabel("Add a photo").setInputFiles({
      name: "room9.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expect(page.getByLabel("Alt text: what the photo shows")).toBeVisible();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("alert")).toHaveText("Every photo needs alt text before you save.");
    await page.getByRole("button", { name: "Remove photo" }).click();

    const home = await (await request.get("http://localhost:3001/")).text();
    expect(home).toContain("Lose your voice.");
    await page.getByLabel("Headline", { exact: true }).fill("Sing it like you mean it.");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved. It goes live when you publish.")).toBeVisible();
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText(/^Version 2 is live/)).toBeVisible();
    expect(await (await request.get("http://localhost:3001/")).text()).toContain(
      "Sing it like you mean it.",
    );

    const v1 = page.getByRole("listitem").filter({ hasText: "Version 1" });
    await v1.getByRole("button", { name: "Publish again" }).click();
    await expect(page.getByText(/^Version 3 is live/)).toBeVisible();
    expect(await (await request.get("http://localhost:3001/")).text()).toContain(
      "Lose your voice.",
    );
  } finally {
    await db.end();
  }
});

/** A party enquiry from the website (M5-04) in Messages: unread, its size and date, and a link refused. */
test("a party enquiry for 22 lands in Messages unread; a reply with a link points to the Payment link text", async ({
  page,
  request,
}) => {
  const db = await dbClient();
  try {
    const sent = await request.post("/v1/public/venues/west4karaoke/enquiries", {
      data: {
        name: "Priya",
        phone: "+16465550142",
        party_size: 22,
        date: "2026-10-10",
        message: "Office party, about 22 of us, from 8 PM.",
      },
    });
    expect(sent.status()).toBe(201);
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    await page
      .getByRole("link", { name: /Messages/ })
      .first()
      .click();
    // Exact: Room 3's "Text Priya R.: please wrap up" alert can be on screen too.
    const priya = page.getByRole("button", { name: "Priya", exact: true });
    await expect(priya).toContainText("Party enquiry");
    await expect(priya).toContainText("1 unread");
    await priya.click();
    const thread = page.getByRole("region", { name: "Priya" });
    await expect(thread).toContainText("Party enquiry · 22 guests · Sat, Oct 10");
    await expect(thread).toContainText("Office party, about 22 of us, from 8 PM.");
    await thread.getByLabel("Reply").fill("Pay the deposit at west4karaoke.com/pay");
    await thread.getByRole("button", { name: "Send" }).click();
    await expect(thread.getByRole("alert")).toHaveText(
      "A reply can't carry a link. For a deposit, send the Payment link text.",
    );
  } finally {
    await db.end();
  }
});

/**
 * Admin → Deposits & cancelling (M5-06): West 4's deposit, the words guests
 * accept, and a save that publishes policy version 2; with Online booking &
 * deposits off, the section says so.
 */
test("Admin → Deposits & cancelling: West 4's terms, a 48-hour cut-off published as version 2, and booking off", async ({
  page,
  request,
}) => {
  const db = await dbClient();
  try {
    await signInAndy(page, request, db);
    await page.goto("/admin/deposits");
    await expect(
      page.getByRole("heading", { level: 2, name: "Deposits & cancelling" }),
    ).toBeVisible();
    await expect(page.getByLabel("Deposit", { exact: true })).toHaveValue("firstHour");
    await expect(page.getByLabel("Full refund up to (hours before the start)")).toHaveValue("24");
    await expect(page.getByLabel("Cancelled later")).toHaveValue("keep");
    await expect(page.getByLabel("No-show", { exact: true })).toHaveValue("keep");
    await expect(page.getByLabel("No-show after (minutes late)")).toHaveValue("15");
    await expect(page.getByLabel("From (guests)")).toHaveValue("20");
    await expect(page.getByLabel("Big-party deposit")).toHaveValue("250.00");
    const policy = page.locator(".policy");
    await expect(policy).toContainText("We save the card you pay with.");
    await expect(policy).toContainText("Cancel at least 24 hours before your start");
    await expect(page.getByText("Live: version 1")).toBeVisible();

    await page.getByLabel("Full refund up to (hours before the start)").fill("48");
    await expect(policy).toContainText("Cancel at least 48 hours before your start");
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(page.getByText("Published")).toBeVisible();
    await expect(page.getByText("Live: version 2")).toBeVisible();
    const live = await (await request.get("/v1/public/venues/west4karaoke/policy")).json();
    expect(live).toMatchObject({ version: 2, text: expect.stringContaining("48 hours") });

    await db.query("update venue_modules set state = 'off' where module_id = 'online_booking'");
    await page.reload();
    await expect(page.getByRole("status")).toHaveText(
      "Online booking is off. Turn on Online booking & deposits in Features to set deposits.",
    );
  } finally {
    await db.end();
  }
});

/**
 * Admin → Bar POS · Layout (M6-01): West 4's version 1, an item added to the
 * first open Favorites slot with nothing else moving, and Publish at 10:41 PM
 * on Fri Sep 25 reading "Starts Sat, Sep 26" while tonight keeps version 1.
 */
test("Admin → Bar POS: add Nütrl to Favorites' first open slot, publish, starts Sat Sep 26", async ({
  page,
  request,
}) => {
  const db = await dbClient();
  try {
    await signInAndy(page, request, db);
    await page.goto("/admin/bar-pos");
    await expect(page.getByRole("heading", { level: 2, name: "Bar POS" })).toBeVisible();
    await expect(page.getByText("Tonight: version 1")).toBeVisible();
    const slots = page.getByRole("list", { name: "Favorites" }).getByRole("listitem");
    await expect(slots).toHaveCount(25);
    const before = await slots.allInnerTexts();
    expect(before[22]).toBe("Open slot");
    await page.getByLabel("Add an item").selectOption({ label: "Nütrl hard seltzer" });
    await page.getByRole("button", { name: "Add to the first open slot" }).click();
    const after = await slots.allInnerTexts();
    expect(after[22]).toContain("Nütrl hard seltzer");
    expect(after.slice(0, 22)).toEqual(before.slice(0, 22));
    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByRole("status")).toHaveText(
      /^Version 2 published\. Starts Sat, Sep 26\.$/,
    );
    await expect(page.getByText("Tonight: version 1 · Version 2 starts Sat, Sep 26")).toBeVisible();
  } finally {
    await db.end();
  }
});

/**
 * Admin → Bar POS · the settings (M6-25): West 4's limits, locks, tip path,
 * aging read back as the escalation sentence, and the tabs. A $60 opening
 * hold changes the consent line once saved; a new amber time shows on the
 * bar orders screen at once.
 */
test("Admin → Bar POS: West 4's settings, a $60 opening hold and a new amber time", async ({
  page,
  request,
}) => {
  const db = await dbClient();
  try {
    await signInAndy(page, request, db);
    await page.goto("/admin/bar-pos");
    await expect(page.getByLabel("Reason-only limit, each comp or void")).toHaveValue("25.00");
    await expect(page.getByLabel("Reason-only limit, a shift per person")).toHaveValue("75.00");
    await expect(page.getByLabel("Idle lock, in minutes")).toHaveValue("3");
    await expect(page.getByLabel("Wipe screen, in seconds")).toHaveValue("10");
    await expect(page.getByLabel("Bar tabs tip")).toHaveValue("reader");
    await expect(page.getByLabel("Bar phones, in seconds")).toHaveValue("30");
    await expect(page.getByLabel("Amber and the Board alert, in minutes")).toHaveValue("2");
    await expect(page.getByLabel("Pink and the manager on duty, in minutes")).toHaveValue("4");
    await expect(page.getByLabel("A text or call, in minutes")).toHaveValue("6");
    await expect(page.getByLabel("Chime as backup")).toBeChecked();
    await expect(page.getByLabel("Mute lasts, in seconds")).toHaveValue("60");
    await expect(
      page.getByText(
        "Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup.",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Flag a tab to the manager over")).toHaveValue("600.00");
    await expect(page.getByLabel("Tab cut-off")).toHaveValue("04:30");
    await expect(page.getByText("Ring the bar until someone accepts")).toHaveCount(0);
    expect(await clippedText(page)).toEqual([]);

    await page.getByLabel("Opening hold").fill("60");
    await expect(
      page.getByText("We'll hold $60 on this card and add to it as you order.", { exact: false }),
    ).toBeVisible();
    await page.getByLabel("Amber and the Board alert, in minutes").fill("3");
    await expect(
      page.getByText("Ages on screen: amber at 3 min, pink at 4", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(page.getByText("Published")).toBeVisible();
    const consent = await db.query<{ text: string }>(
      "select text from policy_versions where kind = 'tab_consent' order by version desc limit 1",
    );
    expect(consent.rows[0]!.text).toMatch(/^We'll hold \$60 on this card/);

    await page.goto("/bar-orders");
    await expect(
      page.getByText("Ages on screen: amber at 3 min, pink at 4", { exact: false }),
    ).toBeVisible();
  } finally {
    await db.end();
  }
});

/** Maya signs in by name and PIN on the paired bar computer (the Rail's home). */
async function signInMayaAtTheBar(page: Page, request: APIRequestContext, db: pg.Client) {
  await db.query("update memberships set locale = 'en'");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Pair this screen" }).click();
  await page
    .getByLabel("Pairing code from Admin → Devices")
    .fill(await pairingCode(db, "bar_computer", "Bar computer"));
  expect(
    (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
  ).toBe(true);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await page.getByRole("button", { name: /Maya S\./ }).click();
  await typePin(page, "4071");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");
}

/**
 * The bar POS (M6-02): Maya's five tabs in the order opened, then the rooms
 * with the seed's numbers; the two ringing room orders with Accept, and
 * accepting Room 5's prints its ticket; 86 on Hoegaarden greys it in its slot
 * and on the guest menu with nothing shifting; the words.
 */
/**
 * The seed's bar after a load (M6-27): `pnpm seed`, then `stripe:seed` and `seed:files`, as staging runs
 * them. Maya's bar POS shows the five tabs at the seed's totals, each on a hold Stripe placed (so none
 * reads as one that can't grow), Luis M.'s grown to $80.00 and Tariq A.'s at $100.00, the badges, the
 * three slips to enter with their photos, and "Song queue · 6".
 */
test("after a load, Maya's bar POS matches the seed: five tabs on their holds, three slips, Song queue · 6", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    execSync("pnpm exec tsx src/files/seed-files.ts", {
      cwd: "apps/api",
      stdio: "ignore",
      env: {
        ...process.env,
        DATABASE_URL: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
        S3_ENDPOINT: process.env["S3_ENDPOINT"] ?? "http://localhost:9000",
        S3_ACCESS_KEY_ID: process.env["S3_ACCESS_KEY_ID"] ?? "west4",
        S3_SECRET_ACCESS_KEY: process.env["S3_SECRET_ACCESS_KEY"] ?? "west4secret",
      },
    });
    await signInMayaAtTheBar(page, request, db);
    const list = page.getByRole("list", { name: "Bar tabs" });
    await expect(list.locator(".name")).toHaveText([
      "Hana K.",
      "Jess P.",
      "Luis M.",
      "Tariq A.",
      "Seat 6 · blue jacket",
    ]);
    await expect(list.locator(".amount")).toHaveText([
      "$43.55",
      "$32.66",
      "$63.15",
      "$86.01",
      "$13.07",
    ]);
    const row = (name: RegExp) => list.getByRole("listitem").filter({ hasText: name });
    await expect(row(/Hana K\./).locator(".badge")).toHaveText(["Cut off"]);
    await expect(
      row(/Tariq A\./)
        .locator(".badge")
        .first(),
    ).toContainText("Waiting for Andy");
    // Every hold is a real authorization that can grow: no "Hold · … left" on any tab.
    await expect(list).not.toContainText("left");
    const panel = page.getByRole("complementary");
    for (const [name, hold] of [
      [/Hana K\./, "Hold $50.00"],
      [/Jess P\./, "Hold $50.00"],
      [/Luis M\./, "Hold $80.00"],
      [/Tariq A\./, "Hold $100.00"],
      [/Seat 6/, "Hold $50.00"],
    ] as const) {
      await list.getByRole("button", { name }).click();
      await expect(panel).toContainText(hold);
    }
    await expect(page.getByRole("link", { name: "Song queue · 6" })).toBeVisible();

    // The three slips to enter, each with its photo in the object store.
    await page.goto("/tips");
    const slips = page.locator(".tips-to-enter .cards > li");
    await expect(slips.locator("strong")).toHaveText(["Dev S.", "Tom W.", "Ana R."]);
    for (let i = 0; i < 3; i++) await expect(slips.nth(i)).toContainText("Photo saved");
    await slips.nth(0).getByRole("button").click();
    const photo = page.getByRole("img", { name: "Photo of the signed slip" });
    await expect(photo).toBeVisible();
    await expect
      .poll(() => photo.evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  } finally {
    await db.end();
  }
});

test("the bar POS: five tabs, the rooms, Room 5's order accepted, and 86 on Hoegaarden", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    const tabs = page.getByRole("list", { name: "Bar tabs" }).locator(".name");
    await expect(tabs).toHaveText([
      "Hana K.",
      "Jess P.",
      "Luis M.",
      "Tariq A.",
      "Seat 6 · blue jacket",
    ]);
    const rooms = page.getByRole("list", { name: "Rooms" });
    await expect(rooms.getByRole("button", { name: /Room 12/ })).toContainText(
      "Opened 9:00 PM · 101 min · $235.67 room time",
    );
    await expect(rooms.getByRole("button", { name: /VIP room/ })).toContainText(
      "$295.83 room time",
    );
    await expect(rooms.getByRole("button", { name: /Room 9/ })).toContainText("$322.00 room time");
    await expect(page.getByRole("list", { name: "Bar tabs" })).toContainText("Waiting for Andy");
    await expect(page.getByRole("list", { name: "Bar tabs" })).toContainText("Cut off");

    // The two ringing room orders across the top.
    const orders = page.getByRole("list", { name: "Room orders waiting" }).getByRole("listitem");
    await expect(orders).toHaveCount(2);
    // Oldest first: Room 5 at 2:11 (amber), then Room 9 at 0:43.
    await expect(orders.nth(0)).toContainText("Room 5 Ringing · 2:1");
    await expect(orders.nth(0)).toHaveClass(/amber/);
    await expect(orders.nth(1)).toContainText("Room 9 Ringing · 0:4");
    await expect(page.getByRole("button", { name: "Ask the room to wait" }).first()).toBeVisible();
    const tickets = async () =>
      (await db.query("select count(*)::int as n from print_jobs where kind = 'ticket'")).rows[0].n;
    const ticketsBefore = await tickets();
    await orders.nth(0).getByRole("button", { name: "Accept · print ticket" }).click();
    await expect(orders).toHaveCount(1);
    expect(await tickets()).toBe(ticketsBefore + 1);
    await page.getByRole("button", { name: /^Room 5/ }).click();
    await expect(page.getByRole("complementary")).toContainText("$72.00");

    // 86: Hoegaarden is out tonight in the seed; back on, then 86'd again, in the same slot.
    await page.getByRole("tab", { name: "Beer" }).click();
    const grid = page.getByRole("list", { name: "Beer" }).locator("li");
    // The grid's geometry: 25 slots, five across, each at least 115 × 100 px.
    const boxes = await grid.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: r.width, h: r.height };
      }),
    );
    expect(boxes).toHaveLength(25);
    for (const b of boxes) {
      expect(b.w).toBeGreaterThanOrEqual(115);
      expect(b.h).toBeGreaterThanOrEqual(100);
    }
    expect(new Set(boxes.map((b) => b.x)).size).toBe(5);
    expect(new Set(boxes.map((b) => b.y)).size).toBe(5);
    const before = await grid.allInnerTexts();
    await expect(page.getByRole("button", { name: "Hoegaarden · 86'd tonight" })).toBeDisabled();
    await page.getByRole("button", { name: "86", exact: true }).click();
    await page.getByRole("button", { name: "Hoegaarden · 86'd tonight" }).click();
    await expect(page.getByRole("button", { name: /^Hoegaarden · \$/ })).toBeEnabled();
    await page.getByRole("button", { name: "86", exact: true }).click();
    await page.getByRole("button", { name: /^Hoegaarden · \$/ }).click();
    await expect(page.getByRole("button", { name: "Hoegaarden · 86'd tonight" })).toBeDisabled();
    expect(await grid.allInnerTexts()).toEqual(before);
    const guest = await (
      await request.get("http://127.0.0.1:3000/v1/public/venues/west4karaoke/menu")
    ).json();
    const hoe = guest.categories
      .flatMap((c: { items: { name: string; out_tonight: boolean }[] }) => c.items)
      .find((i: { name: string }) => i.name === "Hoegaarden");
    expect(hoe.out_tonight).toBe(true);
    await expect(page.locator("body")).not.toContainText(/\bHold\b(?! \$)/);
  } finally {
    await db.end();
  }
});

/**
 * Ringing a round on the bar POS (M6-03): another round on Jess P.'s tab in
 * two taps under 3 seconds; a margarita with no flavor holds Send back and
 * names it; Undo takes back the last tap with no "are you sure?".
 */
test("the bar POS: Repeat round and Send on Jess P.'s tab under 3 s, a margarita's flavor, and Undo", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    await page
      .getByRole("list", { name: "Bar tabs" })
      .getByRole("button", { name: /Jess P\./ })
      .click();
    const panel = page.getByRole("complementary");
    await expect(panel).toContainText("$32.66");

    const started = Date.now();
    await panel.getByRole("button", { name: "Repeat round" }).click();
    await panel.getByRole("button", { name: "Send 3 to the bar" }).click();
    await expect(panel.locator(".total")).toContainText("$65.33");
    timedTask("Another round on a tab", 2, Date.now() - started, 3000);

    // A margarita has no usual flavor: Send waits and says what's missing.
    await page.getByRole("tab", { name: "Cocktails" }).click();
    await page.getByRole("button", { name: /^Margarita · \$/ }).click();
    await expect(panel.getByRole("button", { name: "Pick flavor for Margarita" })).toBeDisabled();
    await panel.getByLabel("Margarita · Flavor").selectOption({ label: "Peach" });
    await expect(panel.getByRole("button", { name: "Send 1 to the bar" })).toBeEnabled();

    // Undo, step by step: the flavor, then the margarita.
    await panel.getByRole("button", { name: "Undo" }).click();
    await expect(panel.getByRole("button", { name: "Pick flavor for Margarita" })).toBeVisible();
    await panel.getByRole("button", { name: "Undo" }).click();
    await expect(panel.getByRole("button", { name: /^Send/ })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /^Pick/ })).toHaveCount(0);
  } finally {
    await db.end();
  }
});

/**
 * Send the singer a drink (M6-24; D64): from Tariq A.'s tab, a Modelo for Jess P. rings the bar on
 * Tariq's tab with the ID reminder; one for Hana K. is refused with her cut-off in words.
 */
test("the bar POS: Tariq A. sends Jess P. a Modelo, and Hana K.'s cut-off refuses one", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    await page
      .getByRole("list", { name: "Bar tabs" })
      .getByRole("button", { name: /Tariq A\./ })
      .click();
    const panel = page.getByRole("complementary");
    await page.getByRole("button", { name: /^Modelo · \$/ }).click();
    await panel.getByLabel("Send the singer a drink").selectOption({ label: "Jess P." });
    await panel.getByRole("button", { name: "Send 1 to Jess P." }).click();
    await expect(panel.getByRole("status")).toContainText(
      "Sent · Jess P.'s drink is on this tab · check their ID at hand-off",
    );
    const gifts = await db.query(
      `select o.id from orders o join tabs t on t.check_id = o.check_id
        where o.source = 'gift' and t.name = 'Tariq A.'`,
    );
    expect(gifts.rowCount).toBe(1);

    await page.getByRole("button", { name: /^Modelo · \$/ }).click();
    await panel.getByLabel("Send the singer a drink").selectOption({ label: "Hana K." });
    await panel.getByRole("button", { name: "Send 1 to Hana K." }).click();
    await expect(panel.getByRole("alert")).toContainText(
      "No alcohol for Hana K. · Cut off by Andy at 10:30 PM",
    );
  } finally {
    await db.end();
  }
});

/**
 * Moves on the bar POS (M6-13; Rail notes 7 and 8): the fix panel's Move greys out Hana K.'s cut-off tab
 * for 2 × Modelo, with the reason; Move tab to a room puts Jess P.'s drinks on Room 9's check as "Moved
 * from Jess P.'s bar tab" and her tab reads "Moved to Room 9" in Closed tonight.
 */
test("the bar POS: Move greys out Hana K.'s cut-off tab, and Jess P.'s tab moves into Room 9", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    await page
      .getByRole("list", { name: "Bar tabs" })
      .getByRole("button", { name: /Jess P\./ })
      .click();
    const panel = page.getByRole("complementary");
    await expect(panel).toContainText("$32.66");

    await panel.getByRole("button", { name: "Fix · Modelo" }).click();
    await panel.getByRole("button", { name: "MOVE · onto another tab" }).click();
    await expect(panel.getByRole("radio", { name: /Hana K\./ })).toBeDisabled();
    await expect(panel).toContainText("Cut off by Andy · alcohol can't move here");
    await expect(panel.getByRole("radio", { name: /Luis M\./ })).toBeEnabled();

    await panel.getByRole("button", { name: "Move tab to a room" }).click();
    await panel.getByRole("button", { name: /Room 9/ }).click();
    // The rail picks Room 9, with Jess P.'s drinks on its check.
    await expect(panel.getByRole("status").first()).toContainText("Moved to Room 9");
    await expect(page.getByRole("list", { name: "Bar tabs" })).not.toContainText("Jess P.");
    await expect(panel.getByRole("list", { name: "On the tab" })).toContainText(
      "Moved from Jess P.'s bar tab",
    );
    await expect(panel.getByRole("list", { name: "On the tab" })).toContainText("2 × Modelo");
    await page.getByText(/^Closed tonight/).click();
    await expect(page.locator(".closed-tab", { hasText: "Jess P." })).toContainText(
      "Moved to Room 9",
    );
  } finally {
    await db.end();
  }
});

/** The desktop app's bridge as the bar computer has it, with a badge reader the test taps (M6-04). */
const desktopBridge = () => {
  const tokenKey = "west4.test.token";
  const w = window as unknown as Record<string, unknown>;
  w["west4"] = {
    desktop: true,
    version: async () => "test",
    token: {
      get: async () => sessionStorage.getItem(tokenKey),
      set: async (v: string) => sessionStorage.setItem(tokenKey, v),
      clear: async () => sessionStorage.removeItem(tokenKey),
    },
    readers: async () => [],
    badge: {
      onTap: (listener: (tap: { url: string; reader: string }) => void) => {
        const taps = ((w["__badgeTaps"] as unknown[]) ??= []) as unknown[];
        taps.push(listener);
        return () => taps.splice(taps.indexOf(listener), 1);
      },
      onReaders: () => () => undefined,
      pairStart: async () => ({ uid: "" }),
      pairFinish: async () => ({ uid: "", url: "" }),
      cancelPair: async () => undefined,
      fakeTap: async () => undefined,
    },
    venue: { configure: async () => undefined },
  };
};

/**
 * Sharing the bar computer (M6-04): Maya's badge takes over from Diego in under
 * 2 seconds with her three tabs and none of his unsent drinks; "Maya · on break"
 * while her break punch is open; Wipe screen ignores touches for 10 seconds;
 * three idle minutes lock the screen; with the front desk's bar POS switched
 * off, Diego's sign-in shows no Bar POS.
 */
test("sharing the bar computer: Maya's badge takes over from Diego, on break, Wipe screen and the idle lock", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const { FakeBadge } = await import("../apps/api/src/auth/test-badge.js");
  const { LOCAL_DEV_AUTH_KEY, parseAuthSecretKey } = await import("../packages/db/src/auth.js");
  const db = await dbClient();
  try {
    await db.query("update memberships set locale = 'en'");
    const venueId = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    const maya = (
      await db.query<{ id: string }>(
        "select m.id from memberships m join users u on u.id = m.user_id where u.name = 'Maya S.'",
      )
    ).rows[0]!.id;
    await db.query(
      "insert into time_punches (venue_id, membership_id, kind, duty, at) values ($1, $2, 'break_start', 'bar', '2026-09-25T22:35:00-04:00')",
      [venueId, maya],
    );
    await page.clock.install();
    await page.addInitScript(desktopBridge);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page
      .getByLabel("Pairing code from Admin → Devices")
      .fill(await pairingCode(db, "bar_computer", "Bar computer"));
    expect(
      (await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })).ok(),
    ).toBe(true);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.getByRole("button", { name: /Diego R\./ }).click();
    await typePin(page, "6358");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await page.getByRole("link", { name: "Bar POS" }).first().click();
    await expect(page.locator(".rail-top .who")).toHaveText("Diego R.");

    // Maya's badge: the reader hands over a tap; she's on the screen within 2 seconds.
    const badge = new FakeBadge({
      secret: parseAuthSecretKey(LOCAL_DEV_AUTH_KEY),
      venueId,
      badgeId: "badge_maya",
    });
    const tap = badge.tap();
    const started = Date.now();
    await page.evaluate((url) => {
      const taps = (
        window as unknown as { __badgeTaps: ((t: { url: string; reader: string }) => void)[] }
      ).__badgeTaps;
      for (const listener of [...taps]) listener({ url, reader: "test" });
    }, `https://w4.example/t?e=${tap.picc_data}&c=${tap.cmac}`);
    await expect(page.locator(".rail-top .who")).toHaveText("Maya · on break");
    timedTask("Take over the terminal", 1, Date.now() - started, 2000);
    await page.getByRole("button", { name: "Mine", exact: true }).click();
    await expect(page.getByRole("list", { name: "Bar tabs" }).locator(".name")).toHaveText([
      "Hana K.",
      "Jess P.",
      "Luis M.",
    ]);
    // Diego's unsent Red Bull stays his: Maya sees "1 not sent" on Tariq A.'s row, and no round of her own.
    await page.getByRole("button", { name: "All", exact: true }).click();
    const tariq = page
      .getByRole("list", { name: "Bar tabs" })
      .getByRole("button", { name: /Tariq A\./ });
    await expect(tariq).toContainText("1 not sent");
    await tariq.click();
    await expect(
      page.getByRole("complementary").getByRole("button", { name: /^Send/ }),
    ).toHaveCount(0);

    // Wipe screen: touch is off for 10 seconds.
    await page.getByRole("button", { name: "Wipe screen" }).click();
    await expect(page.getByText("Wiping · touch is off for 10 s")).toBeVisible();
    await page.mouse.click(200, 400);
    await page.clock.runFor(10_500);
    await expect(page.locator(".wipe-overlay")).toHaveCount(0);

    // Three idle minutes lock the screen.
    await page.clock.runFor(3 * 60_000 + 2_000);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");

    // With the front desk's bar POS switched off, Diego sees no Bar POS.
    // Admin → Team's switch: an override on top of the role's defaults.
    await db.query(
      `insert into role_permissions (venue_id, role, action, allowed) values ($1, 'front_desk', 'pos.use', false)
       on conflict (venue_id, role, action) do update set allowed = false`,
      [venueId],
    );
    await page.getByRole("button", { name: /Diego R\./ }).click();
    await typePin(page, "6358");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await expect(page.getByRole("link", { name: "Bar POS" })).toHaveCount(0);
  } finally {
    await db.end();
  }
});

/**
 * Quick sale (M6-05): a walk-up Bud Light in cash in three taps (the beer,
 * Pay, the bill handed over) under 8 seconds, logged to Maya's bar drawer;
 * a $9.00 sale shows the reader's $1, $2 and $3; the next drink starts the
 * next sale.
 */
test("Quick sale: a walk-up Bud Light in cash in three taps, logged to Maya · bar drawer", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    // The newly paired bar computer opens the bar drawer, as Admin → Devices pairs it.
    await db.query(
      `update devices set cash_drawer_id = (select id from cash_drawers where station = 'bar' limit 1)
        where kind = 'bar_computer' and cash_drawer_id is null`,
    );
    await page.getByRole("tab", { name: "Beer" }).click();
    const panel = page.getByRole("complementary");
    const started = Date.now();
    await page.getByRole("button", { name: /^Bud Light · \$/ }).click();
    await panel.getByRole("button", { name: "Pay for 1" }).click();
    await panel
      .getByRole("group", { name: /handed over/i })
      .getByRole("button", { name: "$10.00" })
      .click();
    await expect(panel).toContainText("Logged to Maya · bar drawer");
    timedTask("A walk-up beer, paid in cash", 3, Date.now() - started, 8000);
    await expect(panel.getByRole("button", { name: "Text" })).toBeVisible();

    // The next drink starts the next sale: a $9.00 Modelo, whose reader offers $1, $2 and $3.
    await page.getByRole("button", { name: /^Modelo · \$/ }).click();
    await panel.getByRole("button", { name: "Pay for 1" }).click();
    await expect(panel).toContainText("The reader offers $1.00, $2.00, $3.00 as a tip.");
    // Back to the sale: voided, and the Modelo is back in the round.
    await panel.getByRole("button", { name: "Back to the sale" }).click();
    await expect(panel.getByRole("button", { name: "Pay for 1" })).toBeVisible();
  } finally {
    await db.end();
  }
});

/**
 * The song queue on the bar POS (M6-18; the M6-05 line): the top bar reads "Song queue · 6" from the
 * seed's queue, and picking Kira on a Bud Light paid in cash at the bar gives her one credit.
 */
test("Song queue · 6 on the bar POS, and picking Kira on a drink bought at the bar gives her a credit", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    await expect(page.getByText("Song queue · 6")).toBeVisible();
    const kira = async () =>
      Number(
        (
          await db.query<{ n: string }>(
            `select count(*) as n from song_credits k join singers s on s.id = k.singer_id
              where s.display_name = 'Kira' and k.used_at is null and k.forfeited_at is null`,
          )
        ).rows[0]!.n,
      );
    expect(await kira()).toBe(1);
    await page.getByRole("tab", { name: "Beer" }).click();
    const panel = page.getByRole("complementary");
    await page.getByRole("button", { name: /^Bud Light · \$/ }).click();
    await panel.getByRole("button", { name: "Pay for 1" }).click();
    await panel
      .getByRole("group", { name: /handed over/i })
      .getByRole("button", { name: "$10.00" })
      .click();
    const credit = panel.getByRole("region", { name: "Song credit for" });
    await credit.getByRole("button", { name: "Kira", exact: true }).click();
    await expect(credit.getByRole("status")).toContainText("Song credit for Kira");
    await expect.poll(kira).toBe(2);
  } finally {
    await db.end();
  }
});

/**
 * Started and Skip (M6-19): Maya taps Started on Jess P.'s song (Luis M. is sung), which puts a $0.00
 * "Dancing Queen · ABBA" line on her tab and writes the play log, and skips Kira's, free; the bar POS's
 * "Song queue" count follows each change (a browser has no event socket with a bearer token, so it reloads).
 */
test("Started and Skip: Jess P.'s $0.00 song line and the play log, Kira skipped, the count follows", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    await expect(page.getByText("Song queue · 6")).toBeVisible();
    const v = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    const song = async (slug: string) =>
      (
        await db.query<{ id: string }>(
          "select row_id as id from seed_ids where venue_id = $1 and slug = $2",
          [v, slug],
        )
      ).rows[0]!.id;
    // What the KJ screen's Started and Skip will send (M6-22), from the signed-in bar screen.
    const tap = (path: string, key: string) =>
      page.evaluate(
        async ([p, k]) => {
          const token = sessionStorage.getItem("west4.staff.token");
          const r = await fetch(p!, {
            method: "POST",
            headers: {
              "idempotency-key": k!,
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
          });
          return { status: r.status, body: await r.text() };
        },
        [path, key],
      );
    const started = await tap(
      `/v1/venues/${v}/song-queue/${await song("song_sg_jess")}/start`,
      `e2e-start-jess-${Date.now()}`,
    );
    expect(started.status, started.body).toBe(200);
    await page.reload();
    await expect(page.getByText("Song queue · 5")).toBeVisible();
    const line = await db.query<{ amount_cents: string; tax_category: string }>(
      `select l.amount_cents, l.tax_category from check_lines l join tabs t on t.check_id = l.check_id
        where t.name = 'Jess P.' and l.description = 'Dancing Queen · ABBA'`,
    );
    expect(line.rows).toEqual([{ amount_cents: "0", tax_category: "song" }]);
    const plays = await db.query<{ title: string }>(
      "select title from song_plays where business_date = '2026-09-25' order by started_at",
    );
    expect(plays.rows.map((r) => r.title)).toEqual(["Mr. Brightside", "Dancing Queen"]);
    const skipped = await tap(
      `/v1/venues/${v}/song-queue/${await song("song_sg_kira")}/skip`,
      `e2e-skip-kira-${Date.now()}`,
    );
    expect(skipped.status, skipped.body).toBe(200);
    await page.reload();
    await expect(page.getByText("Song queue · 4")).toBeVisible();
  } finally {
    await db.end();
  }
});

/**
 * Singer alerts (M6-21): Ben T. signs in on the queue page and taps "Alert me on this phone" (the browser's
 * permission and push subscription are stubbed: a headless browser has no push service), which plans "2 singers before you"
 * for his song at once. Maya starts Jess P.'s song and then Kira's: Ben T.'s open page reads "You're up next
 * at the bar · come to the stage", the up-next push is planned once, and the You're up next text with it.
 */
test("Singer alerts: Ben T. turns alerts on, and Kira's start makes him up next by push and text", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    const v = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    const song = async (slug: string) =>
      (
        await db.query<{ id: string }>(
          "select row_id as id from seed_ids where venue_id = $1 and slug = $2",
          [v, slug],
        )
      ).rows[0]!.id;
    const ben = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ben.grantPermissions(["notifications"], { origin: "http://localhost:3001" });
    await ben.addInitScript(() => {
      const fake = {
        endpoint: "https://push.example.test/send/ben-e2e",
        toJSON: () => ({
          endpoint: "https://push.example.test/send/ben-e2e",
          keys: { p256dh: "BPk3-e2e", auth: "a1-e2e" },
        }),
      };
      let subscribed = false;
      // Headless Chromium answers "denied" whatever the grant: the phone says yes here.
      Object.defineProperty(Notification, "permission", { get: () => "granted" });
      Notification.requestPermission = async () => "granted";
      PushManager.prototype.subscribe = async function () {
        subscribed = true;
        return fake as unknown as PushSubscription;
      };
      PushManager.prototype.getSubscription = async function () {
        return (subscribed ? fake : null) as unknown as PushSubscription;
      };
    });
    const phone = await ben.newPage();
    await phone.goto("http://localhost:3001/v/west4karaoke/sing");
    await phone.getByLabel("Your name on the TV").fill("Ben");
    await phone.getByLabel("Mobile number").fill("(646) 555-0163");
    await phone.getByRole("button", { name: "Text me a code" }).click();
    await expect
      .poll(
        async () =>
          (
            await db.query("select 1 from jobs where kind = 'text.send' and payload->>'to' = $1", [
              "+16465550163",
            ])
          ).rowCount,
      )
      .toBeGreaterThan(0);
    const code = (
      await db.query<{ code: string }>(
        `select payload->'data'->>'code' as code from jobs where kind = 'text.send'
           and payload->>'to' = '+16465550163' order by created_at desc limit 1`,
      )
    ).rows[0]!.code;
    await phone.getByLabel("The code we texted you").fill(code);
    await phone.getByRole("button", { name: "Confirm" }).click();
    await expect(phone.getByRole("status")).toHaveText("2 singers before you");
    await phone.getByRole("button", { name: "Alert me on this phone" }).click();
    await expect(phone.getByText("Alerts are on for this phone.")).toBeVisible();
    const benSong = await song("song_sg_ben");
    const planned = async () =>
      (
        await db.query<{ dedupe_key: string }>(
          "select dedupe_key from jobs where dedupe_key like $1 order by dedupe_key",
          [`%${benSong}`],
        )
      ).rows.map((r) => r.dedupe_key);
    expect(await planned()).toEqual([`singer-alert:before:${benSong}`]);
    const tap = (path: string, key: string) =>
      page.evaluate(
        async ([p, k]) => {
          const token = sessionStorage.getItem("west4.staff.token");
          const r = await fetch(p!, {
            method: "POST",
            headers: {
              "idempotency-key": k!,
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
          });
          return { status: r.status, body: await r.text() };
        },
        [path, key],
      );
    for (const who of ["song_sg_jess", "song_sg_kira"]) {
      const r = await tap(
        `/v1/venues/${v}/song-queue/${await song(who)}/start`,
        `e2e-alerts-${who}-${Date.now()}`,
      );
      expect(r.status, r.body).toBe(200);
    }
    // The open page shows the alert: on the live channel, or at the latest on its 15-second refresh.
    await expect(phone.getByRole("status")).toHaveText(
      "You're up next at the bar · come to the stage",
      { timeout: 20_000 },
    );
    expect(await planned()).toEqual([
      `singer-alert:before:${benSong}`,
      `singer-alert:up_next:${benSong}`,
      `text:up_next:${benSong}`,
    ]);
    await ben.close();
  } finally {
    await db.end();
  }
});

/**
 * New tab, card first (M6-06): a tapped phone opens in four taps (New tab, Read to guest ✓, a
 * label, Open) in under 20 seconds with the consent line on screen, as a $50.00 authorization with
 * incremental support; Jess P.'s Visa ··4417 at New tab opens her tab with no second hold; and with
 * the bar computer offline, New tab is greyed out with the reason.
 */
test("New tab: a tapped phone in four taps, Jess P.'s ··4417 opens her tab, none offline", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await signInMayaAtTheBar(page, request, db);
    const tap = async (number: string, extra: Record<string, string> = {}) => {
      const ids = (
        await db.query<{ reader: string; account: string }>(
          `select d.stripe_reader_id as reader, o.stripe_account_id as account
             from devices d join venues v on v.id = d.venue_id join organizations o on o.id = v.org_id
            where d.name = 'Bar S710' and not d.sandbox`,
        )
      ).rows[0]!;
      // The guest taps once the reader is asking.
      await expect
        .poll(async () => {
          const r = await request.get(`http://127.0.0.1:12111/v1/terminal/readers/${ids.reader}`, {
            headers: {
              authorization: "Bearer rk_test_fake_payments",
              "stripe-account": ids.account,
            },
          });
          return ((await r.json()) as { action?: { status?: string } }).action?.status;
        })
        .toBe("in_progress");
      const r = await request.post(
        `http://127.0.0.1:12111/v1/test_helpers/terminal/readers/${ids.reader}/present_payment_method`,
        {
          headers: {
            authorization: "Bearer rk_test_fake_payments",
            "stripe-account": ids.account,
            "idempotency-key": `e2e-present-${Date.now()}-${Math.random()}`,
          },
          form: { "card_present[number]": number, ...extra },
        },
      );
      expect(r.ok(), await r.text()).toBe(true);
      return ids;
    };
    const panel = page.getByRole("complementary");

    // Four taps, the guest's phone tapped while the bartender picks a label.
    const started = Date.now();
    await page.getByRole("button", { name: "New tab" }).click();
    await expect(panel.locator(".consent")).toHaveText(
      "We'll hold $50 on this card and add to it as you order. We charge your tab when you close out, or at 4:30 AM if it's still open. Add your tip on the reader.",
    );
    await panel.getByRole("button", { name: "Read to guest ✓" }).click();
    const ids = await tap("4242424242424242", { "card_present[wallet]": "true" });
    await panel.getByRole("button", { name: "Seat 2" }).click();
    await panel.getByRole("button", { name: "Open", exact: true }).click();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Seat 2");
    timedTask("Open a tab for a tapped phone", 4, Date.now() - started, 20_000);
    await expect(panel).toContainText("Visa ··4242");
    await expect(panel).toContainText("Hold $50.00");
    await expect(page.getByRole("list", { name: "Bar tabs" }).locator(".name")).toContainText([
      "Seat 2",
    ]);
    const held = (
      await db.query<{ pi: string; read_by: string }>(
        `select p.stripe_pi_id as pi, u.name as read_by from tabs t
           join payments p on p.id = t.payment_id join users u on u.id = t.consent_read_by
          where t.name = 'Seat 2'`,
      )
    ).rows[0]!;
    expect(held.read_by).toMatch(/^Maya/);
    const pi = await (
      await request.get(`http://127.0.0.1:12111/v1/payment_intents/${held.pi}`, {
        headers: { authorization: "Bearer rk_test_fake_payments", "stripe-account": ids.account },
        params: { "expand[]": "latest_charge" },
      })
    ).json();
    expect(pi).toMatchObject({ status: "requires_capture", amount_capturable: 5000 });
    expect(pi.latest_charge.payment_method_details.card_present).toMatchObject({
      incremental_authorization_supported: true,
    });

    // Jess P.'s Visa ··4417, which her tab already holds: her tab opens, and nothing new is held.
    await db.query(
      "update tabs set card_fingerprint = $1 where id = (select row_id from seed_ids where slug = 'tab_t1')",
      [fakeFingerprint("4000000000004417")],
    );
    const holds = async () =>
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from payments where status = 'authorized'",
        )
      ).rows[0]!.n;
    const before = await holds();
    await page.getByRole("button", { name: "New tab" }).click();
    await panel.getByRole("button", { name: "Read to guest ✓" }).click();
    await tap("4000000000004417");
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Jess P.");
    await expect(panel).toContainText(
      "Jess P.'s tab is already open on this card. One card, one open tab, so nothing new was held on it.",
    );
    expect(await holds()).toBe(before);

    // The bar computer offline: New tab greyed out, with the reason.
    await page.context().setOffline(true);
    await expect(page.getByRole("button", { name: "New tab" })).toBeDisabled();
    await expect(page.getByRole("navigation", { name: "Tabs and rooms" })).toContainText(
      "No new tabs while the bar computer is offline.",
    );
    await page.context().setOffline(false);
    await expect(page.getByRole("button", { name: "New tab" })).toBeEnabled();
  } finally {
    await db.end();
  }
});

/**
 * Tips to enter on Andy's phone (M6-09; screens N26): the seed's three signed slips, each with its photo
 * and never Jess P.'s Visa ··4417; Ana R.'s $12.00 tip on $62.50 captures $74.50 on her held card; a
 * $20.00 tip on Dev S.'s $48.00 is over 25%, and since Andy typed it in himself it goes to Abhishek.
 */
test("Tips to enter on Andy's phone: Ana R.'s $12.00 captures $74.50; his own $20.00 on Dev S. goes to Abhishek", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndy(page, request, db);
    await page.locator(".tabs").getByRole("link", { name: "Tips to enter" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tips to enter");
    const slips = page.locator(".tips-to-enter .cards > li");
    await expect(slips).toHaveCount(3);
    await expect(slips.locator("strong")).toHaveText(["Dev S.", "Tom W.", "Ana R."]);
    await expect(slips.nth(0)).toContainText("Visa ··3318");
    await expect(slips.nth(1)).toContainText("Mastercard ··0457");
    await expect(slips.nth(2)).toContainText("Amex ··2204");
    for (let i = 0; i < 3; i++) await expect(slips.nth(i)).toContainText("Photo saved");
    await expect(page.locator(".tips-to-enter")).not.toContainText("4417");

    // Ana R.: the photo is already with the slip; $12.00 on $62.50 needs no approval.
    await slips.nth(2).getByRole("button").click();
    await page.getByLabel("Tip from the slip ($)").fill("12");
    await page.getByRole("button", { name: "Enter tip" }).click();
    await expect(page.getByRole("status")).toContainText("Paid $74.50 with a tip of $12.00");
    await expect(slips.locator("strong")).toHaveText(["Dev S.", "Tom W."]);

    // Dev S.: $20.00 on $48.00 is over 25%; Andy typed it, so it waits for Abhishek.
    await slips.nth(0).getByRole("button").click();
    await page.getByLabel("Tip from the slip ($)").fill("20.00");
    await page.getByRole("button", { name: "Enter tip" }).click();
    await expect(page.getByRole("status")).toContainText("Sent to Abhishek G. to approve");
    await expect(slips.nth(0)).toContainText("Waiting for Abhishek G.");
    // Nothing clipped at the phone's width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  } finally {
    await db.end();
  }
});

/**
 * cut_off_hana (M6-14; screens N16, Rail note 9): Hana K.'s tab reads "Cut off by Andy at 10:30 PM" on
 * the bar POS and its alcohol greys out with the reason; Maya cuts off Luis M.'s tab with a reason and it
 * reads "Cut off by Maya at 10:41 PM".
 */
test("the bar POS: Hana K.'s cut-off tab greys alcohol, and Maya cuts off Luis M.", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    const tabs = page.getByRole("list", { name: "Bar tabs" });
    await tabs.getByRole("button", { name: /Hana K\./ }).click();
    const panel = page.getByRole("complementary");
    await expect(panel).toContainText("Cut off by Andy at 10:30 PM");
    await expect(
      page.getByRole("button", { name: "Modelo · No alcohol · this tab is cut off" }),
    ).toBeDisabled();
    await expect(panel.getByRole("button", { name: "No more alcohol on this tab" })).toHaveCount(0);

    await tabs.getByRole("button", { name: /Luis M\./ }).click();
    await expect(page.getByRole("button", { name: /^Modelo · \$/ })).toBeEnabled();
    await panel.getByRole("button", { name: "No more alcohol on this tab" }).click();
    await panel.getByLabel("Why is this tab cut off?").fill("Too drunk");
    await panel.getByRole("button", { name: "Cut off", exact: true }).click();
    await expect(panel).toContainText("Cut off by Maya at 10:4");
    await expect(
      page.getByRole("button", { name: "Modelo · No alcohol · this tab is cut off" }),
    ).toBeDisabled();
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * alcohol_stop (M6-14; Rail note 9): at 4:02 AM every alcohol button on the bar POS greys out with the
 * reason in words, a Red Bull doesn't, and the room-order cards offer no Decline and list "Cancelled at
 * 4:00 AM".
 */
test("the bar POS at 4:02 AM: alcohol greyed with the reason, no Decline, Cancelled at 4:00 AM", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    // Signed in at 4:02 AM itself: moving the clock five hours on would end a session as idle.
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page
      .getByLabel("Pairing code from Admin → Devices")
      .fill(await pairingCode(db, "bar_computer", "Bar computer"));
    await setClock(request, "2026-09-26T08:02:00Z");
    // The stop has cancelled o1 (the worker's sweep, which the smoke run doesn't start); o2 still waits.
    await db.query(
      `update orders set status = 'cancelled', cancel_reason = 'alcohol_closed', cancelled_at = '2026-09-26T04:00:00-04:00'
        where id = (select row_id from seed_ids where slug = 'order_o1')`,
    );
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.getByRole("button", { name: /Maya S\./ }).click();
    await typePin(page, "4071");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");
    await expect(
      page.getByRole("button", { name: "Modelo · No alcohol now · the window has closed" }),
    ).toBeDisabled();
    const grid = page.getByRole("list", { name: "Beer" });
    for (const label of await grid
      .getByRole("button")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? "")))
      expect(label).toMatch(/No alcohol now · the window has closed$/);
    const orders = page.getByRole("list", { name: "Room orders waiting" });
    await expect(orders.getByRole("button", { name: "Decline…" })).toHaveCount(0);
    await expect(orders.locator(".rail-order", { hasText: "Room 9" })).toContainText(
      "Cancelled at 4:00 AM",
    );
  } finally {
    await db.end();
  }
});

/**
 * Fix a sent drink on the bar POS (M6-15; spec 10 · Changing a sent drink; Rail note 4): Maya's panel
 * shows "$63 left this shift"; a $13.00 comp of Room 9's Margarita leaves $50; voiding Jess P.'s Jäger
 * Bomb rung by mistake takes 4 taps (the line, Not made, a reason, VOID) in under 6 seconds.
 */
test("the bar POS: Maya's fix panel, $63 then $50 left, and a void in 4 taps under 6 s", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    await page
      .getByRole("list", { name: "Room orders waiting" })
      .getByRole("listitem", { name: "Room 9" })
      .getByRole("button", { name: "Accept · print ticket" })
      .click();
    const panel = page.getByRole("complementary");
    const fix = panel.getByRole("region", { name: "Fix a sent drink" });

    await page
      .getByRole("list", { name: "Rooms" })
      .getByRole("button", { name: /Room 9/ })
      .click();
    await expect(fix).toContainText("$63.00 left this shift");
    await panel.getByRole("button", { name: "Fix · Margarita · Peach" }).click();
    await fix.getByLabel("How many").fill("1");
    await fix.getByRole("button", { name: "Spilled or dropped" }).click();
    await fix.getByRole("button", { name: "COMP · the house pays for it" }).click();
    await expect(fix.getByRole("status")).toHaveText("Comped: Margarita · Peach");
    await expect(fix).toContainText("$50.00 left this shift");
    await expect(panel.getByRole("list", { name: "On the tab" })).toContainText(
      "COMP · Margarita · Peach",
    );

    await page
      .getByRole("list", { name: "Bar tabs" })
      .getByRole("button", { name: /Jess P\./ })
      .click();
    await expect(panel).toContainText("$32.66");
    const started = Date.now();
    await panel.getByRole("button", { name: "Fix · Jäger Bomb" }).click();
    await fix.getByLabel("Not made").check();
    await fix.getByRole("button", { name: "Rang it wrong" }).click();
    await fix.getByRole("button", { name: "VOID · take the sale back" }).click();
    await expect(fix.getByRole("status")).toHaveText("Voided: Jäger Bomb");
    timedTask("Void a drink rung by mistake", 4, Date.now() - started, 6000);
    await expect(panel.getByRole("list", { name: "On the tab" })).toContainText(
      "VOID · Jäger Bomb",
    );
    await expect(panel.locator(".total")).toContainText("$19.60");
    await expect(fix).toContainText("$38.00 left this shift");
    const reason = await db.query<{ reason: string; made: boolean }>(
      "select reason, made from check_lines where kind = 'void' and description = 'VOID · Jäger Bomb'",
    );
    expect(reason.rows).toEqual([{ reason: "Rang it wrong", made: false }]);
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * Diego's void of the Large bucket ($70.00) on Tariq A.'s tab is over the $25 limit (M6-15; Rail note
 * 4): the line and the tab row read "Waiting for Andy" until Andy approves on his own phone, and the bar
 * POS follows on its own: $9.00 of drinks, $0.80 tax, $9.80.
 */
test("the bar POS: Tariq A.'s void waits for Andy on the line and the tab row, then reads $9.80", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    const tabs = page.getByRole("list", { name: "Bar tabs" });
    const row = tabs.locator("li", { hasText: "Tariq A." });
    await expect(row).toContainText("Waiting for Andy");
    await tabs.getByRole("button", { name: /Tariq A\./ }).click();
    const panel = page.getByRole("complementary");
    const onTab = panel.getByRole("list", { name: "On the tab" });
    await expect(onTab.locator("li", { hasText: "Large bucket" })).toContainText(
      "Waiting for Andy",
    );
    await expect(panel.getByRole("button", { name: "Fix · Large bucket · 10 beers" })).toHaveCount(
      0,
    );
    await expect(panel.locator(".total")).toContainText("$86.01");

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const andy = await phone.newPage();
      // Andy's own phone: a staff phone with alerts on, so Approve is signed with its key.
      await andy.addInitScript(() => {
        const fake = {
          endpoint: "https://push.example.test/send/andy-tab-void",
          toJSON: () => ({
            endpoint: "https://push.example.test/send/andy-tab-void",
            keys: { p256dh: "fake-p256dh", auth: "fake-auth" },
          }),
          unsubscribe: async () => true,
        };
        let subscribed = false;
        PushManager.prototype.subscribe = async () => {
          subscribed = true;
          return fake as unknown as PushSubscription;
        };
        PushManager.prototype.getSubscription = async () =>
          (subscribed ? fake : null) as unknown as PushSubscription;
        Object.defineProperty(Notification, "permission", { get: () => "default" });
        Notification.requestPermission = async () => "granted";
      });
      await signInAndy(andy, phone.request, db);
      await andy.goto("/setup");
      await andy.getByRole("button", { name: "Turn on alerts" }).click();
      await expect(andy.getByRole("status")).toHaveText("Alerts are on");
      await andy.goto("/tonight");
      await andy.getByRole("link", { name: "Approvals" }).last().click();
      await expect(andy.getByRole("heading", { level: 1 })).toHaveText("Approvals · 1");
      await andy.getByRole("button", { name: "Approve" }).click();
      await expect(andy.getByRole("heading", { level: 1 })).toHaveText("Approvals · 0");
    } finally {
      await phone.close();
    }

    // A shared screen has no event socket and refetches every 15 s (M6-28); reload rather than wait.
    await page.reload();
    await tabs.getByRole("button", { name: /Tariq A\./ }).click();
    await expect(panel.locator(".total")).toContainText("$9.80");
    await expect(onTab).toContainText("VOID · Large bucket · 10 beers");
    await expect(row).not.toContainText("Waiting for Andy");
  } finally {
    await db.end();
  }
});

/**
 * Close the night's open bar tabs (M6-16; screens Night note 5): Andy sees the five tabs with their cards
 * and totals, Tariq A.'s waiting for him and skipped; Charge the remaining tabs asks once with 4 cards and
 * $152.43, then charges them, and only Tariq A.'s tab is left. The holds come from stripe:seed on the fake.
 */
for (const size of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`Close the night (${size.name}): Charge the remaining tabs shows 4 cards and $152.43 and skips Tariq A.'s`, async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const db = await dbClient();
    try {
      stripeSeed();
      await page.setViewportSize({ width: size.width, height: size.height });
      await signInAndy(page, request, db);
      await page.goto("/close-the-night");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Close the night");
      const list = page.locator(".night-tabs");
      await expect(list.locator("li")).toHaveCount(5);
      await expect(list.locator("li").nth(1)).toContainText("Jess P.");
      await expect(list.locator("li").nth(1)).toContainText("Visa ··4417");
      await expect(list.locator("li").nth(1)).toContainText("$32.66");
      await expect(list.locator("li").nth(3)).toContainText("Waiting for Andy");
      await expect(list.locator("li").nth(3)).toContainText("skipped until it's decided");
      await expect(page.getByText("Any tab still open is charged at 4:30 AM")).toBeVisible();

      await page.getByRole("button", { name: "Charge the remaining tabs" }).click();
      const confirm = page.getByRole("group", { name: "Charge the remaining tabs" });
      await expect(confirm).toContainText("Cards to charge: 4");
      await expect(confirm).toContainText("Altogether: $152.43");
      await expect(confirm).toContainText("Each at its balance, with no tip");
      await confirm.getByRole("button", { name: "Charge them" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Charging" })).toHaveText(
        "Charging 4 tabs · $152.43",
      );
      await expect(list.locator("li")).toHaveCount(1);
      await expect(list).toContainText("Tariq A.");
      await expect(page.getByRole("button", { name: "Charge the remaining tabs" })).toBeDisabled();
      const states = await db.query<{ name: string; state: string }>(
        "select name, state from tabs where state = 'walkout_captured' order by opened_at",
      );
      expect(states.rows.map((r) => r.name)).toEqual([
        "Hana K.",
        "Jess P.",
        "Luis M.",
        "Seat 6 · blue jacket",
      ]);
      // Nothing clipped sideways at this width.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    } finally {
      await db.end();
    }
  });
}

/**
 * Tabs whose capture failed (M6-17; screens Night note 12): Seat 6's hold is $10.00 with no overcapture and
 * its saved card declines, so Charge the remaining tabs leaves it capture_failed owing $3.07. It shows under
 * "Couldn't be charged" with what it owes, and taking the exact cash settles it: the tab is closed and the
 * list is empty.
 */
test("Close the night: a tab that couldn't be charged is settled in cash", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await db.query("update tabs set hold_cents = 1000 where name = 'Seat 6 · blue jacket'");
    await db.query(
      `update payments p set overcapture_supported = false, generated_card_pm = 'pm_card_chargeCustomerFail'
         from tabs t where t.payment_id = p.id and t.name = 'Seat 6 · blue jacket'`,
    );
    await signInAndy(page, request, db);
    await page.goto("/close-the-night");
    await page.getByRole("button", { name: "Charge the remaining tabs" }).click();
    await page
      .getByRole("group", { name: "Charge the remaining tabs" })
      .getByRole("button", { name: "Charge them" })
      .click();
    const failed = page.locator(".night-failed-tabs");
    await expect(page.getByRole("heading", { name: "Couldn't be charged" })).toBeVisible();
    await expect(failed.locator("li")).toHaveCount(1);
    await expect(failed).toContainText("Seat 6 · blue jacket");
    await expect(failed).toContainText("Still owes $3.07 · from");
    await failed.getByRole("button", { name: "Cash", exact: true }).click();
    await failed.getByRole("button", { name: "Exact $3.07" }).click();
    await expect(page.getByRole("heading", { name: "Couldn't be charged" })).toHaveCount(0);
    const tab = await db.query<{ state: string }>(
      "select state from tabs where name = 'Seat 6 · blue jacket'",
    );
    expect(tab.rows[0]!.state).toBe("closed");
  } finally {
    await db.end();
  }
});

/**
 * The KJ's song queue and the Up next TV (M6-22; screens N27, N28): "Song queue · 6" on the bar POS
 * opens the queue: Luis M. singing, then Jess P., Kira, Ben T., Tariq A., Hana K. and Sofia R. flagged
 * "Needs a drink credit". A TV paired with an Up next TV code shows Luis M., the next five and the
 * join QR code, and no phone number. Ben T. is signed in on his queue page. Maya taps Started on
 * Jess P.: within 3 seconds the TV shows Jess P. singing and Ben T.'s page reads "1 singer before you".
 */
test("The KJ song queue and the Up next TV: Started on Jess P. reaches the TV and Ben T.'s page within 3 seconds", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  const phoneNumber = /\+1\d{10}|\(?\d{3}\)?[ .-]?\d{3}[ .-]\d{4}|555-?01\d\d/;
  try {
    await signInMayaAtTheBar(page, request, db);
    await page.getByRole("link", { name: "Song queue · 6" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Song queue");
    await expect(page.getByText("Round 3 · 23 songs sung")).toBeVisible();
    const now = page.getByRole("region", { name: "Now singing" });
    await expect(now).toContainText("Luis M.");
    await expect(now).toContainText("Mr. Brightside · The Killers");
    const next = page.getByRole("region", { name: "Up next" });
    const rows = next.getByRole("listitem");
    await expect(rows.locator("strong")).toHaveText([
      "Jess P.",
      "Kira",
      "Ben T.",
      "Tariq A.",
      "Hana K.",
      "Sofia R.",
    ]);
    await expect(next.getByRole("listitem", { name: "Sofia R." })).toContainText(
      "Needs a drink credit",
    );
    await expect(next.getByText("Needs a drink credit")).toHaveCount(1);
    expect(await page.locator("main, .content").first().innerText()).not.toMatch(phoneNumber);

    // The Up next TV, paired like a shared device.
    const tvContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const tv = await tvContext.newPage();
    await tv.goto("http://localhost:3001/tv");
    await tv
      .getByLabel("Pairing code from Admin → Devices")
      .fill(await pairingCode(db, "up_next_display", "Up next TV · e2e"));
    await tv.getByRole("button", { name: "Pair" }).click();
    await expect(tv.locator(".tv-singing strong")).toHaveText("Luis M.");
    await expect(tv.locator(".tv-next li")).toHaveText([
      "Jess P.",
      "Kira",
      "Ben T.",
      "Tariq A.",
      "Hana K.",
    ]);
    const qr = tv.getByRole("img", { name: "Scan to sing" });
    await expect(qr).toBeVisible();
    expect(await qr.getAttribute("data-url")).toBe("http://localhost:3001/v/west4karaoke/sing");
    expect(await tv.locator("body").innerText()).not.toMatch(phoneNumber);

    // Ben T. on his queue page.
    const ben = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await ben.newPage();
    await phone.goto("http://localhost:3001/v/west4karaoke/sing");
    await phone.getByLabel("Your name on the TV").fill("Ben");
    await phone.getByLabel("Mobile number").fill("(646) 555-0163");
    await phone.getByRole("button", { name: "Text me a code" }).click();
    await expect
      .poll(
        async () =>
          (
            await db.query("select 1 from jobs where kind = 'text.send' and payload->>'to' = $1", [
              "+16465550163",
            ])
          ).rowCount,
      )
      .toBeGreaterThan(0);
    const code = (
      await db.query<{ code: string }>(
        `select payload->'data'->>'code' as code from jobs where kind = 'text.send'
           and payload->>'to' = '+16465550163' order by created_at desc limit 1`,
      )
    ).rows[0]!.code;
    await phone.getByLabel("The code we texted you").fill(code);
    await phone.getByRole("button", { name: "Confirm" }).click();
    await expect(phone.getByRole("status")).toHaveText("2 singers before you");
    // Let both live channels settle before the tap.
    await tv.waitForTimeout(1500);

    await next
      .getByRole("listitem", { name: "Jess P." })
      .getByRole("button", { name: "Started" })
      .click();
    await expect(tv.locator(".tv-singing strong")).toHaveText("Jess P.", { timeout: 3000 });
    await expect(phone.getByRole("status")).toHaveText("1 singer before you", { timeout: 3000 });
    await expect(tv.locator(".tv-next li")).toHaveText([
      "Kira",
      "Ben T.",
      "Tariq A.",
      "Hana K.",
      "Sofia R.",
    ]);
    await expect(now).toContainText("Jess P.");
    await expect(page.getByText("Round 3 · 24 songs sung")).toBeVisible();

    // A move needs a reason, and is logged with it.
    await next
      .getByRole("listitem", { name: "Hana K." })
      .getByRole("button", { name: "Move up" })
      .click();
    await page.getByLabel("Why move it?").fill("Her friends are leaving");
    await next.getByRole("button", { name: "Move up" }).and(page.locator("[type=submit]")).click();
    await expect(rows.locator("strong")).toHaveText([
      "Kira",
      "Ben T.",
      "Hana K.",
      "Tariq A.",
      "Sofia R.",
    ]);
    const moved = await db.query<{ reason: string }>(
      "select reason from song_queue_moves order by moved_at desc limit 1",
    );
    expect(moved.rows[0]?.reason).toBe("Her friends are leaving");
    expect(await tv.locator("body").innerText()).not.toMatch(phoneNumber);
    await tvContext.close();
    await ben.close();
  } finally {
    await db.end();
  }
});

/**
 * The songbook (M6-23; screens N34, N9, Main note 5): Andy uploads a CSV in Admin → Bar mode. A file
 * with a missing title on line 12 loads nothing and reports line 12; a good file loads, and Ben T.
 * finds "Mr. Brightside · The Killers" by searching "brightside" on his queue page and queues it;
 * the website's song section now shows its search box.
 */
test("The songbook: a CSV loads in Admin → Bar mode, line 12's missing title is reported, and Ben T. finds Mr. Brightside", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signInAndy(page, request, db);
    await page.goto("/admin/bar-mode");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Bar mode");
    await expect(page.getByText("No songbook yet. Singers type a title and artist.")).toBeVisible();

    const bad = ["title,artist,code"];
    for (let i = 2; i <= 11; i++) bad.push(`Song ${i},Artist ${i},WK-${i}`);
    bad.push(",The Killers,WK-12");
    await page.getByLabel("Songbook CSV file").setInputFiles({
      name: "songbook.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bad.join("\n")),
    });
    await page.getByRole("button", { name: "Upload the songbook" }).click();
    await expect(page.getByText("Line 12: the title is missing")).toBeVisible();
    await expect(page.getByText("No songbook yet. Singers type a title and artist.")).toBeVisible();

    const good = [
      "Title,Artist,Code",
      "Mr. Brightside,The Killers,WK-1001",
      "Valerie,Amy Winehouse,WK-1002",
      "Dancing Queen,ABBA,WK-1003",
      "\"Don't Stop Believin'\",Journey,WK-1004",
    ].join("\n");
    await page.getByLabel("Songbook CSV file").setInputFiles({
      name: "songbook.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(good),
    });
    await page.getByRole("button", { name: "Upload the songbook" }).click();
    await expect(page.getByRole("status")).toHaveText("Songbook loaded: 4 songs.");
    await expect(page.getByText(/^4 songs in the songbook · loaded /)).toBeVisible();

    // Ben T. on his queue page searches the songbook.
    const ben = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await ben.newPage();
    await phone.goto("http://localhost:3001/v/west4karaoke/sing");
    await phone.getByLabel("Your name on the TV").fill("Ben");
    await phone.getByLabel("Mobile number").fill("(646) 555-0163");
    await phone.getByRole("button", { name: "Text me a code" }).click();
    await expect
      .poll(
        async () =>
          (
            await db.query("select 1 from jobs where kind = 'text.send' and payload->>'to' = $1", [
              "+16465550163",
            ])
          ).rowCount,
      )
      .toBeGreaterThan(0);
    const code = (
      await db.query<{ code: string }>(
        `select payload->'data'->>'code' as code from jobs where kind = 'text.send'
           and payload->>'to' = '+16465550163' order by created_at desc limit 1`,
      )
    ).rows[0]!.code;
    await phone.getByLabel("The code we texted you").fill(code);
    await phone.getByRole("button", { name: "Confirm" }).click();
    await expect(phone.getByRole("status")).toHaveText("2 singers before you");
    await phone.getByLabel("Search the songbook").fill("brightside");
    await phone.getByRole("button", { name: "Mr. Brightside · The Killers" }).click();
    await expect(phone.getByLabel("Song title")).toHaveValue("Mr. Brightside");
    await phone.getByRole("button", { name: "Add to the queue" }).click();
    await expect(
      phone.locator(".my-songs").getByText("Mr. Brightside · The Killers"),
    ).toBeVisible();
    // Picked from the songbook: the song in the queue points at its songbook row.
    const queued = await db.query(
      "select count(*)::int as n from song_queue where title = 'Mr. Brightside' and catalog_id is not null",
    );
    expect(queued.rows).toEqual([{ n: 1 }]);

    // The website's song section now has its search box.
    const site = await ben.newPage();
    await site.goto("http://localhost:3001/v/west4karaoke");
    await site.getByLabel("Search the songbook").fill("killers");
    await expect(site.getByText("Mr. Brightside · The Killers")).toBeVisible();
    await ben.close();
  } finally {
    await db.end();
  }
});

test("Admin → Bar mode: West 4's settings, a free drink with a song refused, 2 songs per round saved", async ({
  page,
  request,
}) => {
  const db = await dbClient();
  try {
    await signInAndy(page, request, db);
    await page.goto("/admin/bar-mode");
    await expect(page.getByText("Song price · not set · songs need a drink credit")).toBeVisible();
    await expect(page.getByLabel("Charge a song price")).not.toBeChecked();
    await expect(page.getByLabel("Buy a drink, get a song")).toBeChecked();
    await expect(page.getByLabel("Buy a song, get a drink")).not.toBeChecked();
    await expect(page.getByLabel("Songs per singer per round")).toHaveValue("1");
    await expect(page.getByLabel("A push when singers are close to their turn")).toBeChecked();
    await expect(page.getByLabel("Singers before you at the push")).toHaveValue("2");
    await expect(page.getByLabel("The You're up next text")).toBeChecked();
    await expect(page.getByLabel("Singers the Up next TV shows after the one singing")).toHaveValue(
      "5",
    );
    await expect(page.getByText("No songbook yet. Singers type a title and artist.")).toBeVisible();
    expect(await clippedText(page)).toEqual([]);

    await page.getByLabel("Buy a song, get a drink").check();
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(
      page.getByText("a free drink with a song is free alcohol", { exact: false }),
    ).toBeVisible();
    await page.getByLabel("Buy a song, get a drink").uncheck();
    await page.getByLabel("Songs per singer per round").fill("2");
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(page.getByText("Published")).toBeVisible();
    const saved = await db.query<{ value: { songsPerRound: number; freeDrinkWithSong?: boolean } }>(
      "select value from venue_settings where key = 'barMode' order by version desc limit 1",
    );
    expect(saved.rows[0]!.value).toMatchObject({ songsPerRound: 2, freeDrinkWithSong: false });
  } finally {
    await db.end();
  }
});

/*
 * M6 · Done when (M6-28): the paths the earlier tests didn't walk on screen. Each starts from a fresh
 * seed load with the night's Stripe side on the fake (stripe:seed). The fake answers a raise as Stripe
 * would; a declined raise and a lost answer are queued with the fake-only next_increment helper, since
 * Stripe's sandbox has no test card or amount for either. Jobs (the reconciler, the hold cancel, the 4:30
 * AM cut-off) run in a real worker the test starts, as they would in staging.
 */
const FAKE_STRIPE = "http://127.0.0.1:12111";
const fakeStripe = async (db: pg.Client) => {
  const account = (
    await db.query<{ account: string }>(
      `select o.stripe_account_id as account
         from devices d join venues v on v.id = d.venue_id join organizations o on o.id = v.org_id
        where d.name = 'Bar S710' and not d.sandbox`,
    )
  ).rows[0]!.account;
  return { authorization: "Bearer rk_test_fake_payments", "stripe-account": account };
};
const tabIntent = async (db: pg.Client, name: string) =>
  (
    await db.query<{ pi: string; payment: string }>(
      `select p.stripe_pi_id as pi, p.id as payment
         from tabs t join payments p on p.id = t.payment_id where t.name = $1`,
      [name],
    )
  ).rows[0]!;
/** Queues what the next raise of a tab's hold does on the fake: the issuer declines it, or its answer is lost. */
const nextRaise = async (
  request: APIRequestContext,
  db: pg.Client,
  name: string,
  outcome: "decline" | "drop",
) => {
  const { pi } = await tabIntent(db, name);
  const r = await request.post(
    `${FAKE_STRIPE}/v1/test_helpers/fake/payment_intents/${pi}/next_increment`,
    { headers: await fakeStripe(db), form: { outcome } },
  );
  expect(r.ok(), await r.text()).toBe(true);
};
const intentOnFake = async (request: APIRequestContext, db: pg.Client, pi: string) =>
  (await (
    await request.get(`${FAKE_STRIPE}/v1/payment_intents/${pi}`, { headers: await fakeStripe(db) })
  ).json()) as { status: string; amount: number; amount_received?: number };
/** The job worker, which the smoke run doesn't start: started for a test that needs its jobs, stopped after. */
const startWorker = () => {
  const child = spawn("pnpm", ["exec", "tsx", "src/worker.ts"], {
    cwd: "apps/api",
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WEST4_ENV: "local",
      ALLOW_STAGING_FEATURES: "true",
      DATABASE_URL: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
      APP_DATABASE_URL:
        process.env["APP_DATABASE_URL"] ?? "postgres://app_rw:app_rw@localhost:5432/west4",
    },
  });
  return () => {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      // Already gone.
    }
  };
};
const raises = async (db: pg.Client, payment: string) =>
  (
    await db.query<{ state: string; decline_code: string | null }>(
      "select state, decline_code from payment_attempts where payment_id = $1 and action = 'increment' order by attempt_no",
      [payment],
    )
  ).rows;

test.describe("M6 done when", () => {
  test("a declined raise: Jess P.'s round past her hold waits for Andy, and her row reads Hold raise declined", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const db = await dbClient();
    try {
      stripeSeed();
      await signInMayaAtTheBar(page, request, db);
      const { pi, payment } = await tabIntent(db, "Jess P.");
      await nextRaise(request, db, "Jess P.", "decline");
      const row = page
        .getByRole("list", { name: "Bar tabs" })
        .getByRole("button", { name: /Jess P\./ });
      await row.click();
      const panel = page.getByRole("complementary");
      await expect(panel).toContainText("$32.66");
      await page.getByRole("tab", { name: "Buckets" }).click();
      await page.getByRole("button", { name: /^Large bucket · 10 beers · \$/ }).click();
      await panel.getByRole("button", { name: "Send 1 to the bar" }).click();
      await expect(panel.getByRole("status").first()).toContainText(
        "Hold raise declined: the round waits for Andy C.",
      );
      await expect(panel).toContainText("Hold raise declined");
      await expect(page.getByRole("list", { name: "Bar tabs" })).toContainText("Waiting for Andy");
      // The hold stands at $50.00 on Stripe; the round isn't on her tab.
      expect(await raises(db, payment)).toEqual([
        { state: "failed", decline_code: "card_declined" },
      ]);
      expect((await intentOnFake(request, db, pi)).amount).toBe(5000);
      await expect(row).toContainText("$32.66");
    } finally {
      await db.end();
    }
  });

  test("a timeout: Luis M.'s raise reads Checking with Stripe, the reconciler settles it, and the round goes on with no second raise", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const db = await dbClient();
    let stop: (() => void) | undefined;
    try {
      stripeSeed();
      await signInMayaAtTheBar(page, request, db);
      const { pi, payment } = await tabIntent(db, "Luis M.");
      const before = await raises(db, payment);
      await nextRaise(request, db, "Luis M.", "drop");
      await page
        .getByRole("list", { name: "Bar tabs" })
        .getByRole("button", { name: /Luis M\./ })
        .click();
      const panel = page.getByRole("complementary");
      await expect(panel).toContainText("$63.15");
      await page.getByRole("tab", { name: "Buckets" }).click();
      await page.getByRole("button", { name: /^Large bucket · 10 beers · \$/ }).click();
      await panel.getByRole("button", { name: "Send 1 to the bar" }).click();
      await expect(panel.getByRole("status").first()).toContainText(
        "Growing the hold · Checking with Stripe · don't retry. The round isn't sent yet.",
      );
      await expect(panel).toContainText("Checking with Stripe · don't retry");
      // Stripe did raise it; our side doesn't know yet, and nothing is asked twice.
      const raised = (await intentOnFake(request, db, pi)).amount;
      expect(raised).toBeGreaterThan(8000);
      expect(await raises(db, payment)).toHaveLength(before.length + 1);

      stop = startWorker();
      await expect
        .poll(async () => (await raises(db, payment)).at(-1)?.state, { timeout: 60_000 })
        .toBe("succeeded");
      // No reload: the bar computer refetches by itself (it has no event socket, M6-28).
      const chip = panel.getByText("Checking with Stripe · don't retry", { exact: true });
      await expect(chip).toHaveCount(0, { timeout: 25_000 });
      await expect(panel).toContainText(`Hold $${(raised / 100).toFixed(2)}`);
      // The round still waiting on the screen goes on now, with no second raise.
      await panel.getByRole("button", { name: "Send 1 to the bar" }).click();
      await expect(panel.getByRole("list", { name: "On the tab" })).toContainText(
        "Large bucket · 10 beers",
      );
      expect(await raises(db, payment)).toHaveLength(before.length + 1);
      expect((await intentOnFake(request, db, pi)).amount).toBe(raised);
      // A worker started at 10:41 PM runs on the simulated night from its first sweep: it never
      // mistook the real date for 4:30 AM and charged the open tabs as walkouts (M6-28's bug).
      const open = await db.query<{ state: string }>(
        "select state from tabs where name in ('Luis M.', 'Jess P.', 'Hana K.', 'Tariq A.')",
      );
      expect(open.rows.map((r) => r.state)).toEqual(["open", "open", "open", "open"]);
    } finally {
      stop?.();
      await db.end();
    }
  });

  test("Jess P.'s tab into Room 9 releases her hold on Stripe, and a cut-off Room 9 refuses Luis M.'s drinks with the reason", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const db = await dbClient();
    let stop: (() => void) | undefined;
    try {
      stripeSeed();
      await signInMayaAtTheBar(page, request, db);
      const tabs = page.getByRole("list", { name: "Bar tabs" });
      const panel = page.getByRole("complementary");
      const jess = await tabIntent(db, "Jess P.");
      await tabs.getByRole("button", { name: /Jess P\./ }).click();
      await panel.getByRole("button", { name: "Move tab to a room" }).click();
      await panel.getByRole("button", { name: /Room 9/ }).click();
      await expect(panel.getByRole("status").first()).toContainText("Moved to Room 9");
      await expect(panel.getByRole("list", { name: "On the tab" })).toContainText(
        "Moved from Jess P.'s bar tab",
      );
      // Room 9 has Marcus's card from his deposit, so her hold guarantees nothing: a job cancels it.
      stop = startWorker();
      await expect
        .poll(async () => (await intentOnFake(request, db, jess.pi)).status, { timeout: 60_000 })
        .toBe("canceled");
      expect(
        (
          await db.query<{ status: string }>("select status from payments where id = $1", [
            jess.payment,
          ])
        ).rows[0]!.status,
      ).toBe("canceled");

      // Andy cuts off Room 9; Luis M.'s drinks can't move in.
      await db.query(
        `update room_sessions set alcohol_cut_off_at = now(), alcohol_cut_off_reason = 'Too drunk',
                alcohol_cut_off_by = (select row_id from seed_ids where slug = 'andy')
          where id = (select row_id from seed_ids where slug = 'sess_room9')`,
      );
      await page.reload();
      await tabs.getByRole("button", { name: /Luis M\./ }).click();
      await expect(panel).toContainText("$63.15");
      await panel.getByRole("button", { name: "Move tab to a room" }).click();
      await panel.getByRole("button", { name: /Room 9/ }).click();
      await expect(panel.getByRole("alert")).toContainText(
        "Alcohol can't move onto Room 9: it's cut off. Reason: Too drunk",
      );
      await expect(tabs).toContainText("Luis M.");
      const refused = await db.query(
        `select 1 from alcohol_refusals
          where check_id = (select row_id from seed_ids where slug = 'chk_room9') and reason = 'cut_off'`,
      );
      expect(refused.rowCount).toBeGreaterThan(0);
    } finally {
      stop?.();
      await db.end();
    }
  });

  test("a walkout at 4:30 AM: the cut-off charges every open tab at its balance, Jess P.'s $32.66 on her hold", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const db = await dbClient();
    let stop: (() => void) | undefined;
    try {
      stripeSeed();
      const jess = await tabIntent(db, "Jess P.");
      await setClock(request, "2026-09-26T08:29:45Z");
      stop = startWorker();
      const states = async () =>
        Object.fromEntries(
          (
            await db.query<{ name: string; state: string }>(
              `select name, state from tabs
                where name in ('Hana K.', 'Jess P.', 'Luis M.', 'Seat 6 · blue jacket', 'Tariq A.')`,
            )
          ).rows.map((r) => [r.name, r.state]),
        );
      // Not a second early.
      expect((await states())["Jess P."]).toBe("open");
      await expect
        .poll(async () => (await states())["Jess P."], { timeout: 90_000, intervals: [2000] })
        .toBe("walkout_captured");
      await expect
        .poll(async () => Object.values(await states()), { timeout: 30_000 })
        .toEqual(Array(5).fill("walkout_captured"));
      const captured = await intentOnFake(request, db, jess.pi);
      expect(captured.status).toBe("succeeded");
      expect(captured.amount_received).toBe(3266);
      // Every open tab at its balance with no tip, as the integration test has it (tab-walkout).
      const walkouts = await db.query<{ name: string; pi: string }>(
        `select t.name, p.stripe_pi_id as pi from tabs t join payments p on p.id = t.payment_id
          where t.state = 'walkout_captured' order by t.name`,
      );
      const charged: [string, number | undefined][] = [];
      for (const w of walkouts.rows)
        charged.push([w.name, (await intentOnFake(request, db, w.pi)).amount_received]);
      expect(charged).toEqual([
        ["Hana K.", 4355],
        ["Jess P.", 3266],
        ["Luis M.", 6315],
        ["Seat 6 · blue jacket", 1307],
        ["Tariq A.", 8601],
      ]);
    } finally {
      stop?.();
      await db.end();
    }
  });

  test("a gift after 4 AM: alcohol greyed with the reason on the bar POS, and the route refuses it with the 4 AM reason", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const db = await dbClient();
    try {
      await db.query("update memberships set locale = 'en'");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/sign-in");
      await page.getByRole("button", { name: "Pair this screen" }).click();
      await page
        .getByLabel("Pairing code from Admin → Devices")
        .fill(await pairingCode(db, "bar_computer", "Bar computer"));
      await setClock(request, "2026-09-26T08:02:00Z");
      await page.getByRole("button", { name: "Pair", exact: true }).click();
      await page.getByRole("button", { name: /Maya S\./ }).click();
      await typePin(page, "4071");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");
      await page
        .getByRole("list", { name: "Bar tabs" })
        .getByRole("button", { name: /Tariq A\./ })
        .click();
      await expect(
        page.getByRole("button", { name: "Modelo · No alcohol now · the window has closed" }),
      ).toBeDisabled();
      const ids = Object.fromEntries(
        (
          await db.query<{ slug: string; id: string }>(
            "select slug, row_id as id from seed_ids where slug in ('sg_jess', 'menu_modelo_regular')",
          )
        ).rows.map((r) => [r.slug, r.id]),
      );
      const tariq = (
        await db.query<{ id: string; check: string; venue: string }>(
          "select id, check_id as check, venue_id as venue from tabs where name = 'Tariq A.'",
        )
      ).rows[0]!;
      const venue = tariq.venue;
      // The refusal is logged on the singer's check: it's Jess P. who can't be served.
      const jess = (
        await db.query<{ check: string }>(
          "select check_id as check from tabs where name = 'Jess P.'",
        )
      ).rows[0]!.check;
      const before = (await db.query("select 1 from alcohol_refusals where check_id = $1", [jess]))
        .rowCount!;
      const r = await page.evaluate(
        async ([path, body]) => {
          const token = sessionStorage.getItem("west4.staff.token");
          const res = await fetch(path!, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: body!,
          });
          return { status: res.status, body: await res.text() };
        },
        [
          `/v1/venues/${venue}/tabs/${tariq.id}/gift-order`,
          JSON.stringify({
            client_order_id: crypto.randomUUID(),
            singer_id: ids["sg_jess"],
            lines: [{ variant_id: ids["menu_modelo_regular"], qty: 1 }],
          }),
        ],
      );
      expect(r.status, r.body).toBe(409);
      const error = (JSON.parse(r.body) as { error: { code: string; details: { reason: string } } })
        .error;
      expect(error).toMatchObject({ code: "alcohol_closed", details: { reason: "window_closed" } });
      expect(
        (await db.query("select 1 from alcohol_refusals where check_id = $1", [jess])).rowCount,
      ).toBe(before + 1);
    } finally {
      await db.end();
    }
  });
});

/**
 * The time clock (M7-01; Pin note 2 and 3, N24): at 10:41 PM the bar
 * computer's tiles read who's on since when; Abhishek, not on shift, gets the
 * duty picker with Manager and Diego gets it without; Maya's break reads
 * "Maya · on break" on the bar POS whoever is signed in, until she ends it.
 * Then Andy's phone-size Clock in and out tab lists the team.
 */
for (const width of [1280, 390]) {
  test(`the time clock at ${width}px: who's on since when, the duty picker, and Maya's break on the bar POS`, async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const db = await dbClient();
    try {
      await db.query("update memberships set locale = 'en'");
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/sign-in");
      await page.getByRole("button", { name: "Pair this screen" }).click();
      await page
        .getByLabel("Pairing code from Admin → Devices")
        .fill(await pairingCode(db, "bar_computer", "Bar computer"));
      expect(
        (
          await request.post("/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })
        ).ok(),
      ).toBe(true);
      await page.getByRole("button", { name: "Pair", exact: true }).click();
      const tile = (name: RegExp) => page.getByRole("button", { name });
      const lockScreen = async () => {
        if (width === 390) await page.getByRole("button", { name: "Open the menu" }).click();
        await page.getByRole("button", { name: "Lock", exact: true }).click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");
      };
      await expect(tile(/Maya S\./).locator(".tile-shift")).toHaveText("On since 4:00 PM (6h 41m)");
      await expect(tile(/Andy C\./).locator(".tile-shift")).toHaveText("On since 6:00 PM (4h 41m)");
      await expect(tile(/Diego R\./).locator(".tile-shift")).toHaveText(
        "On since 7:00 PM (3h 41m)",
      );
      await expect(tile(/Abhishek G\./).locator(".tile-shift")).toHaveText("Not on shift");
      expect(await clippedText(page)).toEqual([]);

      // Abhishek isn't on the clock: after his PIN, the duty picker, Manager included; no duty, no clock-in.
      await tile(/Abhishek G\./).click();
      await typePin(page, "915204");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Time clock");
      const duties = page.locator(".duties").getByRole("button");
      await expect(duties).toHaveText(["Bar", "Front desk", "Runner", "Manager"]);
      await expect(page.getByRole("button", { name: "Clock in" })).toBeDisabled();
      expect(await clippedText(page)).toEqual([]);
      await page.getByRole("button", { name: "Not now" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
      await lockScreen();
      await expect(page.getByRole("status")).toHaveText("Locked · sign in to continue");

      // Maya asks for the time clock and starts a break.
      await page.getByRole("button", { name: "Time clock" }).click();
      await tile(/Maya S\./).click();
      await typePin(page, "4071");
      await expect(page.locator(".clock-status")).toHaveText("On since 4:00 PM (6h 41m)");
      await page.getByRole("button", { name: "Start break" }).click();
      await expect(page.locator(".clock-status")).toHaveText("On break since 10:41 PM");
      await page.getByRole("button", { name: "Done" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");
      await expect(page.locator(".rail-top .who")).toHaveText("Maya · on break");
      await lockScreen();

      // Diego on the bar POS sees it too.
      await tile(/Diego R\./).click();
      await typePin(page, "6358");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
      await page.goto("/bar");
      await expect(page.locator(".rail-top .who")).toHaveText("Diego R.");
      await expect(page.locator(".rail-top .on-break")).toHaveText("Maya · on break");
      // Diego clocks out and back in: his duty picker has no Manager.
      await lockScreen();
      await page.getByRole("button", { name: "Time clock" }).click();
      await tile(/Diego R\./).click();
      await typePin(page, "6358");
      await page.getByRole("button", { name: "Clock out" }).click();
      // His clock-out checklist (M7-11): two open tabs, his unsent Red Bull, and his cash tips.
      const list = page.getByRole("region", { name: "Before you clock out" });
      await expect(list).toContainText("Tariq A.'s tab is still open");
      await expect(list).toContainText("1 unsent on Tariq A.'s tab: they go with the tab");
      for (const name of ["Tariq A.", "Seat 6 · blue jacket"]) {
        await list.getByLabel(`Hand ${name}'s tab to`).selectOption({ label: "Maya S." });
        await list
          .getByRole("listitem")
          .filter({ hasText: `${name}'s tab is still open` })
          .getByRole("button", { name: "Hand it over" })
          .click();
        await expect(list).not.toContainText(`${name}'s tab is still open`);
      }
      await list.getByLabel("Cash tips you got tonight, $").fill("0");
      await list.getByRole("button", { name: "Declare" }).click();
      await expect(list).toContainText("All clear: you can clock out");
      await page.getByRole("button", { name: "Clock out" }).click();
      await expect(page.locator(".clock-status")).toHaveText("Not on shift");
      await expect(page.locator(".duties").getByRole("button")).toHaveText([
        "Bar",
        "Front desk",
        "Runner",
      ]);
      await page.getByRole("button", { name: "Front desk" }).click();
      await page.getByRole("button", { name: "Clock in" }).click();
      await expect(page.locator(".clock-status")).toHaveText("On since 10:41 PM (0h 0m)");
      await page.getByRole("button", { name: "Done" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
      await lockScreen();

      // Maya ends her break: the top bar is hers again.
      await page.getByRole("button", { name: "Time clock" }).click();
      await tile(/Maya S\./).click();
      await typePin(page, "4071");
      await page.getByRole("button", { name: "End break" }).click();
      await expect(page.locator(".clock-status")).toHaveText(/^On since 4:00 PM/);
      await page.getByRole("button", { name: "Done" }).click();
      await expect(page.locator(".rail-top .who")).toHaveText("Maya S.");
      await expect(page.locator(".rail-top .on-break")).toHaveCount(0);
      const breaks = await db.query<{ break_minutes: number }>(
        "select s.break_minutes from shifts s join memberships m on m.id = s.membership_id join users u on u.id = m.user_id where u.name = 'Maya S.' and s.ended_at is null",
      );
      expect(breaks.rows).toHaveLength(1);
    } finally {
      await db.end();
    }
  });
}

test("Andy's Clock in and out tab lists who's on the clock, at phone size", async ({
  page,
  request,
}) => {
  const db = await dbClient();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndy(page, request, db);
    await page.goto("/clock");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Time clock");
    await expect(page.locator(".time-clock .clock-status")).toHaveText("On since 6:00 PM (4h 41m)");
    await expect(page.getByRole("list", { name: "Who's on the clock" }).locator("li")).toHaveText([
      "Abhishek G. · not on shift",
      "Andy C. · on since 6:00 PM (4h 41m)",
      "Maya S. · on since 4:00 PM (6h 41m)",
      "Diego R. · on since 7:00 PM (3h 41m)",
    ]);
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.end();
  }
});

/**
 * Training mode (M7-03): with Maya in training, every staff route shows the
 * band "TRAINING · not real money" on the bar computer and on a phone, and
 * nothing closes it; when she leaves training the band goes. The walk fails
 * if any route renders without it: Board, Rail, Bar, DeskRoom, Room, Staff, Night.
 */
test("training mode: the band on every staff route, at 1440 and 390, that can't be closed", async ({
  page,
  request,
}) => {
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    const room9 = (
      await db.query<{ id: string }>("select row_id as id from seed_ids where slug = 'room_9'")
    ).rows[0]!.id;
    const band = page.getByTestId("training-band");
    await expect(band).toHaveCount(0);
    await db.query(
      "update memberships set training = true where user_id = (select id from users where name = 'Maya S.')",
    );
    const routes = [
      "/tonight",
      "/bar",
      "/bar-orders",
      `/room/${room9}`,
      "/today",
      "/close-the-night",
    ];
    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      for (const route of routes) {
        await page.goto(route);
        await expect(band, `${route} at ${size.width}`).toHaveText("TRAINING · not real money");
        await expect(band.getByRole("button")).toHaveCount(0);
        expect(await clippedText(page), `${route} at ${size.width}`).toEqual([]);
      }
    }
    await db.query("update memberships set training = false");
    await page.goto("/bar");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");
    await expect(band).toHaveCount(0);
  } finally {
    await db.query("update memberships set training = false");
    await db.end();
  }
});

/**
 * Practice payments on Stripe's sandbox (M7-04): Maya in training rings a Bud Light, the reader
 * picker lists only the sandbox's simulated readers, and [Tap a test card] on the waiting state
 * shows the real card states: "Waiting for a tap on the bar reader · Cancel", "Declined · try
 * another card or cash", then Paid. The PaymentIntent is on West 4's sandbox account, never live.
 */
test("training mode: a trainee's tap runs on a simulated reader, declined then paid with a test card", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const db = await dbClient();
  try {
    stripeSeed();
    await signInMayaAtTheBar(page, request, db);
    await db.query(
      "update memberships set training = true where user_id = (select id from users where name = 'Maya S.')",
    );
    await page.reload();
    await expect(page.getByTestId("training-band")).toBeVisible();
    await page.getByRole("tab", { name: "Beer" }).click();
    const panel = page.getByRole("complementary");
    await page.getByRole("button", { name: /^Bud Light · \$/ }).click();
    await panel.getByRole("button", { name: "Pay for 1" }).click();
    const tap = panel.getByRole("region", { name: "Tap at the reader" });
    // The sandbox's simulated readers only: the live Bar S710 isn't offered.
    const picker = tap.getByRole("group", { name: "Reader" });
    await expect(picker.getByRole("radio")).toHaveCount(2);
    const practiceBar = (
      await db.query<{ id: string }>(
        "select id from devices where kind = 'reader' and sandbox and name = 'Bar S710'",
      )
    ).rows[0]!.id;
    await tap.getByLabel("Bar S710").check();
    await tap.getByRole("button", { name: /^Send \$.* to the reader$/ }).click();
    await expect(tap.getByRole("status").first()).toHaveText(
      "Waiting for a tap on the bar reader · Cancel",
    );
    await tap.getByRole("button", { name: "Tap a declined test card" }).click();
    await expect(tap.getByRole("alert")).toHaveText("Declined · try another card or cash", {
      timeout: 15_000,
    });
    await tap.getByRole("button", { name: "Tap again" }).click();
    await expect(tap.getByRole("status").first()).toHaveText(
      "Waiting for a tap on the bar reader · Cancel",
    );
    await tap.getByRole("button", { name: "Tap a test card" }).click();
    await expect(panel.getByRole("button", { name: "Text" })).toBeVisible({ timeout: 15_000 });

    const payment = await db.query<{
      training: boolean;
      status: string;
      pi: string;
      reader: string;
    }>(
      `select p.training, p.status, p.stripe_pi_id as pi,
              (select reader_id from payment_attempts a where a.payment_id = p.id order by attempt_no desc limit 1) as reader
         from payments p where p.method = 'card_present' order by p.created_at desc limit 1`,
    );
    const row = payment.rows[0]!;
    expect(row).toMatchObject({ training: true, status: "captured" });
    const ids = (
      await db.query<{ sandbox: string; live: string; reader: string }>(
        `select o.stripe_training_account_id as sandbox, o.stripe_account_id as live,
                (select stripe_reader_id from devices where id = $1) as reader
           from organizations o limit 1`,
        [practiceBar],
      )
    ).rows[0]!;
    expect(row.reader).toBe(ids.reader);
    // On the sandbox account with the sandbox's key; the live key can't even see it.
    const atSandbox = await request.get(`http://127.0.0.1:12111/v1/payment_intents/${row.pi}`, {
      headers: {
        authorization: "Bearer rk_test_fake_sandbox_payments",
        "stripe-account": ids.sandbox,
      },
    });
    expect(((await atSandbox.json()) as { status: string }).status).toBe("succeeded");
    const atLive = await request.get(`http://127.0.0.1:12111/v1/payment_intents/${row.pi}`, {
      headers: { authorization: "Bearer rk_test_fake_payments", "stripe-account": ids.live },
    });
    expect(atLive.status()).toBe(404);
    expect(await clippedText(page)).toEqual([]);
  } finally {
    await db.query("update memberships set training = false");
    await db.end();
  }
});

/**
 * Night's drawer panel (M7-05; screens Night note 7): both house drawers open with $300.00, each answered
 * for by Andy and blind; his count of the bar drawer shows what it should have held only after he saves it.
 */
test("Close the night: both drawers counted blind, the bar drawer $10.00 short", async ({
  page,
  request,
}) => {
  const db = await dbClient();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    await page.goto("/close-the-night");
    const drawers = page.getByRole("region", { name: "Cash drawers" });
    const bar = drawers.getByRole("article", { name: "Bar drawer" });
    const front = drawers.getByRole("article", { name: "Front-desk drawer" });
    for (const d of [bar, front]) {
      await expect(d).toContainText("Blind count · open · Andy C. answers for it");
      await expect(d).toContainText("Opened with$300.00");
      await expect(d).not.toContainText("Should be in the drawer");
    }
    await bar.getByRole("button", { name: "Count the drawer" }).click();
    await expect(bar).toContainText(
      "Count first. What the drawer should hold shows after you enter the count.",
    );
    await bar.getByLabel("What you counted, $").fill("290");
    await bar.getByRole("button", { name: "Save the count" }).click();
    await expect(bar).toContainText("Should be in the drawer$300.00");
    await expect(bar).toContainText("Counted$290.00");
    await expect(bar).toContainText("Short $10.00");
    await expect(bar).toContainText("Counted by Andy C.");
    await expect(front).not.toContainText("Should be in the drawer");
  } finally {
    await db.end();
  }
});

/**
 * A paid-out at the bar (M7-06): Maya, signed in at the bar computer, opens Cash drawers on the board, takes
 * $42.00 out for an ice run with a photo of the receipt, and the screen says it waits for Andy.
 */
test("a paid-out with a photo of the receipt waits for Andy", async ({ page, request }) => {
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    // The screen just paired is the bar drawer's own screen.
    await db.query(
      `update devices set cash_drawer_id = (select id from cash_drawers where name = 'Bar drawer')
        where id = (select id from devices where kind = 'bar_computer' order by created_at desc limit 1)`,
    );
    await page.goto("/tonight");
    await page.getByRole("button", { name: "Cash drawers" }).click();
    const bar = page.getByRole("article", { name: "Bar drawer" });
    await bar.getByRole("button", { name: "Paid-out" }).click();
    const form = bar.getByRole("form", { name: "Paid-out" });
    await form.getByLabel("Amount, $").fill("42");
    await form.getByLabel("Reason").fill("Ice run");
    await expect(form.getByRole("button", { name: "Open the drawer" })).toBeDisabled();
    await form.getByLabel("Photo of the receipt").setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await form.getByRole("button", { name: "Open the drawer" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Waiting for Andy C." })).toBeVisible();
    const asked = await db.query<{ amount_cents: string; reason: string }>(
      "select amount_cents::text, reason from approvals where kind = 'paid_out' and status = 'pending'",
    );
    expect(asked.rows).toEqual([{ amount_cents: "4200", reason: "Ice run" }]);
  } finally {
    await db.end();
  }
});

/**
 * A drawer per person (M7-07): on Sat Sep 26, with Admin's switch in force, Maya counts in $300.00 at the
 * bar computer, her drawer is hers alone, and at clock-out she pulls the tray for the close.
 */
test("a drawer per person: Maya counts in $300.00 and pulls her tray", async ({
  page,
  request,
}) => {
  const db = await dbClient();
  try {
    await signInMayaAtTheBar(page, request, db);
    await db.query(
      `update devices set cash_drawer_id = (select id from cash_drawers where name = 'Bar drawer')
        where id = (select id from devices where kind = 'bar_computer' order by created_at desc limit 1)`,
    );
    // Friday's drawers were counted at its close, and the switch Admin saved starts Saturday.
    await db.query(
      "update drawer_sessions set state = 'counted', counted_cents = 30000 where state = 'open'",
    );
    await db.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on)
       select venue_id, key, version + 1,
              value || '{"drawer": "perPerson", "perPerson": {"who": "bartenders", "countLater": true}}'::jsonb,
              '2026-09-26'
         from venue_settings where key = 'drawer' order by version desc limit 1`,
    );
    await setClock(request, "2026-09-27T00:00:00Z");
    // A new night: Maya signs in again at the bar computer.
    await page.goto("/sign-in");
    await page.getByRole("button", { name: /Maya S\./ }).click();
    await typePin(page, "4071");
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Staff sign-in");
    await page.goto("/tonight");
    await page.getByRole("button", { name: "Cash drawers" }).click();
    const bar = page.getByRole("article", { name: "Bar drawer" });
    await bar.getByRole("button", { name: "Count in the starting bank" }).click();
    await bar.getByLabel("What you counted, $").fill("300");
    await bar.getByLabel("Your PIN again").fill("4071");
    await bar.getByRole("button", { name: "Save the count" }).click();
    await expect(bar).toContainText("Maya S.'s drawer · Blind count · open");
    await expect(bar).toContainText("Opened with$300.00");
    await bar.getByRole("button", { name: "Pull the tray" }).click();
    await expect(bar).toContainText("Maya S.'s drawer · Bar · Maya S. · tray pulled");
  } finally {
    await db.end();
  }
});

/**
 * Night's tips panel (M7-09; screens Night notes 1 and 2): Maya and Diego share by their minutes, and Andy
 * is "Not in the pool: Andy C., manager."
 */
test("Close the night: the tips panel shares between Maya and Diego, never Andy", async ({
  page,
  request,
}) => {
  const db = await dbClient();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    await page.goto("/close-the-night");
    const tips = page.getByRole("region", { name: "Tips" });
    await expect(tips).toContainText("Gratuity from room checks");
    await expect(tips).toContainText("The pool to share");
    await expect(tips.locator("li").first()).toContainText("Maya S.");
    await expect(tips.locator("li").nth(1)).toContainText("Diego R.");
    await expect(tips).toContainText("Not in the pool: Andy C., manager.");
    await expect(tips).not.toContainText("Abhishek");
  } finally {
    await db.end();
  }
});

/**
 * My tips (M7-10) on Andy's phone: his Manager shift from 6:00 PM, and that managers don't share; gratuity
 * and tips read on their own lines when there are shares.
 */
test("My tips on a phone: Andy's Manager shift, and managers don't share", async ({
  page,
  request,
}) => {
  const db = await dbClient();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndy(page, request, db);
    await page.locator(".tabs").getByRole("link", { name: "My tips" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("My tips");
    await expect(
      page.getByText("Managers don't share in the tip pool. Your shifts are below."),
    ).toBeVisible();
    await expect(page.getByRole("article").first()).toContainText("Manager · 6:00 PM – on shift");
  } finally {
    await db.end();
  }
});

/**
 * Close the night (M7-12; the seed's night_close at desktop size): at Sat 4:12 AM Night lists the checks with
 * a link to each fix and "3 slips not entered · tips post to Sat Sep 26"; once the rooms, tabs, staff, waitlist,
 * orders, approval, drafts and drawers are dealt with, Andy does the clear-out at 4:31 and closes at 4:48.
 */
test("Close the night: the checks, the clear-out at 4:31 AM and Night closed · 4:48 AM", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    // Sat 4:12 AM first: a session idle 30 minutes locks, so Andy signs in then.
    await setClock(request, "2026-09-26T08:12:00Z");
    await signInAndy(page, request, db);
    await page.goto("/close-the-night");
    const checks = page.getByRole("region", { name: "Before closing" });
    await expect(checks).toContainText("3 slips not entered · tips post to Sat, Sep 26");
    await expect(
      checks
        .getByRole("listitem")
        .filter({ hasText: "Pending approvals · 1" })
        .getByRole("link", { name: "Fix" }),
    ).toHaveAttribute("href", "/approvals");
    await expect(checks).toContainText("Staff still on the clock · 2");
    await expect(checks.getByRole("button", { name: "Close the night" })).toBeDisabled();
    // The report panel (M7-13): the running X report, rooms and bar tabs counted apart.
    const report = page.getByRole("region", { name: "X report (running)" });
    await expect(report).toContainText("Drinks · room checks");
    await expect(report).toContainText("Drinks · bar tabs");
    await expect(report).toContainText("Bar tabs 8");
    await expect(report.getByRole("button", { name: "Print X report (running)" })).toBeVisible();

    // The fixes, as each screen would make them.
    const v = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    await db.query(
      "update room_sessions set ended_at = now() where venue_id = $1 and ended_at is null",
      [v],
    );
    await db.query(
      "update tabs set state = 'captured' where venue_id = $1 and state in ('open', 'tipping')",
      [v],
    );
    await db.query(
      "update shifts set ended_at = now() where venue_id = $1 and ended_at is null and membership_id not in (select m.id from memberships m join users u on u.id = m.user_id where u.name like 'Andy%')",
      [v],
    );
    await db.query(
      "update waitlist_entries set status = 'left' where venue_id = $1 and status in ('waiting', 'offered')",
      [v],
    );
    await db.query(
      "update orders set status = 'cancelled', cancel_reason = 'staff' where venue_id = $1 and status in ('ringing', 'held')",
      [v],
    );
    await db.query(
      "update approvals set status = 'declined' where venue_id = $1 and status = 'pending'",
      [v],
    );
    await db.query(
      "update room_states set state = 'available' where venue_id = $1 and state = 'cleaning'",
      [v],
    );
    await db.query("update order_drafts set lines = '[]' where venue_id = $1", [v]);
    await db.query(
      "update drawer_sessions set state = 'counted', counted_cents = opening_cents, expected_cents = opening_cents, over_short_cents = 0 where venue_id = $1 and state = 'open'",
      [v],
    );
    // 4:31 AM: the clear-out check is due (4:30) and Andy walks the rooms.
    await setClock(request, "2026-09-26T08:31:00Z");
    await page.reload();
    await expect(checks).toContainText("Walk every room and the bar · no drinks left out");
    await checks.getByRole("button", { name: "Done" }).click();
    await expect(checks).toContainText("Clear-out check · Andy · 4:31 AM");
    // 4:48 AM: the close, after one confirmation.
    await setClock(request, "2026-09-26T08:48:00Z");
    await page.reload();
    await checks.getByRole("button", { name: "Close the night" }).click();
    await checks
      .getByRole("group", { name: "Close the night" })
      .getByRole("button", { name: "Close the night" })
      .click();
    await expect(checks).toContainText("Night closed · 4:48 AM");
    const z = page.getByRole("region", { name: "Z report 1" });
    await z.getByRole("button", { name: "Print Z report" }).click();
    await expect(z).toContainText("Sent to the front-desk printer");
  } finally {
    await db.end();
  }
});

/**
 * Reports (M7-18; screens DeskReports and Reports): at desktop and phone sizes, tonight's running X report
 * linked to Close the night, this week and the 8-week trend, "Reviews from the morning text · Off", and
 * tonight's exceptions with Maya's comp and Diego's void waiting for Andy.
 */
for (const size of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`Reports (${size.name}): tonight's X report, this week, the trend and the exceptions`, async ({
    page,
    request,
  }) => {
    const db = await dbClient();
    try {
      await page.setViewportSize({ width: size.width, height: size.height });
      await signInAndy(page, request, db);
      await page.goto("/reports");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reports");
      const tonight = page.getByRole("region", { name: "X report (running)" });
      await expect(tonight.getByRole("link", { name: "Close the night" })).toBeVisible();
      await expect(page.getByText("Reviews from the morning text · Off")).toBeVisible();
      await expect(
        page.getByRole("region", { name: "Trends · 8 weeks" }).locator("li"),
      ).toHaveCount(8);
      const exceptions = page.getByRole("region", { name: "Comps, voids and refunds tonight" });
      await expect(exceptions).toContainText("Comp · Luis M. · Maya S.");
      await expect(exceptions).toContainText("Void · Tariq A. · Diego R. · Waiting for Andy C.");
      if (size.width < 600)
        await expect(page.locator(".tabs").getByRole("link", { name: "Reports" })).toBeVisible();
    } finally {
      await db.end();
    }
  });
}

/**
 * The outage and vendor banners (M8-01; spec 09 · Outages, screens N29). The
 * vendor-health job runs here as the worker runs it, on the venue's 10:41 PM,
 * after our own error rate on Stripe or Twilio is forced over its threshold.
 */
const NIGHT = Temporal.Instant.from("2026-09-26T02:41:00Z");
const vendorSweep = async () => {
  const pool = new pg.Pool({
    connectionString:
      process.env["APP_DATABASE_URL"] ?? "postgres://app_rw:app_rw@localhost:5432/west4",
    max: 2,
  });
  try {
    await sweepVendorHealth(pool, NIGHT, loadVendorHealthSettings({}));
  } finally {
    await pool.end();
  }
};
const forceVendorErrors = (
  db: pg.Client,
  vendor: "stripe" | "twilio",
  calls: number,
  errors: number,
) =>
  db.query(
    `insert into vendor_calls (venue_id, vendor, minute, calls, errors)
     select id, $1, $2, $3, $4 from venues where name = 'West 4 Boho Karaoke'
     on conflict (venue_id, vendor, minute) do update set calls = excluded.calls, errors = excluded.errors`,
    [vendor, NIGHT.toString(), calls, errors],
  );
/**
 * The router (M8-02): linked to its maker's API, and the router sweep run as
 * the worker runs it, with the maker answering that the wired line is
 * unplugged (on LTE) or plugged back in.
 */
const routerOnLte = async (db: pg.Client, on: boolean) => {
  await db.query(
    `insert into router_links (device_id, venue_id, maker, maker_org_id, maker_device_id)
     select id, venue_id, 'peplink', 'org-e2e', 'router-e2e' from devices where kind = 'router'
     on conflict (device_id) do nothing`,
  );
  const pool = new pg.Pool({
    connectionString:
      process.env["APP_DATABASE_URL"] ?? "postgres://app_rw:app_rw@localhost:5432/west4",
    max: 2,
  });
  try {
    await sweepRouters(
      pool,
      {
        adapter: { read: async () => ({ backupReady: true, onBackupNow: on }) },
        ipOwner: async () => null,
      },
      NIGHT,
    );
  } finally {
    await pool.end();
  }
};
const AMBER = "On backup internet · card readers may take up to 2 min to switch";
const PINK = "Offline · read-only · orders queue with an offline code";
const STRIPE_TROUBLE = "Stripe is having trouble · card payments may fail";

test("the router on LTE: the amber banner on the Board, the bar POS and the bar orders screen, and the night goes on", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await routerOnLte(db, true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    const amber = page.getByTestId("banner-backup");
    await expect(amber).toHaveText(AMBER);
    await expect(page.getByTestId("sync-footer")).toHaveText(
      /^On backup internet · synced \d+ s ago$/,
    );
    await expect(page.getByRole("listitem", { name: "Room 9", exact: true })).toBeVisible();
    for (const [path, heading] of [
      ["/bar", "Bar POS"],
      ["/bar-orders", "Bar orders"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      await expect(amber).toHaveText(AMBER);
      await expect(page.getByTestId("banner-offline")).toHaveCount(0);
    }
    // Everything else keeps working.
    await page.getByRole("button", { name: "Mute the chime for 60 s" }).click();
    await expect(
      page.getByRole("button", { name: /^Chime muted · back in \d+ s$/ }),
    ).toBeDisabled();
    // Other screens don't carry the outage banners.
    await page.goto("/calls");
    await expect(page.getByTestId("banner-backup")).toHaveCount(0);
    // The line comes back.
    await routerOnLte(db, false);
    await page.goto("/tonight");
    await expect(page.getByTestId("sync-footer")).toHaveText(/^Online · synced \d+ s ago$/);
    await expect(amber).toHaveCount(0);
    expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("works offline");
  } finally {
    await db.end();
  }
});

test("our API unreachable from the bar computer: the pink banner on the bar POS until it answers again", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    // The bar computer: the API host blocked.
    await signInMayaAtTheBar(page, request, db);
    await expect(page.getByTestId("banner-offline")).toHaveCount(0);
    await page.route("**/v1/**", (route) => route.abort());
    await expect(page.getByTestId("banner-offline")).toHaveText(PINK, { timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");
    await page.unroute("**/v1/**");
    await expect(page.getByTestId("banner-offline")).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await db.end();
  }
});

test("the Board offline: the browser loses the network, the pink banner shows, and the footer keeps the last sync", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    const footer = page.getByTestId("sync-footer");
    await expect(footer).toHaveText(/^Online · synced \d+ s ago$/);
    await page.context().setOffline(true);
    await expect(page.getByTestId("banner-offline")).toHaveText(PINK);
    // The board stays readable, and the footer counts on from the last sync.
    await expect(page.getByRole("listitem", { name: "Room 9", exact: true })).toBeVisible();
    await expect(footer).toHaveText(/^Offline · synced ([3-9]|\d\d) s ago$/, { timeout: 15_000 });
    await page.context().setOffline(false);
    await expect(page.getByTestId("banner-offline")).toHaveCount(0, { timeout: 20_000 });
    await expect(footer).toHaveText(/^Online · synced \d+ s ago$/);
    // The API host blocked instead: the same banner once a poll goes unanswered.
    await page.route("**/v1/**", (route) => route.abort());
    await expect(page.getByTestId("banner-offline")).toHaveText(PINK, { timeout: 20_000 });
    await expect(footer).toHaveText(/^Offline · synced \d+ s ago$/);
  } finally {
    await db.end();
  }
});

test("Stripe's error rate over its threshold: the banner on the Board, the bar POS, bar orders and a phone, in Spanish too, then cleared", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    await forceVendorErrors(db, "stripe", 10, 4);
    await vendorSweep();
    const banner = page.getByTestId("banner-stripe");
    await expect(banner).toHaveText(STRIPE_TROUBLE, { timeout: 20_000 });
    for (const path of ["/bar", "/bar-orders"]) {
      await page.goto(path);
      await expect(banner).toHaveText(STRIPE_TROUBLE);
    }
    // A staff phone.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/calls");
    await expect(banner).toHaveText(STRIPE_TROUBLE);
    expect(await clippedText(page)).toEqual([]);
    // Spanish.
    await db.query("update memberships set locale = 'es'");
    await page.reload();
    await expect(banner).toHaveText(catalogs.es["connection.banner.stripe"]);
    await db.query("update memberships set locale = 'en'");
    // Cleared: the errors stop, the next check hides the banner.
    await db.query("delete from vendor_calls");
    await vendorSweep();
    await page.reload();
    await expect(page.getByTestId("banner-stripe")).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await db.end();
  }
});

test("Twilio trouble: Texts are delayed, Text still works, and Amara B.'s failed Room ready text reads Not delivered · Call", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    await forceVendorErrors(db, "twilio", 5, 5);
    await vendorSweep();
    await expect(page.getByTestId("banner-twilio")).toHaveText("Texts are delayed", {
      timeout: 20_000,
    });
    const band = page.getByRole("list", { name: "Alerts" });
    await band.getByRole("button", { name: "Offer Room 11 · 10 min to claim" }).click();
    const drawer = page.getByRole("complementary", { name: "Waitlist" });
    const amara = drawer.getByRole("listitem", { name: "Amara B." });
    await expect(amara.getByRole("timer")).toHaveText(/^Room 11 · (10:00|9:\d\d) to claim$/);
    const text = await db.query<{ id: string }>(
      "select m.id from messages m join message_templates t on t.id = m.template_id where t.key = 'room_ready' order by m.created_at desc limit 1",
    );
    // The room-ready text was still queued to send; Twilio then reports it failed.
    expect(text.rows).toHaveLength(1);
    await db.query("update messages set status = 'failed' where id = $1", [text.rows[0]!.id]);
    await page.reload();
    await expect(page.getByTestId("banner-twilio")).toHaveText("Texts are delayed");
    await page.getByRole("button", { name: /^Waitlist · \d$/ }).click();
    await expect(amara).toContainText("Not delivered · Call (347) 555-0177");
  } finally {
    await db.end();
  }
});

/**
 * Offline codes on Andy's phone (M8-04; screens N29): the bar computer has set up its secret while
 * online; Andy's phone fetches and keeps its codes, and with our API unreachable still shows the bar
 * computer's code right now, the one the bar computer itself accepts.
 */
test("Offline codes: Andy's phone keeps the bar computer's codes and shows them with our API down", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const venueId = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    // The bar computer, with a key this test holds, sets up its offline-code secret.
    const key = await makeDeviceKey();
    const bar = (
      await db.query<{ id: string }>(
        "update devices set public_key = $2 where venue_id = $1 and kind = 'bar_computer' returning id",
        [venueId, JSON.stringify(key.publicJwk)],
      )
    ).rows[0]!.id;
    const path = `/v1/venues/${venueId}/devices/offline-secret`;
    const body = JSON.stringify({ fingerprint: null });
    const signed = await signDeviceRequest({
      deviceId: bar,
      privateKey: key.privateKey,
      method: "POST",
      path,
      body,
    });
    const setup = await request.post(path, {
      headers: { ...signed, "content-type": "application/json" },
      data: body,
    });
    expect(setup.status(), await setup.text()).toBe(200);
    const secret = ((await setup.json()) as { secret: string }).secret;
    const hmac = (k: string, m: string) =>
      createHmac("sha256", Buffer.from(k, "hex")).update(m).digest();
    const expected = async () => {
      const now = ((await (await request.get("/v1/health")).json()) as { server_time: string })
        .server_time;
      const code = offlineCodeAt(
        hmac,
        secret,
        { deviceId: bar, timeZone: "America/New_York", dayCutover: "06:00" },
        Temporal.Instant.from(now),
      );
      return `${code.slice(0, 3)} ${code.slice(3)}`;
    };

    await signInAndy(page, request, db);
    await page.getByRole("link", { name: "Offline codes" }).click();
    const card = page.getByRole("listitem", { name: "Bar computer" });
    await expect(card.getByRole("heading")).toHaveText("Bar computer · code now");
    await expect(card.getByTestId("code-bar_computer")).toHaveText(await expected());
    await expect(card).toContainText(/Changes at \d+:\d\d [AP]M/);
    await expect(page.getByText(/Kept on this phone · fetched at/)).toBeVisible();

    // Our API stops answering: the phone still shows the code it kept.
    await page.route("**/v1/**", (route) => route.abort());
    await page.getByRole("link", { name: "Calls" }).click();
    await page.getByRole("link", { name: "Offline codes" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Couldn't fetch the codes. The ones kept on this phone still work.",
    );
    await expect(card.getByTestId("code-bar_computer")).toHaveText(await expected());
  } finally {
    await db.end();
  }
});

/**
 * The replay (M8-05): the bar computer uploads four rounds it queued in the outage, signed as
 * itself. Three on Luis M.'s tab land as asked to wait under "Confirm replayed orders (3)" on the
 * bar POS and the bar orders screen, off the tab until accepted; the fourth, queued on Thursday's
 * night, goes to Review after outage on Close the night, first, with its reason, and Andy posts
 * its offline cash on the tab.
 */
test("Confirm replayed orders (3) on the bar POS and bar orders, and Review after outage on Close the night", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  const db = await dbClient();
  try {
    await setClock(request, "2026-09-26T02:41:00Z");
    const venueId = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    const luis = (
      await db.query<{ id: string; check_id: string }>(
        "select id, check_id from tabs where venue_id = $1 and name = 'Luis M.'",
        [venueId],
      )
    ).rows[0]!;
    const jager = (
      await db.query<{ id: string }>(
        `select v.id from menu_variants v join menu_items i on i.id = v.item_id
          where i.venue_id = $1 and i.name = 'Jäger Bomb' limit 1`,
        [venueId],
      )
    ).rows[0]!.id;
    const maya = (
      await db.query<{ id: string }>(
        "select m.id from memberships m join users u on u.id = m.user_id where m.venue_id = $1 and u.name = 'Maya S.'",
        [venueId],
      )
    ).rows[0]!.id;
    const key = await makeDeviceKey();
    const deviceId = (
      await db.query<{ id: string }>(
        "insert into devices (venue_id, kind, name, public_key) values ($1, 'bar_computer', 'Bar computer 2', $2) returning id",
        [venueId, JSON.stringify(key.publicJwk)],
      )
    ).rows[0]!.id;
    const round = (queuedAt: string, cash: string | null) => ({
      order_id: crypto.randomUUID(),
      queued_at: queuedAt,
      tab_id: luis.id,
      check_id: luis.check_id,
      tab_name: "Luis M.",
      staff: { membership_id: maya, name: "Maya S." },
      lines: [{ variant_id: jager, name: "Jäger Bomb", qty: 1, unit_cents: 1200, alcohol: true }],
      cash_note: cash,
    });
    const path = `/v1/venues/${venueId}/offline-orders/replay`;
    const body = JSON.stringify({
      orders: [
        round("2026-09-26T02:20:00Z", null),
        round("2026-09-26T02:25:00Z", null),
        round("2026-09-26T02:30:00Z", null),
        round("2026-09-25T02:30:00Z", "$12 cash · Maya"),
      ],
    });
    const replayed = await request.post(path, {
      headers: {
        ...(await signDeviceRequest({
          deviceId,
          privateKey: key.privateKey,
          method: "POST",
          path,
          body,
        })),
        "content-type": "application/json",
      },
      data: body,
    });
    expect(replayed.ok()).toBe(true);
    expect(
      ((await replayed.json()) as { results: { outcome: string }[] }).results.map((r) => r.outcome),
    ).toEqual(["held", "held", "held", "failed"]);

    // Andy on Close the night: the failed replay first, with its reason; he posts its cash.
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    await page.goto("/close-the-night");
    const review = page.getByRole("region", { name: "Review after outage" });
    const rows = review.getByTestId("review-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText("Failed replay · queued on an earlier night");
    await expect(rows.first()).toContainText("Offline cash to post: $12 cash · Maya");
    await expect(rows.nth(1)).toContainText("Replayed · asked to wait");
    await rows.first().getByLabel("Cash amount").fill("12.00");
    await rows.first().getByRole("button", { name: "Post cash" }).click();
    await expect(rows.first()).toContainText("Cash posted · $12.00 · Andy C.");

    // Maya at the bar: the banner and the list, each asked to wait.
    const bar = await browser.newContext({ baseURL: "http://localhost:5173" });
    const barPage = await bar.newPage();
    try {
      await signInMayaAtTheBar(barPage, request, db);
      await expect(barPage.getByTestId("banner-replayed")).toHaveText(
        "Confirm replayed orders (3)",
        { timeout: 20_000 },
      );
      const list = barPage.getByRole("region", { name: "Confirm replayed orders (3)" });
      await expect(list.getByTestId("replayed-order")).toHaveCount(3);
      await expect(list.getByTestId("replayed-order").first()).toContainText(
        "Luis M. · 1 × Jäger Bomb · $12.00",
      );
      await expect(list.getByTestId("replayed-order").first()).toContainText(
        /Asked to wait · queued by Maya S\. at 10:20/,
      );
      const lines = async () =>
        (
          await db.query<{ n: number }>(
            "select count(*)::int as n from check_lines where check_id = $1 and kind = 'item' and description = 'Jäger Bomb'",
            [luis.check_id],
          )
        ).rows[0]!.n;
      const before = await lines();
      // One also rung online during the outage: cancel the copy. Another is accepted: the sale.
      await list
        .getByTestId("replayed-order")
        .first()
        .getByRole("button", { name: "Cancel copy" })
        .click();
      await barPage
        .getByRole("region", { name: "Confirm replayed orders (2)" })
        .getByTestId("replayed-order")
        .first()
        .getByRole("button", { name: "Accept · print ticket" })
        .click();
      await expect(
        barPage.getByRole("region", { name: "Confirm replayed orders (1)" }),
      ).toBeVisible();
      expect(await lines()).toBe(before + 1);
      // The bar orders screen lists the one still waiting, and not in its Waiting column too.
      await barPage.goto("/bar-orders");
      await expect(
        barPage
          .getByRole("region", { name: "Confirm replayed orders (1)" })
          .getByTestId("replayed-order"),
      ).toHaveCount(1);
      await expect(barPage.getByTestId("banner-replayed")).toHaveText(
        "Confirm replayed orders (1)",
        { timeout: 20_000 },
      );
    } finally {
      await bar.close();
    }
  } finally {
    await db.end();
  }
});

/**
 * The break-glass card (M8-06; spec 09 · Break-glass card): with Andy's and Abhishek's Dashboard
 * logins and Tap to Pay phones confirmed on the go-live checklist, Close the night names them as
 * ready, saves the letter-size card as a PDF, and sends the short version to the front-desk printer.
 */
test("Close the night: the break-glass card names Andy and Abhishek as ready and prints", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    const venueId = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    await db.query(
      `insert into setup_checks (venue_id, key, status, confirmed_by, confirmed_at)
       select $1, c.k || ':' || s.row_id, 'passed', o.row_id, '2026-09-20T16:00:00Z'
         from seed_ids s cross join (values ('dashboard_login'), ('tap_to_pay')) c(k)
         cross join (select row_id from seed_ids where venue_id = $1 and slug = 'abhishek') o
        where s.venue_id = $1 and s.slug in ('abhishek', 'andy')
       on conflict (venue_id, key) do update set status = 'passed'`,
      [venueId],
    );
    await signInAndy(page, request, db);
    await page.goto("/close-the-night");
    const card = page.getByRole("region", { name: "Break-glass card" });
    await expect(card).toContainText("Ready for Tap to Pay: Abhishek G., Andy C.");
    const download = page.waitForEvent("download");
    await card.getByRole("button", { name: "Print break-glass card" }).click();
    expect((await download).suggestedFilename()).toBe("break-glass-card.pdf");
    await card
      .getByRole("button", { name: "Print the short version on the receipt printer" })
      .click();
    await expect(card.getByRole("status")).toHaveText("Sent to the front-desk printer");
    const box = await card.getByRole("button", { name: "Print break-glass card" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  } finally {
    await db.query(
      "delete from setup_checks where key like 'dashboard_login:%' or key like 'tap_to_pay:%'",
    );
    await db.end();
  }
});

/**
 * The private help alert and the incident log (M8-08; screens N20; Board note 10): a guest in Room 9
 * asks for a manager privately from their own phone and sees "Sent to the managers" with "In an
 * emergency, call 911"; the Board shows "Manager needed · 1", with no room and no reason, at phone and
 * desktop sizes; Andy's Incidents tab shows Room 9, the time and the kind; he taps I'm on it, adds a
 * note and closes it, and the pin clears.
 */
test("Help alert: Room 9 asks privately, the Board pins Manager needed · 1, Andy takes it, notes it and closes it", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await db.query("delete from incident_notes");
    await db.query("delete from incidents");
    const hostToken = createHash("sha256")
      .update("host-token:sess_room9")
      .digest("base64url")
      .slice(0, 32);
    const guest = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    await guest.goto(`http://localhost:3001/r/${hostToken}`);
    await guest.getByRole("button", { name: "Need a manager, privately?" }).click();
    const sheet = guest.getByRole("dialog", { name: "Get help privately" });
    await expect(sheet).toContainText("Only the managers see what you send.");
    await sheet.getByRole("button", { name: "I feel unsafe" }).click();
    const sent = guest.getByRole("dialog", { name: "Sent to the managers" });
    await expect(sent.getByRole("status")).toHaveText(
      "A manager is coming to find you. Stay wherever you feel comfortable, or come to the front desk.",
    );
    await expect(sent.getByRole("link", { name: "In an emergency, call 911" })).toHaveAttribute(
      "href",
      "tel:911",
    );
    await guest.context().close();

    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndy(page, request, db);
    const pin = page.locator(".manager-needed");
    await expect(pin).toHaveText("Manager needed · 1");
    expect((await pin.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(pin).toHaveText("Manager needed · 1");
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByRole("link", { name: "Incidents" }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Incidents");
    const card = page.getByRole("listitem", { name: "Room 9 · A guest feels unsafe" });
    await expect(card).toContainText(/From the room page · \d+:\d\d [AP]M/);
    await expect(card).toContainText("Open");
    await card.getByRole("button", { name: "I’m on it" }).click();
    await expect(card).toContainText("Andy C. is on it");
    await card.getByLabel("Note for the incident log").fill("Walked her to a cab with her friend.");
    await card.getByRole("button", { name: "Add to the log" }).click();
    await expect(card).toContainText("Walked her to a cab with her friend.");
    await card.getByRole("button", { name: "Close" }).click();
    const log = page.getByRole("region", { name: "Incident log" });
    const closed = log.getByRole("listitem", { name: "Room 9 · A guest feels unsafe" });
    await expect(closed).toContainText(/Closed by Andy C\./);
    await expect(closed).toContainText(/Kept until Sep 2[56], 2029/);
    await expect(log).toContainText("Each incident is kept 3 years after it’s closed.");

    await page.getByRole("link", { name: "Rooms" }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await expect(page.locator(".manager-needed")).toHaveCount(0);
  } finally {
    await db.query("delete from incident_notes");
    await db.query("delete from incidents");
    await db.end();
  }
});

/**
 * Admin → Licenses (M8-09; screens N35): the register starts empty on the demo
 * seed and names the music and liquor licenses not on file yet. Andy adds a
 * test ASCAP license (fixture values, not West 4's) with its number, holder,
 * expiry, fee, conditions and a PDF copy; a Word file is refused.
 */
test("Admin → Licenses: empty with a hint on the seed; Andy adds a license with a PDF copy, and a Word file is refused", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(page, request, db);
    await page.goto("/admin/licenses");
    const register = page.getByRole("region", { name: "Licenses" });
    await expect(register.getByTestId("licenses-missing")).toHaveText(
      "Not on file yet: ASCAP, BMI, SESAC, GMR, Liquor. Add each one from the license itself.",
    );
    await expect(register.getByText("No licenses yet.")).toBeVisible();

    await register.getByRole("button", { name: "Add a license" }).click();
    await register.getByLabel("Kind").selectOption("ascap");
    await register.getByLabel("Number").fill("E2E-ASCAP-1");
    await register.getByLabel("Holder").fill("E2E Holder LLC");
    await register.getByLabel("Expires").fill("2026-10-25");
    await register.getByLabel("Fee").fill("100.00");
    await register.getByLabel("Conditions").fill("E2E conditions");
    const copy = register.getByLabel("Copy (PDF, JPEG or PNG, up to 20 MB)");
    await copy.setInputFiles({
      name: "license.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("not a pdf"),
    });
    await register.getByRole("button", { name: "Save" }).click();
    await expect(register.getByRole("alert")).toHaveText(
      "A copy must be a PDF, JPEG or PNG, up to 20 MB.",
    );
    await copy.setInputFiles({
      name: "license.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%e2e\n"),
    });
    await register.getByRole("button", { name: "Save" }).click();

    const item = register.getByRole("listitem", { name: "ASCAP" });
    await expect(item).toContainText("E2E-ASCAP-1");
    await expect(item).toContainText("E2E Holder LLC");
    await expect(item).toContainText("in 30 days");
    await expect(item).toContainText("$100.00");
    await expect(item).toContainText("E2E conditions");
    await expect(item.getByRole("button", { name: "View copy" })).toBeVisible();
    await expect(register.getByTestId("licenses-missing")).toHaveText(
      "Not on file yet: BMI, SESAC, GMR, Liquor. Add each one from the license itself.",
    );
  } finally {
    await db.end();
  }
});

/**
 * Admin → Console (M8-10; screens N39): a request from our support staff waits
 * for Abhishek, the owner, who approves it in Admin; a banner shows across
 * Admin while it's open, and End now ends it at once. Andy, a manager, has no
 * Console section.
 */
test("Admin → Console: Abhishek approves a support request, the banner shows, End now ends it; Andy has no Console", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  try {
    await db.query("delete from support_grants where reason like 'E2E %'");
    await db.query(
      `insert into support_grants (venue_id, staff_id, requested_by, reason, scope, minutes, requested_at)
       select v.id, s.id, s.id, 'E2E checking a stuck ticket', 'read', 30, now()
         from venues v, console_staff s where v.slug = 'west4karaoke' and s.email = 'support@demo.west4.local'`,
    );
    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await page.goto("/admin/console");
    const section = page.getByRole("region", { name: "Console" });
    const item = section.getByRole("listitem", { name: "From Noraymi support" }).first();
    await expect(item).toContainText("Waiting for you");
    await expect(item).toContainText("Reason: E2E checking a stuck ticket");
    await expect(item).toContainText("Read only · 30 min");
    await item.getByRole("button", { name: "Approve" }).click();
    await expect(item).toContainText("Open · 30 min left");
    await page.reload();
    await expect(page.getByTestId("support-banner")).toContainText(
      "Support access is open · Noraymi support · 30 min left",
    );
    await item.getByRole("button", { name: "End now" }).click();
    await expect(item).toContainText("Ended early");
    await page.reload();
    await expect(section.getByRole("listitem").first()).toContainText("Ended early");
    await expect(page.getByTestId("support-banner")).toHaveCount(0);
    const row = await db.query<{ status: string; revoked_side: string }>(
      "select status, revoked_side from support_grants where reason = 'E2E checking a stuck ticket'",
    );
    expect(row.rows[0]).toEqual({ status: "revoked", revoked_side: "venue" });

    // Emergency actions (M8-11): what our side ran, who asked, who approved, and why; read-only here.
    await db.query(
      `insert into console_staff (name, email) values ('Ben on call', 'oncall@demo.west4.local')
         on conflict ((lower(email))) do update set active = true`,
    );
    await db.query(
      `insert into emergency_actions (venue_id, action, target, reason, requested_by, requested_at, expires_at,
                                      status, decided_by, decided_at, done_at, result)
       select v.id, 'requeue_print', gen_random_uuid()::text, 'E2E bar ticket lost at 2:50 AM', a.id, now(),
              now() + interval '15 minutes', 'done', b.id, now(), now(), '{}'
         from venues v, console_staff a, console_staff b
        where v.slug = 'west4karaoke' and a.email = 'support@demo.west4.local' and b.email = 'oncall@demo.west4.local'`,
    );
    await page.reload();
    const emergency = page.getByRole("region", { name: "Emergency actions" });
    const ran = emergency.getByRole("listitem", { name: "Requeue a print" }).first();
    await expect(ran).toContainText("Done");
    await expect(ran).toContainText("Reason: E2E bar ticket lost at 2:50 AM");
    await expect(ran).toContainText("Asked by Noraymi support · Approved by Ben on call");
    await expect(ran.getByRole("button")).toHaveCount(0);

    // Andy's Admin has no Console section.
    const andy = await browser.newContext({ baseURL: "http://localhost:5173" });
    const andyPage = await andy.newPage();
    await andyPage.setViewportSize({ width: 1280, height: 800 });
    await signInAndy(andyPage, andy.request, db);
    await andyPage.goto("/admin/features");
    await expect(andyPage.getByRole("link", { name: /^Features/ })).toBeVisible();
    await expect(andyPage.getByRole("link", { name: /^Console/ })).toHaveCount(0);
    await andy.close();
  } finally {
    await db.query("delete from support_grants where reason like 'E2E %'");
    await db.query("delete from emergency_actions where reason like 'E2E %'");
    await db.end();
  }
});

/**
 * Our plan (M8-15; spec 03 · Plan billing): West 4 on the Rooms plan on the
 * fake Stripe, counting its 14 rooms. A failed plan payment (the billing
 * event's effect, as plan-billing.int.test.ts applies it from Stripe) shows
 * the banner in Admin; 14 days later on the simulated clock Admin refuses
 * Save and publish with the reason, while the board and the bar POS keep
 * working; paid, the banner goes and Admin saves again. The prices are the
 * test's own made-up amounts on the fake, never our plan's.
 */
test("Our plan: a failed payment shows the banner, Admin turns read-only 14 days later while the board and bar work, and paying clears it", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const db = await dbClient();
  const owner = new pg.Pool({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
    max: 2,
  });
  const stripe = new StripeClient(fakeStripeSettings());
  const billing = <T>(path: string, params: Record<string, unknown>) =>
    stripe.call<T>("billing", "POST", path, {
      account: null,
      params,
      idempotencyKey: `e2e:${randomBytes(8).toString("hex")}`,
    });
  const baseVersion = (
    await db.query<{ v: number }>(
      "select coalesce(max(version), 0)::int as v from venue_settings where key = 'rooms'",
    )
  ).rows[0]!.v;
  try {
    await db.query("delete from venue_subscriptions");
    await db.query("update organizations set billing_customer_id = null");
    for (const key of [PLAN_LOOKUP_KEYS.rooms, ROOM_LOOKUP_KEY])
      await billing("/v1/prices", { currency: "usd", unit_amount: 100, lookup_key: key });
    const customer = (
      await billing<{ id: string }>("/v1/customers", { name: "West 4 Boho Karaoke" })
    ).id;
    await billing(`/v1/customers/${customer}`, {
      invoice_settings: { default_payment_method: "pm_card_visa" },
    });
    const venueId = (
      await db.query<{ id: string }>("select id from venues where slug = 'west4karaoke'")
    ).rows[0]!.id;
    await db.query(
      "update organizations set billing_customer_id = $1 where id = (select org_id from venues where id = $2)",
      [customer, venueId],
    );
    const made = await subscribeVenue(owner, stripe, { venueId, plan: "rooms" });
    expect(made.rooms).toBe(14);
    // The plan payment fails at 10:41 PM.
    await db.query(
      "update venue_subscriptions set status = 'past_due', payment_failed_at = $1 where venue_id = $2",
      ["2026-09-26T02:41:00Z", venueId],
    );

    await db.query("update memberships set locale = 'en'");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await enrolPasskey(page, request, db, ABHISHEK);
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await page.goto("/admin/payments");
    const banner = page.getByTestId("plan-banner");
    await expect(banner).toHaveText(
      "Our plan's payment failed · Admin turns read-only on Sat, Oct 10 at 6:00 AM unless it's paid Pay it in Payments",
    );
    const plan = page.getByRole("region", { name: "Our plan" });
    await expect(plan).toContainText("Rooms plan");
    await expect(plan).toContainText("14 rooms counted · every room that isn't archived");
    await expect(plan).toContainText("Paid with visa ending 4242");
    await expect(plan.getByRole("button", { name: "Manage our plan" })).toBeVisible();
    // Admin still saves until the 14 days are up.
    await page.goto("/admin/rooms");
    await page.getByLabel("Flag a room still cleaning after (minutes)").fill("10");
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(page.getByText("Published")).toBeVisible();

    // 14 days later, at the 6:00 AM cutover: Admin is read-only.
    await resetClock("2026-10-10T10:00:00Z");
    // Two weeks on, the 12-hour sign-in is over: Abhishek signs in again.
    await page.goto("/");
    await page.getByLabel("Email").fill(ABHISHEK);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await page.goto("/admin/rooms");
    await expect(banner).toHaveText(
      "Admin is read-only · our plan's payment failed on Fri, Sep 25 · the board, rooms, bar and payments keep working Pay it in Payments",
    );
    await page.getByLabel("Flag a room still cleaning after (minutes)").fill("12");
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(
      page.getByText("Admin is read-only until our plan's invoice is paid"),
    ).toBeVisible();
    // The board, rooms and the bar POS keep working.
    await page.goto("/tonight");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await expect(page.getByRole("listitem", { name: "Room 9", exact: true })).toBeVisible();
    await page.goto("/bar");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bar POS");
    const tabs = await page.request.get(`http://localhost:3000/v1/venues/${venueId}/tabs`);
    expect(tabs.status()).toBe(200);

    // Paid: the banner goes and Admin saves again.
    await db.query(
      "update venue_subscriptions set status = 'active', payment_failed_at = null where venue_id = $1",
      [venueId],
    );
    await page.goto("/admin/rooms");
    await page.getByLabel("Flag a room still cleaning after (minutes)").fill("12");
    await page.getByRole("button", { name: "Save and publish" }).click();
    await expect(page.getByText("Published")).toBeVisible();
    await expect(banner).toHaveCount(0);
  } finally {
    await resetClock();
    await db.query("delete from venue_subscriptions");
    await db.query("update organizations set billing_customer_id = null");
    await db.query("delete from venue_settings where key = 'rooms' and version > $1", [
      baseVersion,
    ]);
    await owner.end();
    await db.end();
  }
});

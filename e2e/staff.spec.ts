import { expect, test, type Browser, type Page, type APIRequestContext } from "@playwright/test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { SoftwarePasskey } from "../apps/api/src/auth/test-passkey.js";
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
  "/admin/connections",
  "/admin/payments",
];
const SCREENS = ["/tonight", "/bar", "/runs", "/setup", "/admin", "/sign-in"];

/**
 * Every test starts from a fresh load of the demo seed at 10:41 PM, whatever
 * the test before it did (M2-35): the seed's tables, and the API's simulated
 * clock.
 */
test.beforeEach(async ({ request }) => {
  execSync("pnpm seed", { stdio: "ignore" });
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
  kind: "bar_computer" | "front_desk",
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
          enOnly.some((m) => m.test(text)),
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
    await expect(thread.getByRole("alert")).toHaveText("A reply can't carry a link");
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
    await expect(page.getByText("Minimum spend: off.")).toBeVisible();
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
    await fix.getByLabel("Reason").fill("Spilled on the way");
    await fix.getByRole("button", { name: "Comp it" }).click();
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

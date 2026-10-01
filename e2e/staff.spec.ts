import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
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
];
const SCREENS = ["/tonight", "/bar", "/runs", "/setup", "/admin", "/sign-in"];

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
        "select name from rooms union all select name from guests union all select text from room_faults",
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
    await page.getByRole("link", { name: "Admin" }).click();
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
    await andyPage.getByRole("link", { name: "Admin" }).click();
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
 * Rule-pack versions (M1-36). Two of our staff approve 2026.10 in the Console
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
    await db.query("delete from rule_packs where version = '2026.10'");
    await db.query("delete from rule_pack_drafts where version = '2026.10'");
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
    // Our two staff sign in to the Console's API, each with a security key, and publish 2026.10.
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
          version: "2026.10",
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
      page.getByText("Rules update 2026.10 starts Sat, Sep 26 (business date)"),
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

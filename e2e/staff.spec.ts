import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
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
const ABHISHEK = "abhishek@demo.west4.local";
/** The Admin sections shipped so far; each M1 Admin ticket adds its path to the Spanish check. */
const ADMIN_SECTIONS = ["/admin/team", "/admin/features", "/admin/hours"];
const SCREENS = ["/tonight", "/bar", "/runs", "/setup", "/admin", "/sign-in"];

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
  expect((await request.post("/v1/auth/enroll", { data: { step: "start", email } })).ok()).toBe(
    true,
  );
  const job = await db.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [email],
  );
  const code = job.rows[0]!.payload.data.code;
  const options = (await (
    await request.post("/v1/auth/enroll", { data: { step: "passkey_options", email, code } })
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
    const names = new Set(
      (await db.query<{ name: string }>("select name from users")).rows.map((r) => r.name),
    );
    const data = new Set(["West 4 Boho Karaoke", "English", "Español", "☰", ...names]);
    for (const path of ADMIN_SECTIONS) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Cargando" })).toHaveCount(0);
      // innerText joins a table row's cells with tabs: check each cell on its own.
      const cells = (await visibleTexts(page)).flatMap((line) =>
        line.split("\t").map((c) => c.trim()),
      );
      for (const text of cells) {
        if (
          text === "" ||
          data.has(text) ||
          text.includes("@") ||
          /^\d{1,2}:\d{2}\s?([ap]\.\s?m\.|[AP]M)$/.test(text)
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

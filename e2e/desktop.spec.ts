import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import pg from "pg";
import { offlineCodeAt } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { loadConfig } from "../apps/api/src/config.js";
import { decryptSecret } from "../packages/db/src/auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..", "apps", "desktop");

/**
 * The desktop shell's security checklist (M1-28, spec 12 · 10), one check
 * each: the staff app opens; the page can't reach Node.js; navigation to a
 * host that isn't ours is blocked and new windows are denied; an IPC message
 * from an unexpected frame is refused; the token the shell keeps is in no
 * plain file on disk.
 */
async function launch(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [desktopDir],
    env: { ...process.env, STAFF_URL: "http://localhost:5173", WEST4_USER_DATA: userData },
  });
}

/** Every file under a directory, read as text. */
function filesUnder(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const file = path.join(d, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.push({ file, text: readFileSync(file, "latin1") });
    }
  };
  walk(dir);
  return out;
}

test("the desktop app opens the staff app, with no Node.js in the page", async () => {
  const app = await launch(mkdtempSync(path.join(tmpdir(), "west4-desktop-")));
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    const reach = await page.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: typeof (globalThis as { west4?: { desktop?: boolean } }).west4?.desktop,
    }));
    expect(reach).toEqual({ require: "undefined", process: "undefined", bridge: "boolean" });
    const isolated = await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
        getLastWebPreferences():
          { contextIsolation?: boolean; sandbox?: boolean; nodeIntegration?: boolean } | undefined;
      };
      const prefs = contents.getLastWebPreferences();
      return {
        contextIsolation: prefs?.contextIsolation,
        sandbox: prefs?.sandbox,
        nodeIntegration: prefs?.nodeIntegration,
      };
    });
    expect(isolated).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false });
  } finally {
    await app.close();
  }
});

test("navigating to a host that isn't ours is blocked, and new windows are denied", async () => {
  const app = await launch(mkdtempSync(path.join(tmpdir(), "west4-desktop-")));
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    await page.evaluate(() => {
      window.location.assign("https://example.com/");
    });
    await page.waitForTimeout(1000);
    expect(new URL(page.url()).origin).toBe("http://localhost:5173");
    const opened = await page.evaluate(() => window.open("https://example.com/") === null);
    expect(opened).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await app.close();
  }
});

test("an IPC message from an unexpected frame is refused; the token is kept in no plain file", async () => {
  const userData = mkdtempSync(path.join(tmpdir(), "west4-desktop-"));
  const app = await launch(userData);
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    const token = "bearer-test-token-" + Math.random().toString(36).slice(2);
    await page.evaluate((t) => window.west4!.token.set(t), token);
    expect(await page.evaluate(() => window.west4!.token.get())).toBe(token);
    const stored = await app.evaluate(({ app: a }) => a.getPath("userData"));
    const plain = filesUnder(stored).filter((f) => f.text.includes(token));
    expect(plain.map((f) => f.file)).toEqual([]);

    // A page that isn't ours (the API's origin, not the staff app's), with the same preload:
    // the bridge is there, and the main process refuses it by its sender.
    const preload = path.join(desktopDir, "dist", "preload.cjs");
    const refused = await app.evaluate(async ({ BrowserWindow }, preloadPath) => {
      const stranger = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      await stranger.loadURL("http://127.0.0.1:3000/v1/health");
      const answer = await stranger.webContents.executeJavaScript(
        `(() => { try { return window.west4.token.get().then(() => "allowed", (e) => String(e)); } catch (e) { return "no bridge: " + String(e); } })()`,
      );
      stranger.destroy();
      return answer as string;
    }, preload);
    expect(refused).toMatch(/refused/);
  } finally {
    await app.close();
  }
});

/**
 * Badges on the desktop (M1-30): with the fake reader, the owner pairs a new
 * badge to a person from Admin → Team in one tap, and a tap on that badge
 * then takes over the paired screen within 2 seconds. The real reader and
 * badge are checked on the staging bar computer.
 */
test("a badge is paired in Admin → Team in one tap, and a tap then takes over the bar computer", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(path.join(tmpdir(), "west4-desktop-"));
  const app = await electron.launch({
    args: [desktopDir],
    env: {
      ...process.env,
      STAFF_URL: "http://localhost:5173",
      WEST4_USER_DATA: userData,
      WEST4_FAKE_READER: "1",
    },
  });
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    // Pair the screen as the bar computer.
    const code = randomBytes(4).toString("hex").toUpperCase();
    const venue = await db.query<{ id: string }>("select id from venues limit 1");
    await db.query(
      "insert into device_pairing_codes (venue_id, code_hash, kind, name, expires_at) values ($1, $2, 'bar_computer', 'Bar computer', now() + interval '1 hour')",
      [venue.rows[0]!.id, createHash("sha256").update(code).digest("hex")],
    );
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page.getByLabel("Pairing code from Admin → Devices").fill(code);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");

    // The owner signs in with a passkey here (a virtual authenticator stands in for the phone).
    const email = "abhishek@demo.west4.local";
    await db.query(
      "delete from auth_credentials where user_id = (select id from users where lower(email) = $1)",
      [email],
    );
    await db.query("update memberships set locale = 'en'");
    const cdp = await app.context().newCDPSession(page);
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
    const api = "http://localhost:5173";
    // The sign-in routes allow 30 calls a minute from one address; the staff tests before this one
    // sign in many times, so a 429 here waits out the window instead of failing (the limit stays).
    const post = async (p: string, data: unknown) => {
      for (let i = 0; ; i++) {
        const r = await page.request.post(`${api}${p}`, { data });
        if (r.status() !== 429 || i >= 3) return r;
        await new Promise((done) => setTimeout(done, 20_000));
      }
    };
    expect((await post("/v1/auth/enroll", { step: "start", email })).ok()).toBe(true);
    const job = await db.query<{ payload: { data: { code: string } } }>(
      "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
      [email],
    );
    const emailCode = job.rows[0]!.payload.data.code;
    const options = (await (
      await post("/v1/auth/enroll", { step: "passkey_options", email, code: emailCode })
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
    const enrolled = await post("/v1/auth/enroll", {
      step: "passkey_finish",
      email,
      code: emailCode,
      credential: registration,
      name: "Desktop test",
      client: "desktop",
    });
    expect(enrolled.status(), await enrolled.text()).toBe(201);

    await page.getByRole("button", { name: "Owner or manager? Sign in with your passkey" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    // A new owner isn't on the clock, so the time clock comes first (M7-01).
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Time clock");
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    // Admin → Team: pair a new badge to Diego in one tap on the (fake) reader.
    await page.getByRole("link", { name: "Admin", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Team" })).toBeVisible();
    await expect(page.getByText("Readers on this computer: Emulated NFC reader")).toBeVisible();
    const diegoRow = page.getByRole("row").filter({ hasText: "Diego R." });
    await diegoRow.getByRole("button", { name: "Pair (tap the reader)" }).click();
    await expect(diegoRow.getByText("Tap the new badge on the reader…")).toBeVisible();
    const uid = "04DE5F1EACC040";
    await page.evaluate((u) => window.west4!.badge.fakeTap(u), uid);
    await expect(diegoRow.getByText(/Paired · Badge \d/)).toBeVisible({ timeout: 15_000 });
    const paired = await db.query<{ label: string }>(
      "select label from staff_badges where membership_id = (select m.id from memberships m join users u on u.id = m.user_id where u.name = 'Diego R.') order by paired_at desc limit 1",
    );
    expect(paired.rows[0]!.label).toMatch(/^Badge \d$/);

    // Lock, then a tap on the new badge takes over the screen within 2 seconds.
    await page.getByRole("button", { name: "Lock" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");
    const started = Date.now();
    await page.evaluate((u) => window.west4!.badge.fakeTap(u), uid);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight", { timeout: 5000 });
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(page.locator(".topbar .who")).toHaveText("Diego R. · Front desk");
  } finally {
    await db.end();
    await app.close();
  }
});

/**
 * The read-only offline view (M8-03): with our API blocked at 10:41 PM, the
 * bar computer still shows the board's counts, the five bar tabs at their
 * totals and the menu with Hoegaarden 86'd, every write control disabled with
 * the reason, under the pink banner. Locked, o1 and o2 keep aging and the
 * chime keeps going. The cache file on disk holds none of it in plain text.
 */
test("offline, the bar computer shows the board, open tabs and the menu read-only, and the locked screen keeps ringing", async () => {
  test.setTimeout(240_000);
  const { execSync } = await import("node:child_process");
  execSync("pnpm seed", { stdio: "ignore" });
  const userData = mkdtempSync(path.join(tmpdir(), "west4-desktop-"));
  const app = await launch(userData);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    await db.query("update memberships set locale = 'en'");
    const venueId = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
    const code = randomBytes(4).toString("hex").toUpperCase();
    await db.query(
      "insert into device_pairing_codes (venue_id, code_hash, kind, name, expires_at) values ($1, $2, 'bar_computer', 'Bar computer', now() + interval '1 hour')",
      [venueId, createHash("sha256").update(code).digest("hex")],
    );
    expect(
      (
        await page.request.post("http://localhost:5173/v1/ops/clock", {
          data: { server_time: "2026-09-26T02:41:00Z" },
        })
      ).ok(),
    ).toBe(true);
    await page.getByRole("button", { name: "Pair this screen" }).click();
    await page.getByLabel("Pairing code from Admin → Devices").fill(code);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");
    // The chime loop starts with the app on a paired screen, as it does every time the bar opens.
    await page.reload();
    await page.getByRole("button", { name: /Diego R\./ }).click();
    for (const digit of "6358")
      await page.locator(".keypad").getByRole("button", { name: digit, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");
    await expect(page.getByLabel("Room counts")).toHaveText(
      "8 in use · 3 open · 2 cleaning · 1 out of service",
    );

    // The desktop app has kept the night's reads, each open check's lines among them.
    const v = `/v1/venues/${venueId}`;
    const jess = (
      await db.query<{ check_id: string }>(
        "select t.check_id from tabs t where t.name = 'Jess P.' and t.state = 'open'",
      )
    ).rows[0]!.check_id;
    for (const p of [`${v}/board`, `${v}/tabs`, `${v}/menu`, `${v}/checks/${jess}`])
      await expect
        .poll(() => page.evaluate((x) => window.west4!.offline!.read(x).then(Boolean), p), {
          timeout: 20_000,
        })
        .toBe(true);

    // Our API stops answering: the line and LTE are down, or our cloud is.
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (d, done) =>
        done({ cancel: d.url.includes("/v1/") }),
      );
    });
    await expect(page.getByTestId("banner-offline")).toHaveText(
      "Offline · read-only · orders queue with an offline code",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("read-only-note")).toContainText(
      "Read-only while offline · changes wait for the connection · totals as of the last sync",
    );
    await expect(page.getByLabel("Room counts")).toHaveText(
      "8 in use · 3 open · 2 cleaning · 1 out of service",
    );

    // The bar POS from the cache: the five tabs at their totals, the menu with Hoegaarden 86'd.
    await page.getByRole("link", { name: "Bar POS" }).first().click();
    await expect(page.getByTestId("banner-offline")).toBeVisible();
    const tabs = page.getByRole("list", { name: "Bar tabs" });
    await expect(tabs.locator(".name")).toHaveCount(5);
    await expect(tabs.getByRole("button", { name: /Jess P\./ })).toContainText("$32.66");
    await expect(tabs.getByRole("button", { name: /Luis M\./ })).toContainText("$63.15");
    await page.getByRole("tab", { name: "Beer" }).click();
    await expect(page.getByRole("button", { name: "Hoegaarden · 86'd tonight" })).toBeDisabled();
    const bud = page.getByRole("button", { name: /^Bud Light · \$/ }).first();
    await expect(bud).toBeDisabled();
    await expect(bud).toHaveAttribute("title", "Offline · read-only: this needs the connection");
    await expect(page.getByRole("button", { name: "86", exact: true })).toBeDisabled();
    const orders = page.getByRole("list", { name: "Room orders waiting" }).getByRole("listitem");
    await expect(orders).toHaveCount(2);
    await expect(
      orders.nth(0).getByRole("button", { name: "Accept · print ticket" }),
    ).toBeDisabled();
    // Picking a tab only changes what's shown, so it still works: Jess P.'s lines, as of the last sync.
    await tabs.getByRole("button", { name: /Jess P\./ }).click();
    await expect(page.getByRole("complementary")).toContainText("Jess P.");
    await expect(page.getByTestId("read-only-note")).toContainText(/last sync, \d+:\d\d/);

    // Locked: no PIN, and o1 and o2 keep aging, and chiming.
    await page.evaluate(() => {
      const w = window as unknown as { chimes: number };
      w.chimes = 0;
      const make = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function (this: AudioContext) {
        w.chimes++;
        return make.call(this);
      };
    });
    await page.getByRole("button", { name: "Lock" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");
    const waiting = page.getByTestId("waiting-orders");
    await expect(waiting).toContainText("Bar orders · 2 waiting");
    const room9 = waiting.getByRole("listitem").filter({ hasText: "Room 9" });
    await expect(room9).toHaveText(/^Room 9 · Ringing · \d+:\d\d$/);
    await expect(waiting.getByRole("listitem").filter({ hasText: "Room 5" })).toHaveText(
      /^Room 5 · Ringing · \d+:\d\d$/,
    );
    const seconds = async () => {
      const [, m, s] = /(\d+):(\d\d)$/.exec((await room9.textContent()) ?? "")!;
      return Number(m) * 60 + Number(s);
    };
    const first = await seconds();
    expect(first).toBeGreaterThanOrEqual(43);
    await expect.poll(seconds, { timeout: 10_000 }).toBeGreaterThan(first);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { chimes: number }).chimes), {
        timeout: 75_000,
        intervals: [5_000],
      })
      .toBeGreaterThan(0);

    // On disk the cache is SQLCipher: none of the night reads in plain text.
    const cache = readFileSync(path.join(userData, "cache.sqlite"), "latin1");
    expect(cache).not.toContain("Jess P.");
    expect(cache).not.toContain("Hoegaarden");
    expect(cache.startsWith("SQLite format 3")).toBe(false);
  } finally {
    await db.end();
    await app.close();
  }
});

/**
 * Queue mode on the bar computer (M8-04), from a fresh seed at the given venue time: the bar computer is
 * paired and sets up its offline-code secret, Maya signs in to the bar POS, and the code Andy's phone
 * shows for the bar computer right now is read. Returns the code.
 */
async function queueNight(serverTime: string) {
  const { execSync } = await import("node:child_process");
  execSync("pnpm seed", { stdio: "ignore" });
  const userData = mkdtempSync(path.join(tmpdir(), "west4-desktop-"));
  const app = await launch(userData);
  const db = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
  });
  await db.connect();
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await db.query("update memberships set locale = 'en'");
  const venueId = (await db.query<{ id: string }>("select id from venues limit 1")).rows[0]!.id;
  const pairing = randomBytes(4).toString("hex").toUpperCase();
  await db.query(
    "insert into device_pairing_codes (venue_id, code_hash, kind, name, expires_at) values ($1, $2, 'bar_computer', 'Bar computer', now() + interval '1 hour')",
    [venueId, createHash("sha256").update(pairing).digest("hex")],
  );
  expect(
    (
      await page.request.post("http://localhost:5173/v1/ops/clock", {
        data: { server_time: serverTime },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole("button", { name: "Pair this screen" }).click();
  await page.getByLabel("Pairing code from Admin → Devices").fill(pairing);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");
  const signIn = async (name: RegExp, pin: string) => {
    await page.getByRole("button", { name }).click();
    for (const digit of pin)
      await page.locator(".keypad").getByRole("button", { name: digit, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Staff sign-in");
  };
  // Maya signs in. Online, the bar computer sets up its offline-code secret with the server.
  await signIn(/Maya S\./, "4071");
  await page.getByRole("link", { name: "Bar POS" }).first().click();
  await expect(page.getByRole("list", { name: "Bar tabs" })).toBeVisible();
  // The desktop app has kept what queue mode needs: the tabs, the menu and the team's names.
  const v = `/v1/venues/${venueId}`;
  for (const p of [`${v}/tabs`, `${v}/menu`, `${v}/team/tiles`])
    await expect
      .poll(() => page.evaluate((x) => window.west4!.offline!.read(x).then(Boolean), p), {
        timeout: 20_000,
      })
      .toBe(true);
  await expect
    .poll(
      async () =>
        (
          await db.query<{ n: number }>(
            "select count(*)::int as n from device_offline_secrets where venue_id = $1",
            [venueId],
          )
        ).rows[0]!.n,
      { timeout: 20_000 },
    )
    .toBe(1);
  // The code Andy's phone shows right now: the server's copy of the bar computer's secret, through
  // the same rule as GET /offline-codes (the staff test "Offline codes: Andy's phone …" shows it there).
  const code = async () => {
    const row = (
      await db.query<{ device_id: string; secret_enc: string }>(
        "select device_id, secret_enc from device_offline_secrets where venue_id = $1",
        [venueId],
      )
    ).rows[0]!;
    const config = loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: "postgres://unused",
      APP_DATABASE_URL: "postgres://unused",
    });
    const secret = decryptSecret(config.auth.secretKey, row.secret_enc);
    const health = (await (await page.request.get("http://localhost:5173/v1/health")).json()) as {
      server_time: string;
    };
    return offlineCodeAt(
      (k, m) => createHmac("sha256", Buffer.from(k, "hex")).update(m).digest(),
      secret,
      { deviceId: row.device_id, timeZone: "America/New_York", dayCutover: "06:00" },
      Temporal.Instant.from(health.server_time),
    );
  };
  const goOffline = () =>
    app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (d, done) =>
        done({ cancel: d.url.includes("/v1/") }),
      );
    });
  // Read now, while our API still answers (the venue's clock).
  const now = await code();
  const goOnline = () =>
    app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(null);
    });
  return { app, db, page, code: now, userData, venueId, goOffline, goOnline };
}

test("queue mode: Andy's code opens it, Maya queues 1 × Jäger Bomb on Luis M.'s tab, the rest stays locked, and a kill loses nothing", async () => {
  test.setTimeout(240_000);
  const { app, db, page, code, userData, goOffline } = await queueNight("2026-09-26T02:41:00Z");
  let relaunched: ElectronApplication | null = null;
  try {
    await goOffline();
    await expect(page.getByTestId("banner-offline")).toHaveText(
      "Offline · read-only · orders queue with an offline code",
      { timeout: 20_000 },
    );
    // A wrong code opens nothing.
    const field = page.getByLabel("Offline code");
    await field.fill(code === "000000" ? "000001" : "000000");
    await page.getByRole("button", { name: "Open queue mode" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "That code doesn't open this computer. Check it's for this computer and tonight.",
    );
    await expect(page.getByTestId("banner-queue")).toHaveCount(0);
    // Andy reads out the bar computer's code: queue mode, for 4 hours.
    await field.fill(code);
    await page.getByRole("button", { name: "Open queue mode" }).click();
    await expect(page.getByTestId("banner-queue")).toHaveText(
      /^Queue mode · until [2-3]:\d\d AM · rounds are queued, not charged$/,
    );
    await expect(page.getByTestId("read-only-note")).toContainText(
      "Queue mode · rounds on open tabs",
    );

    // New tab, and fixing (Void) a sent drink, stay locked, saying why.
    await expect(page.getByRole("button", { name: "New tab" })).toBeDisabled();
    await expect(page.getByText("No new tabs while the bar computer is offline.")).toBeVisible();
    const tabs = page.getByRole("list", { name: "Bar tabs" });
    await tabs.getByRole("button", { name: /Luis M\./ }).click();
    const fix = page.getByRole("button", { name: /^Fix · / }).first();
    await expect(fix).toBeDisabled();
    await expect(fix).toHaveAttribute(
      "title",
      "Queue mode: voids, refunds, the drawer and New tab wait for the connection",
    );
    const close = page.getByRole("button", { name: "Close tab" });
    if (await close.count()) await expect(close).toBeDisabled();

    // Maya queues 1 × Jäger Bomb on Luis M.'s tab, under her own name.
    await expect(page.getByRole("heading", { name: "Queue a round on Luis M." })).toBeVisible();
    await page.getByLabel("Search the menu").fill("Jäger");
    await page.getByRole("button", { name: /^Jäger Bomb · \$12\.00$/ }).click();
    await expect(page.locator(".queue-lines")).toHaveText(/1 × Jäger Bomb/);
    await page.getByLabel("Who's ringing it").selectOption({ label: "Maya S." });
    await page.getByRole("button", { name: "Queue round" }).click();
    const queued = page.getByRole("list", { name: "Queued rounds" });
    await expect(queued).toHaveText("1 × Jäger Bomb · queued · not charged · Maya S.");
    const ids = await page.evaluate(() =>
      window.west4!.queue!.list().then((l) => l.map((o) => (o as { order_id: string }).order_id)),
    );
    expect(ids).toHaveLength(1);

    // Killed mid-outage: the queued round is still there when the app opens again.
    const exited = new Promise((r) => app.process().once("exit", r));
    app.process().kill("SIGKILL");
    await exited;
    // Its helper processes go with it; the profile lock they held goes stale.
    await new Promise((r) => setTimeout(r, 3_000));
    relaunched = await launch(userData);
    const again = await relaunched.firstWindow({ timeout: 60_000 });
    await expect
      .poll(
        () =>
          again.evaluate(() =>
            window.west4!.queue!.list().then((l) =>
              l.map((o) => {
                const x = o as { order_id: string; tab_name: string; staff: { name: string } };
                return `${x.order_id} ${x.tab_name} ${x.staff.name}`;
              }),
            ),
          ),
        { timeout: 20_000 },
      )
      .toEqual([`${ids[0]} Luis M. Maya S.`]);
    const cache = readFileSync(path.join(userData, "cache.sqlite"), "latin1");
    expect(cache).not.toContain("Luis M.");
  } finally {
    await db.end();
    await relaunched?.close();
    await app.close().catch(() => undefined);
  }
});

test("replay: three rounds queued in the outage show Confirm replayed orders (3) after reconnect, each asked to wait and off the tab until accepted", async () => {
  test.setTimeout(240_000);
  const { app, db, page, code, goOffline, goOnline } = await queueNight("2026-09-26T02:41:00Z");
  try {
    await goOffline();
    await expect(page.getByTestId("banner-offline")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Offline code").fill(code);
    await page.getByRole("button", { name: "Open queue mode" }).click();
    await expect(page.getByTestId("banner-queue")).toBeVisible();
    await page
      .getByRole("list", { name: "Bar tabs" })
      .getByRole("button", { name: /Luis M\./ })
      .click();
    for (let n = 1; n <= 3; n += 1) {
      await page.getByRole("searchbox", { name: "Search the menu" }).fill("Jäger");
      await page.getByRole("button", { name: /^Jäger Bomb · \$12\.00$/ }).click();
      await page.getByLabel("Who's ringing it").selectOption({ label: "Maya S." });
      await page.getByRole("button", { name: "Queue round" }).click();
      await expect(
        page.getByRole("list", { name: "Queued rounds" }).getByRole("listitem"),
      ).toHaveCount(n);
    }
    const check = (
      await db.query<{ check_id: string }>("select check_id from tabs where name = 'Luis M.'")
    ).rows[0]!.check_id;
    const lines = async () =>
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from check_lines where check_id = $1 and kind = 'item'",
          [check],
        )
      ).rows[0]!.n;
    const before = await lines();

    // The connection returns: the computer replays its queue, once.
    await goOnline();
    await expect(page.getByTestId("banner-replayed")).toHaveText("Confirm replayed orders (3)", {
      timeout: 40_000,
    });
    const list = page.getByRole("region", { name: "Confirm replayed orders (3)" });
    await expect(list.getByTestId("replayed-order")).toHaveCount(3);
    await expect
      .poll(() => page.evaluate(() => window.west4!.queue!.list().then((l) => l.length)), {
        timeout: 20_000,
      })
      .toBe(0);
    const held = await db.query<{ status: string }>(
      "select status from orders where source = 'offline' and check_id = $1",
      [check],
    );
    expect(held.rows.map((r) => r.status)).toEqual(["held", "held", "held"]);
    expect(await lines()).toBe(before);
    // Accept is the sale: the round joins the tab.
    await list
      .getByTestId("replayed-order")
      .first()
      .getByRole("button", { name: "Accept · print ticket" })
      .click();
    await expect(page.getByTestId("banner-replayed")).toHaveText("Confirm replayed orders (2)", {
      timeout: 20_000,
    });
    expect(await lines()).toBe(before + 1);
  } finally {
    await db.end();
    await app.close().catch(() => undefined);
  }
});

test("queue mode: past 4:00 AM on the simulated clock, alcohol greys out from the kept menu as online", async () => {
  test.setTimeout(240_000);
  // 3:58:45 AM: the menu kept before the outage still says the alcohol window is open.
  const { app, db, page, code, venueId, goOffline } = await queueNight("2026-09-26T07:58:45Z");
  try {
    const menu = await page.evaluate(
      (p) => window.west4!.offline!.read(p),
      `/v1/venues/${venueId}/menu`,
    );
    expect((menu!.body as { alcohol: { state: string } }).alcohol.state).toBe("open");
    await goOffline();
    await page.getByLabel("Offline code").fill(code);
    await page.getByRole("button", { name: "Open queue mode" }).click();
    await expect(page.getByTestId("banner-queue")).toBeVisible();
    await page
      .getByRole("list", { name: "Bar tabs" })
      .getByRole("button", { name: /Luis M\./ })
      .click();
    await page.getByLabel("Search the menu").fill("Jäger");
    // At 4:00 AM, with no connection, the Jäger Bomb greys out with the reason, as it does online.
    await expect(
      page.getByRole("button", { name: "Jäger Bomb · No alcohol now · the window has closed" }),
    ).toBeDisabled({ timeout: 90_000 });
  } finally {
    // Back to the seed's 10:41 PM for the specs that run after this one.
    await page.request
      .post("http://localhost:5173/v1/ops/clock", { data: { server_time: "2026-09-26T02:41:00Z" } })
      .catch(() => undefined);
    await db.end();
    await app.close();
  }
});

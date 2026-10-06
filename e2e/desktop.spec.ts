import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import pg from "pg";

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

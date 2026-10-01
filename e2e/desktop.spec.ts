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
    const post = (p: string, data: unknown) => page.request.post(`${api}${p}`, { data });
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
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tonight");

    // Admin → Team: pair a new badge to Diego in one tap on the (fake) reader.
    await page.getByRole("link", { name: "Admin" }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Team");
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

import path from "node:path";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

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
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    const reach = await window.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: typeof (globalThis as { west4?: { desktop?: boolean } }).west4?.desktop,
    }));
    expect(reach).toEqual({ require: "undefined", process: "undefined", bridge: "boolean" });
    const isolated = await app.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences();
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
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    await window.evaluate(() => {
      window.location.assign("https://example.com/");
    });
    await window.waitForTimeout(1000);
    expect(new URL(window.url()).origin).toBe("http://localhost:5173");
    const opened = await window.evaluate(() => window.open("https://example.com/") === null);
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
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    const token = "bearer-test-token-" + Math.random().toString(36).slice(2);
    await window.evaluate((t) => window.west4!.token.set(t), token);
    expect(await window.evaluate(() => window.west4!.token.get())).toBe(token);
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

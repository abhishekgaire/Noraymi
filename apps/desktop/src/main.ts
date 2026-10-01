import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  session,
  type IpcMainInvokeEvent,
} from "electron";
import { Temporal } from "@west4/shared";
import { DesktopCache } from "./cache.js";
import { SealedStore, type Sealer } from "./keychain.js";
import { allowedOriginsFrom, isAllowedUrl, isTrustedSender } from "./security.js";

/**
 * The Electron shell around the staff app (M1-28, spec 12 · 10). It shows
 * the staff app from its own hostname and nothing else, with context
 * isolation, the sandbox and no Node.js in the page; the bearer token lives
 * in the keychain through safeStorage and the cache is SQLCipher keyed the
 * same way. The alarm, printers, drawer, badge reader, watchdog and offline
 * view come with their own tickets.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const staffUrl = process.env["STAFF_URL"] ?? "http://localhost:5173";
const allowed = allowedOriginsFrom(process.env);

if (process.env["WEST4_USER_DATA"]) app.setPath("userData", process.env["WEST4_USER_DATA"]);
app.enableSandbox();

const sealer: Sealer = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  seal: (plain) => safeStorage.encryptString(plain),
  open: (sealed) => safeStorage.decryptString(sealed),
};

let tokens: SealedStore;
let cacheKey: SealedStore;
let cache: DesktopCache | null = null;

/** The cache opens lazily and never stops the app: without it there is no offline view, nothing more. */
function openCache(): DesktopCache | null {
  if (cache) return cache;
  try {
    cache = DesktopCache.open(
      path.join(app.getPath("userData"), "cache.sqlite"),
      cacheKey.getOrMakeKey(),
    );
    cache.wipeIfPastCutover(Temporal.Now.instant());
  } catch (error) {
    console.warn(`cache unavailable: ${error instanceof Error ? error.message : String(error)}`);
    cache = null;
  }
  return cache;
}

/** Every IPC handler checks its sender: the main frame of a page on one of our origins, nobody else. */
function guarded<A extends unknown[], R>(handler: (...args: A) => R) {
  return (event: IpcMainInvokeEvent, ...args: A): R => {
    const frame = event.senderFrame;
    const trusted = isTrustedSender(
      frame ? { url: frame.url, isMainFrame: frame === event.sender.mainFrame } : null,
      allowed,
    );
    if (!trusted) throw new Error("refused: unexpected sender");
    return handler(...args);
  };
}

function registerIpc(): void {
  ipcMain.handle(
    "west4:version",
    guarded(() => app.getVersion()),
  );
  ipcMain.handle(
    "west4:token:get",
    guarded(() => tokens.get()),
  );
  ipcMain.handle(
    "west4:token:set",
    guarded((token: unknown) => {
      if (typeof token !== "string" || token.length === 0 || token.length > 4096)
        throw new Error("refused: not a token");
      tokens.set(token);
    }),
  );
  ipcMain.handle(
    "west4:token:clear",
    guarded(() => tokens.clear()),
  );
  ipcMain.handle(
    "west4:venue",
    guarded((clock: unknown) => {
      const c = clock as { time_zone?: unknown; day_cutover?: unknown; server_time?: unknown };
      if (typeof c?.time_zone !== "string" || typeof c?.day_cutover !== "string")
        throw new Error("refused: not a clock");
      const opened = openCache();
      if (!opened) return;
      opened.configure({ timeZone: c.time_zone, dayCutover: c.day_cutover });
      if (typeof c.server_time === "string") opened.wipeIfPastCutover(c.server_time);
    }),
  );
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "West 4 Staff",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  // Our hostnames only: no navigation elsewhere, no new windows at all.
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedUrl(url, allowed)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  void window.loadURL(staffUrl);
  return window;
}

void app.whenReady().then(() => {
  const userData = app.getPath("userData");
  tokens = new SealedStore(path.join(userData, "session.token"), sealer);
  cacheKey = new SealedStore(path.join(userData, "cache.key"), sealer);
  // The page asks for nothing the shell should grant: no camera, microphone, location or the rest.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  registerIpc();
  createWindow();
  // Each minute: past the cutover, the day before leaves the cache.
  setInterval(() => cache?.wipeIfPastCutover(Temporal.Now.instant()), 60_000).unref();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedUrl(url, allowed)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.on("window-all-closed", () => {
  cache?.close();
  if (process.platform !== "darwin") app.quit();
});

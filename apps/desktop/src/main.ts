import { utimesSync, writeFileSync } from "node:fs";
import { powerSaveBlocker } from "electron";
// electron-updater is CommonJS and its autoUpdater is a getter: a default import reaches it, a named one can't.
import updater from "electron-updater";
import { UpdateGate } from "./updates.js";
import { EmulatedReader, ReaderHub, startPcsc } from "./reader.js";
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
const updates = new UpdateGate(null);
const readers = new ReaderHub();
let emulated: EmulatedReader | null = null;
let mainWindow: BrowserWindow | null = null;

/** Tell the page about a tap or a change of readers (M1-30). */
const toPage = (channel: string, payload: unknown): void => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
let venueNowOffsetMs: number | null = null;

/** The venue's clock as the server last said it, moved on by the computer's own clock. */
const venueNow = (): Temporal.Instant | null =>
  venueNowOffsetMs === null
    ? null
    : Temporal.Instant.fromEpochMilliseconds(Date.now() + venueNowOffsetMs);

/** Started by the operating system at login (M1-29): nobody is signed in, the device is still paired. */
const openedAtLogin = (): boolean =>
  process.argv.includes("--at-login") ||
  (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);

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
    "west4:readers",
    guarded(() => readers.list()),
  );
  ipcMain.handle(
    "west4:badge:pair-start",
    guarded(() => readers.startPairing()),
  );
  ipcMain.handle(
    "west4:badge:pair-finish",
    guarded(async (plan: unknown) => {
      const p = plan as {
        meta_read_key?: unknown;
        file_read_key?: unknown;
        key_version?: unknown;
        host?: unknown;
      };
      const hex = /^[0-9a-fA-F]{32}$/;
      if (typeof p?.meta_read_key !== "string" || !hex.test(p.meta_read_key))
        throw new Error("refused: not a key");
      if (typeof p?.file_read_key !== "string" || !hex.test(p.file_read_key))
        throw new Error("refused: not a key");
      if (typeof p?.key_version !== "number" || typeof p?.host !== "string")
        throw new Error("refused: not a plan");
      return readers.finishPairing({
        host: p.host,
        metaReadKey: Buffer.from(p.meta_read_key, "hex"),
        fileReadKey: Buffer.from(p.file_read_key, "hex"),
        keyVersion: p.key_version,
      });
    }),
  );
  ipcMain.handle(
    "west4:badge:cancel",
    guarded(() => readers.cancelPairing()),
  );
  // The fake reader (WEST4_FAKE_READER=1): a tag by UID is presented on request, for development and tests.
  ipcMain.handle(
    "west4:badge:fake-tap",
    guarded(async (uid: unknown) => {
      if (!emulated) throw new Error("refused: no fake reader");
      if (typeof uid !== "string" || !/^[0-9a-fA-F]{14}$/.test(uid))
        throw new Error("refused: not a UID");
      await emulated.present(uid.toUpperCase());
    }),
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
      updates.setClock({ timeZone: c.time_zone, dayCutover: c.day_cutover });
      if (typeof c.server_time === "string") {
        venueNowOffsetMs = Temporal.Instant.from(c.server_time).epochMilliseconds - Date.now();
        opened.wipeIfPastCutover(c.server_time);
      }
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
  mainWindow = window;
  return window;
}

/** Updates download in the background and install only at the cutover, or at the first start after it. */
function startUpdates(): void {
  if (!app.isPackaged) return;
  const { autoUpdater } = updater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on("update-downloaded", () =>
    updates.downloaded(venueNow() ?? Temporal.Now.instant()),
  );
  autoUpdater.on("error", (error) => console.warn(`updater: ${error.message}`));
  const check = () => autoUpdater.checkForUpdates().catch(() => null);
  void check();
  setInterval(check, 6 * 60 * 60_000).unref();
  setInterval(() => {
    const now = venueNow();
    if (now && updates.isDue(now)) autoUpdater.quitAndInstall(true, true);
  }, 60_000).unref();
}

void app.whenReady().then(() => {
  const userData = app.getPath("userData");
  tokens = new SealedStore(path.join(userData, "session.token"), sealer);
  cacheKey = new SealedStore(path.join(userData, "cache.key"), sealer);
  // At login nobody is signed in: the last person's token goes; the device key (in the page's own storage) stays.
  if (openedAtLogin()) tokens.clear();
  // Start at login, and keep the computer and its screen awake while the app runs.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ["--at-login"] });
  powerSaveBlocker.start("prevent-display-sleep");
  // The watchdog watches this file: touched every 5 seconds while the app answers.
  const alive = path.join(userData, "alive");
  const touch = () => {
    try {
      writeFileSync(alive, "");
      utimesSync(alive, new Date(), new Date());
    } catch {
      // Nothing to do: the watchdog will restart the app if this keeps failing.
    }
  };
  touch();
  setInterval(touch, 5000).unref();
  startUpdates();
  // The USB NFC readers: PC/SC, or the emulator when asked for.
  readers.on("tap", (url, reader) => toPage("west4:badge-tap", { url, reader: reader.name }));
  readers.on("readers", (list) => toPage("west4:readers", list));
  readers.on("error", (message) => console.warn(`reader: ${message}`));
  if (process.env["WEST4_FAKE_READER"] === "1") emulated = new EmulatedReader(readers);
  else startPcsc(readers);
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

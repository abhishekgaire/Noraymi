import { app, BrowserWindow } from "electron";
import { t } from "@west4/shared";

// The Electron shell around the staff app. The security checklist, the
// encrypted cache, the watchdog and the USB devices arrive with M1-28 to M1-30.
// For now it opens the staff app from STAFF_URL with the safe defaults on.
const staffUrl = process.env["STAFF_URL"] ?? "http://localhost:5173";

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: t("en", "app.desktop.name"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadURL(staffUrl);
}

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

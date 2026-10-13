/* global process, require */
// Loaded into the desktop app's main process by the browser tests (`-r`, after Playwright's own
// loader). Playwright's loader switches Chromium to --password-store=basic, which on Linux leaves
// Electron's safeStorage with no keychain at all, so the app rightly refuses to keep its token.
// Put Chromium back on the desktop's keyring (CI runs an unlocked GNOME keyring); a Mac and
// Windows don't read this switch.
if (process.platform === "linux") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("electron").app.commandLine.appendSwitch("password-store", "gnome-libsecret");
}

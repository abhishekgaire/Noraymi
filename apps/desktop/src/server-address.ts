/**
 * Where the desktop app finds the staff app. In order: the STAFF_URL environment variable (the
 * tests, a developer), then server.json in the app's data folder (what the setup screen saves on
 * this computer), then the address the packaged build was made for (resources/west4.json, W-01),
 * then http://localhost:5173. An installed app with none of these shows the setup screen first, and
 * Ctrl+Shift+S shows it again, so a bar PC can be pointed at a laptop running the practice night
 * (scripts/demo-start.sh --lan) without editing anything by hand. Pure helpers, so each has a test;
 * main.ts wires them to Electron.
 */

export const SERVER_FILE = "server.json";
export const DEFAULT_STAFF_URL = "http://localhost:5173";

export interface StaffServer {
  readonly url: string;
  readonly from: "env" | "file" | "build" | "default";
}

/** The staff app's address from what was typed: "192.168.1.20:5173" means https://192.168.1.20:5173. */
export function parseServerAddress(input: string): string | null {
  const text = input.trim();
  if (text.length === 0 || text.length > 200) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

/** server.json's contents, or null when it's missing or isn't one. */
export function readServerFile(text: string | null): string | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { staffUrl?: unknown };
    return typeof parsed.staffUrl === "string" ? parseServerAddress(parsed.staffUrl) : null;
  } catch {
    return null;
  }
}

export function serverFileContents(url: string): string {
  return `${JSON.stringify({ staffUrl: url }, null, 2)}\n`;
}

export function resolveStaffServer(
  env: Record<string, string | undefined>,
  serverFile: string | null,
  built?: string,
): StaffServer {
  const fromEnv = env["STAFF_URL"];
  if (fromEnv) return { url: fromEnv, from: "env" };
  const fromFile = readServerFile(serverFile);
  if (fromFile) return { url: fromFile, from: "file" };
  if (built) return { url: built, from: "build" };
  return { url: DEFAULT_STAFF_URL, from: "default" };
}

/** The setup screen's form goes here; main.ts catches it before any network is touched. */
const SETUP_HOST = "west4-server-setup.invalid";

export type SetupAction = { kind: "save"; address: string } | { kind: "cancel" };

/** What the setup screen asked for, or null when the navigation isn't the setup screen's. */
export function setupAction(url: string): SetupAction | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== SETUP_HOST) return null;
  if (parsed.pathname === "/save")
    return { kind: "save", address: parsed.searchParams.get("address") ?? "" };
  return { kind: "cancel" };
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** The setup screen, English and Spanish side by side (it shows before anyone signs in). */
export function setupPage(options: { current: string | null; error: boolean }): string {
  const value = escapeHtml(options.current ?? "");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>West 4 Staff</title>
<style>body{font:18px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#111}
input{font:inherit;width:100%;box-sizing:border-box;padding:.7rem;min-height:44px;margin:.5rem 0}
button,a.b{font:inherit;min-height:44px;padding:.6rem 1.4rem;margin-right:.5rem;border-radius:8px}
button{background:#111;color:#fff;border:0}p.e{color:#b00020}.es{color:#555}</style></head><body>
<h1>Server address <span class="es">· Dirección del servidor</span></h1>
<p>Type the address of the staff app, for example <b>https://192.168.1.20:5173</b>.<br>
<span class="es">Escriba la dirección de la app del personal, por ejemplo <b>https://192.168.1.20:5173</b>.</span></p>
${options.error ? `<p class="e">That isn't an address. Check it and try again. · Esa no es una dirección. Revísela e inténtelo de nuevo.</p>` : ""}
<form action="https://${SETUP_HOST}/save" method="get">
<input name="address" value="${value}" autofocus autocomplete="off" spellcheck="false" aria-label="Server address">
<button type="submit">Save and restart · Guardar y reiniciar</button>
${options.current ? `<a class="b" href="https://${SETUP_HOST}/cancel">Cancel · Cancelar</a>` : ""}
</form></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

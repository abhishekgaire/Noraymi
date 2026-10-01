/**
 * The desktop app's walls (spec 12 · 10, Electron's security checklist):
 * the renderer only ever shows our own hostnames, and every IPC message is
 * accepted only from the main frame of a page on one of them. Pure checks,
 * so each has a unit test; main.ts wires them to Electron.
 */

/** The origins this build may show: the staff app, and the API it talks to. */
export function allowedOriginsFrom(env: Record<string, string | undefined>): Set<string> {
  const origins = new Set<string>();
  const staff = env["STAFF_URL"] ?? "http://localhost:5173";
  origins.add(new URL(staff).origin);
  const api = env["API_URL"];
  if (api) origins.add(new URL(api).origin);
  return origins;
}

/** A page the window may navigate to or load: one of our origins, over http(s). */
export function isAllowedUrl(url: string, allowed: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return allowed.has(parsed.origin);
}

/** An IPC message counts only from the main frame of a page on one of our origins. */
export function isTrustedSender(
  frame: { url: string; isMainFrame: boolean } | null | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  if (!frame || !frame.isMainFrame) return false;
  return isAllowedUrl(frame.url, allowed);
}

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Where the app's staff app lives (W-01). A computer at the venue has no
 * STAFF_URL in its environment, so the packaged build carries the address it
 * was built for in `resources/west4.json` (written by `build` from
 * WEST4_STAFF_URL and WEST4_API_URL). The environment still wins, for a
 * developer or a test; without either it is the local staff app.
 */
export interface DesktopUrls {
  readonly STAFF_URL: string;
  readonly API_URL: string | undefined;
}

export function desktopUrls(
  env: Record<string, string | undefined>,
  resourcesPath: string | null,
): DesktopUrls {
  let baked: { staffUrl?: unknown; apiUrl?: unknown } = {};
  if (resourcesPath) {
    try {
      baked = JSON.parse(readFileSync(path.join(resourcesPath, "west4.json"), "utf8")) as {
        staffUrl?: unknown;
        apiUrl?: unknown;
      };
    } catch {
      baked = {};
    }
  }
  const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    STAFF_URL: env["STAFF_URL"] ?? text(baked.staffUrl) ?? "http://localhost:5173",
    API_URL: env["API_URL"] ?? text(baked.apiUrl),
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiCallError, api } from "./api.js";

/**
 * The desktop app's offline reads (M8-03): every listed read is kept as it
 * arrives; with our API blocked the kept answer comes back; a refusal, a
 * write, or a read off the list never does.
 */
const V = "/v1/venues/0b6c0c9e-3d0a-4a43-9a43-1c1c2f5a7f10";
const TABS = { tabs: [{ name: "Jess P.", totals: { total_cents: 3266 } }] };

describe("reads on the desktop app's offline list", () => {
  const kept = new Map<string, string>();
  const save = vi.fn(async (path: string, json: string) => {
    kept.set(path, json);
    return true;
  });
  const read = vi.fn(async (path: string) => {
    const json = kept.get(path);
    return json ? { synced_at: "2026-09-26T02:41:00Z", body: JSON.parse(json) as unknown } : null;
  });
  beforeEach(() => {
    kept.clear();
    vi.stubGlobal("window", { west4: { offline: { save, read } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the answer, and gives it back when our API doesn't answer", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(TABS), { status: 200 }));
    expect(await api("GET", `${V}/tabs`)).toEqual(TABS);
    expect(save).toHaveBeenCalledWith(`${V}/tabs`, JSON.stringify(TABS));
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await api("GET", `${V}/tabs`)).toEqual(TABS);
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    expect(await api("GET", `${V}/tabs`)).toEqual(TABS);
  });

  it("never covers a refusal, a write, or a read that isn't on the list", async () => {
    kept.set(`${V}/tabs`, JSON.stringify(TABS));
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: { code: "forbidden", message: "no" } }), {
          status: 403,
        }),
    );
    await expect(api("GET", `${V}/tabs`)).rejects.toBeInstanceOf(ApiCallError);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api("POST", `${V}/tabs`, {})).rejects.toThrow();
    await expect(api("GET", "/v1/auth/me")).rejects.toThrow();
    expect(read).not.toHaveBeenCalledWith("/v1/auth/me");
  });

  it("in a browser or on a phone, keeps nothing", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(TABS), { status: 200 }));
    save.mockClear();
    await api("GET", `${V}/tabs`);
    expect(save).not.toHaveBeenCalled();
  });
});

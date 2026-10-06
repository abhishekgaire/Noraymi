import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RouterLink } from "@west4/db";
import { loadPeplinkSettings, makePeplinkAdapter, readPeplinkDevice } from "./peplink.js";

/**
 * The adapter's contract (M8-02) against answers shaped by InControl 2's
 * documented schema (resp_code, data.status, data.interfaces). The live
 * check against the venue's own router is M8-07.
 */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const link: RouterLink = {
  maker: "peplink",
  maker_org_id: "org-1",
  maker_device_id: "101",
  api_on: true,
  wired_owner: null,
  lte_owner: null,
};

describe("reading a Peplink device answer", () => {
  it("on the wired line with the LTE backup ready", () => {
    expect(readPeplinkDevice(fixture("peplink-on-line"))).toEqual({
      backupReady: true,
      onBackupNow: false,
    });
  });
  it("the wired line unplugged: the venue runs on LTE", () => {
    expect(readPeplinkDevice(fixture("peplink-on-lte"))).toEqual({
      backupReady: true,
      onBackupNow: true,
    });
  });
  it("no SIM in the modem: on the line, and the backup isn't ready", () => {
    expect(readPeplinkDevice(fixture("peplink-no-sim"))).toEqual({
      backupReady: false,
      onBackupNow: false,
    });
  });
  it("the maker reports the router offline, or the call failed: no reading", () => {
    expect(readPeplinkDevice(fixture("peplink-offline"))).toBeNull();
    expect(readPeplinkDevice(fixture("peplink-invalid"))).toBeNull();
    expect(readPeplinkDevice("nonsense")).toBeNull();
  });
});

describe("the Peplink adapter", () => {
  type Call = { url: string; init: RequestInit | undefined };
  const fakeFetch = (device: () => Response) => {
    const calls: Call[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/api/oauth2/token"))
        return Response.json({ access_token: `tok-${calls.length}`, expires_in: 3600 });
      return device();
    }) as unknown as typeof fetch;
    return { fn, calls };
  };
  const settings = loadPeplinkSettings({
    PEPLINK_CLIENT_ID: "id",
    PEPLINK_CLIENT_SECRET: "secret",
    PEPLINK_API_URL: "https://ic.example/",
  });

  it("isn't made without credentials", () => {
    expect(makePeplinkAdapter(loadPeplinkSettings({}))).toBeNull();
  });

  it("takes a client-credentials token once, then reads the documented device path with it", async () => {
    const { fn, calls } = fakeFetch(() => Response.json(fixture("peplink-on-lte")));
    const adapter = makePeplinkAdapter(settings, fn)!;
    expect(await adapter.read(link)).toEqual({ backupReady: true, onBackupNow: true });
    expect(await adapter.read(link)).toEqual({ backupReady: true, onBackupNow: true });
    expect(calls.map((c) => c.url)).toEqual([
      "https://ic.example/api/oauth2/token",
      "https://ic.example/rest/o/org-1/d/101",
      "https://ic.example/rest/o/org-1/d/101",
    ]);
    expect(String(calls[0]!.init?.body)).toContain("grant_type=client_credentials");
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe("Bearer tok-1");
  });

  it("a refused token is asked for again; an error or no answer is no reading", async () => {
    let status = 401;
    const { fn, calls } = fakeFetch(() =>
      status === 200 ? Response.json(fixture("peplink-on-line")) : new Response("", { status }),
    );
    const adapter = makePeplinkAdapter(settings, fn)!;
    expect(await adapter.read(link)).toBeNull();
    status = 200;
    expect(await adapter.read(link)).toEqual({ backupReady: true, onBackupNow: false });
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(2);
    const down = makePeplinkAdapter(settings, (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch)!;
    expect(await down.read(link)).toBeNull();
  });

  it("a router not linked to a Peplink device isn't read", async () => {
    const { fn, calls } = fakeFetch(() => Response.json(fixture("peplink-on-line")));
    const adapter = makePeplinkAdapter(settings, fn)!;
    expect(await adapter.read({ ...link, maker_device_id: null })).toBeNull();
    expect(await adapter.read({ ...link, maker: null })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

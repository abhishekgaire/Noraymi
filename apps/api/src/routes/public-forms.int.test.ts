import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import type { Principal } from "../http/principal.js";
import { buildApp } from "../app.js";
import { TURNSTILE_TEST, turnstileVerifier } from "../captcha/turnstile.js";
import { loadConfig } from "../config.js";

/**
 * M2-27: the server-checked CAPTCHA (Cloudflare Turnstile) and the daily limits per phone number,
 * IP address and device, on the waitlist page and on phone codes (singers and staff invites).
 * Locally the API runs on Cloudflare's test keys, answered as Cloudflare documents them; the
 * siteverify call itself is checked against a stand-in here, never against Cloudflare.
 */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let slug = "";
const clock = new SimulatedClock(SEED_NOW);
const TOKEN = TURNSTILE_TEST.token;
let ipSeq = 0;
/** Each test's requests come from their own address unless they name one. */
let ip = "";

const join = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: `/v1/public/venues/${slug}/waitlist`,
    headers: { authorization: "", "x-forwarded-for": ip, ...headers },
    payload: body as never,
  });
const doorJoin = (phone: string, headers: Record<string, string> = {}) =>
  join({ name: "Sam", phone, party_size: 4, captcha_token: TOKEN }, headers);
const leave = (token: string) =>
  app.inject({
    method: "PATCH",
    url: `/v1/public/waitlist/${token}`,
    headers: { authorization: "" },
    payload: { action: "leave" },
  });
const setLimits = async (value: unknown) => {
  await raw.query(
    `insert into venue_settings (venue_id, key, version, value, starts_on)
     values ($1, 'publicForms', (select coalesce(max(version), 0) + 1 from venue_settings
                                  where venue_id = $1 and key = 'publicForms'), $2, '2026-01-01')`,
    [venueId, JSON.stringify(value)],
  );
};
const deviceCookie = (r: { headers: Record<string, unknown> }) => {
  const set = ([] as string[]).concat((r.headers["set-cookie"] as string | string[]) ?? []);
  const found = set.find((c) => c.startsWith("west4_device="));
  return found ? found.split(";")[0]! : null;
};
const waitlistRows = async () =>
  Number((await raw.query<{ n: string }>("select count(*) as n from waitlist_entries")).rows[0]!.n);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  slug = (await raw.query<{ slug: string }>("select slug from venues where id = $1", [venueId]))
    .rows[0]!.slug;
  process.env["TRUSTED_PROXY_HOPS"] = "1";
  // Admin's saves read the venue's rule pack.
  const key = generateSigningKey().privateKeyPem;
  const packs = new pg.Pool({ connectionString: db.url });
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(packs, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  await packs.end();
  const ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [
      async (request) => (request.headers.authorization === "manager" ? andy : undefined),
    ],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  delete process.env["TRUSTED_PROXY_HOPS"];
  await app.close();
  await raw.end();
  await db.drop();
});

beforeEach(async () => {
  ip = `203.0.113.${++ipSeq}`;
  clock.set(SEED_NOW);
  await raw.query("delete from venue_settings where venue_id = $1 and key = 'publicForms'", [
    venueId,
  ]);
});

describe("the CAPTCHA on the waitlist page and on phone codes", () => {
  it("the widget's site key comes from the API: Cloudflare's always-pass test key locally", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/public/captcha" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ provider: "turnstile", site_key: TURNSTILE_TEST.passSiteKey });
    expect(JSON.stringify(r.json())).not.toContain(TURNSTILE_TEST.passSecret);
  });

  it("a waitlist join with no token, or a wrong one, is refused and nothing is made", async () => {
    const before = await waitlistRows();
    const none = await join({ name: "Bot", phone: "+12125550190", party_size: 4 });
    expect(none.statusCode).toBe(403);
    expect(none.json()).toMatchObject({
      error: { code: "captcha_failed", retryable: false, details: { reason: "captcha" } },
    });
    const wrong = await join({
      name: "Bot",
      phone: "+12125550190",
      party_size: 4,
      captcha_token: "not-a-turnstile-token",
    });
    expect(wrong.statusCode).toBe(403);
    expect(await waitlistRows()).toBe(before);
    const uses = await raw.query("select 1 from public_form_uses");
    expect(uses.rowCount).toBe(0);
    // With the dummy token the test widget hands back, the same join goes through.
    expect((await doorJoin("+12125550190")).statusCode).toBe(201);
  });

  it("a singer's phone code without a token is refused before any text", async () => {
    const texts = async () =>
      Number(
        (
          await raw.query<{ n: string }>(
            "select count(*) as n from jobs where kind like 'text%' or kind like '%text%'",
          )
        ).rows[0]!.n,
      );
    const before = await texts();
    const r = await app.inject({
      method: "POST",
      url: `/v1/public/venues/${slug}/singers`,
      headers: { authorization: "", "x-forwarded-for": ip },
      payload: { display_name: "Bot", phone_e164: "+16465550190" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: { code: "captcha_failed" } });
    expect(await texts()).toBe(before);
  });
});

describe("the daily limits per phone number, device and IP address", () => {
  it("per phone: the waitlist's default 3 joins a day, then the fourth is refused with the reason", async () => {
    const phone = "+12125550192";
    for (let i = 0; i < 3; i += 1) {
      ip = `198.51.100.${i + 1}`;
      const r = await doorJoin(phone);
      expect(r.statusCode, r.body).toBe(201);
      expect((await leave(r.json<{ token: string }>().token)).statusCode).toBe(200);
    }
    ip = "198.51.100.9";
    const fourth = await doorJoin(phone);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toMatchObject({
      error: {
        code: "daily_limit",
        retryable: false,
        details: { reason: "daily_limit", limit: "phone" },
      },
    });
    // The next business date (after the 6:00 AM cutover) it works again.
    clock.set(SEED_NOW.add({ hours: 24 }));
    expect((await doorJoin(phone)).statusCode).toBe(201);
  });

  it("per device: the same cookie with new numbers stops at the venue's limit", async () => {
    await setLimits({ waitlist: { perPhone: 3, perIp: 50, perDevice: 2 } });
    const first = await doorJoin("+12125550193");
    expect(first.statusCode).toBe(201);
    const cookie = deviceCookie(first);
    expect(cookie).toMatch(/^west4_device=[A-Za-z0-9_-]{22}$/);
    expect(String(first.headers["set-cookie"])).toMatch(/Path=\/v1\/; HttpOnly; SameSite=Lax/);
    ip = "198.51.100.20";
    expect((await doorJoin("+12125550194", { cookie: cookie! })).statusCode).toBe(201);
    ip = "198.51.100.21";
    const third = await doorJoin("+12125550195", { cookie: cookie! });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { details: { limit: "device" } } });
    // Another phone (no cookie) on that address still joins.
    expect((await doorJoin("+12125550196")).statusCode).toBe(201);
  });

  it("per IP address: new numbers and no cookie from one address stop at its limit", async () => {
    await setLimits({ waitlist: { perPhone: 3, perIp: 2, perDevice: 5 } });
    expect((await doorJoin("+12125550197")).statusCode).toBe(201);
    expect((await doorJoin("+12125550198")).statusCode).toBe(201);
    const third = await doorJoin("+12125550199");
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { details: { limit: "ip" } } });
    ip = "198.51.100.30";
    expect((await doorJoin("+12125550199")).statusCode).toBe(201);
  });

  it("phone codes have their own limit, shared by singers and staff invites at the venue", async () => {
    await setLimits({ phoneCode: { perPhone: 2, perIp: 30, perDevice: 10 } });
    const ask = () =>
      app.inject({
        method: "POST",
        url: `/v1/public/venues/${slug}/singers`,
        headers: { authorization: "", "x-forwarded-for": ip },
        payload: { display_name: "Kira", phone_e164: "+16465550191", captcha_token: TOKEN },
      });
    await raw.query(
      "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'bar_mode'",
      [venueId],
    );
    const one = await ask();
    expect(one.statusCode, one.body).toBe(202);
    expect((await ask()).statusCode).toBe(202);
    const third = await ask();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({
      error: { code: "daily_limit", details: { limit: "phone" } },
    });
    // The waitlist's count is its own.
    expect((await doorJoin("+16465550191")).statusCode).toBe(201);
  });

  it("keeps only keyed hashes of the phone, the address and the device", async () => {
    expect((await doorJoin("+12125550188")).statusCode).toBe(201);
    const rows = await raw.query<{ phone_hash: string; ip_hash: string; device_hash: string }>(
      "select phone_hash, ip_hash, device_hash from public_form_uses order by created_at desc limit 1",
    );
    const row = rows.rows[0]!;
    expect(row.phone_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.device_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("2125550188");
    expect(JSON.stringify(row)).not.toContain(ip);
  });

  it("Andy (manager) reads the defaults in Admin, saves his own, and a limit below 1 is refused", async () => {
    const admin = (method: "GET" | "PUT", payload?: object) =>
      app.inject({
        method,
        url: `/v1/venues/${venueId}/settings/publicForms`,
        headers: { authorization: "manager" },
        ...(payload ? { payload } : {}),
      });
    const read = await admin("GET");
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({
      value: {
        waitlist: { perPhone: 3, perIp: 50, perDevice: 5 },
        phoneCode: { perPhone: 5, perIp: 30, perDevice: 10 },
      },
    });
    const own = {
      waitlist: { perPhone: 1, perIp: 50, perDevice: 5 },
      phoneCode: { perPhone: 5, perIp: 30, perDevice: 10 },
    };
    const saved = await admin("PUT", { value: own });
    expect(saved.statusCode, saved.body).toBe(200);
    const refused = await admin("PUT", {
      value: { ...own, waitlist: { perPhone: 0, perIp: 50, perDevice: 5 } },
    });
    expect(refused.statusCode).toBe(400);
    // His 1 a phone is in force at once.
    expect((await doorJoin("+12125550187")).statusCode).toBe(201);
    ip = "198.51.100.40";
    const r = await doorJoin("+12125550187");
    expect(r.statusCode).toBe(429);
  });
});

describe("Turnstile's siteverify", () => {
  let stub: Server;
  let url = "";
  let answer: { status: number; body: unknown } = { status: 200, body: { success: true } };
  const seen: Record<string, unknown>[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (d: Buffer) => (s += d.toString()));
      req.on("end", () => resolve(s));
    });

  beforeAll(async () => {
    stub = createServer((req, res) => {
      void read(req).then((text) => {
        seen.push({ path: req.url, ...(JSON.parse(text) as Record<string, unknown>) });
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/turnstile/v0/siteverify`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  const config = {
    siteKey: "0x4AAAAAAAsite",
    secretKey: "0x4AAAAAAAsecret-not-real",
    verifyUrl: "",
  };

  it("posts the secret, the token, the guest's address and an idempotency key", async () => {
    answer = { status: 200, body: { success: true, "error-codes": [] } };
    const verify = turnstileVerifier({ ...config, verifyUrl: url });
    expect(await verify("a-real-looking-token", "203.0.113.7")).toEqual({ ok: true });
    const call = seen.at(-1)!;
    expect(call).toMatchObject({
      path: "/turnstile/v0/siteverify",
      secret: "0x4AAAAAAAsecret-not-real",
      response: "a-real-looking-token",
      remoteip: "203.0.113.7",
    });
    expect(call["idempotency_key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a refused token is a failure; Cloudflare down or our key wrong is 'unavailable'", async () => {
    const verify = turnstileVerifier({ ...config, verifyUrl: url });
    answer = { status: 200, body: { success: false, "error-codes": ["invalid-input-response"] } };
    expect(await verify("t", null)).toEqual({
      ok: false,
      unavailable: false,
      codes: ["invalid-input-response"],
    });
    answer = { status: 200, body: { success: false, "error-codes": ["invalid-input-secret"] } };
    expect(await verify("t", null)).toMatchObject({ ok: false, unavailable: true });
    answer = { status: 500, body: {} };
    expect(await verify("t", null)).toMatchObject({ ok: false, unavailable: true });
    const down = turnstileVerifier({ ...config, verifyUrl: "http://127.0.0.1:9/siteverify" });
    expect(await down("t", null)).toMatchObject({ ok: false, unavailable: true });
    // No token never leaves the API.
    const calls = seen.length;
    expect(await verify("", null)).toMatchObject({ ok: false, unavailable: false });
    expect(seen.length).toBe(calls);
  });

  it("through the API: a stand-in's answer decides the join, and an outage makes nothing", async () => {
    const other = buildApp({
      config: loadConfig({
        WEST4_ENV: "local",
        DATABASE_URL: db.url,
        APP_DATABASE_URL: db.url,
        TURNSTILE_SITE_KEY: config.siteKey,
        TURNSTILE_SECRET_KEY: config.secretKey,
        TURNSTILE_VERIFY_URL: url,
      }),
      clock,
      moduleCacheMs: 0,
    });
    await other.ready();
    try {
      const post = (phone: string) =>
        other.inject({
          method: "POST",
          url: `/v1/public/venues/${slug}/waitlist`,
          headers: { authorization: "", "x-forwarded-for": ip },
          payload: { name: "Ana", phone, party_size: 2, captcha_token: "real-widget-token" },
        });
      const site = await other.inject({ method: "GET", url: "/v1/public/captcha" });
      expect(site.json()).toMatchObject({ site_key: config.siteKey });
      answer = { status: 200, body: { success: true } };
      expect((await post("+12125550181")).statusCode).toBe(201);
      expect(seen.at(-1)).toMatchObject({ response: "real-widget-token", remoteip: ip });
      answer = { status: 200, body: { success: false, "error-codes": ["timeout-or-duplicate"] } };
      expect((await post("+12125550182")).statusCode).toBe(403);
      const before = await waitlistRows();
      answer = { status: 503, body: {} };
      const out = await post("+12125550183");
      expect(out.statusCode).toBe(503);
      expect(out.json()).toMatchObject({
        error: { code: "captcha_unavailable", retryable: true },
      });
      expect(await waitlistRows()).toBe(before);
      // The dummy token a test widget makes is refused by a real secret, as Cloudflare does.
      answer = { status: 200, body: { success: false, "error-codes": ["invalid-input-response"] } };
      expect((await post("+12125550184")).statusCode).toBe(403);
    } finally {
      await other.close();
    }
  });
});

describe("the keys", () => {
  it("Cloudflare's test secrets answer as documented, with no call out", async () => {
    const cfg = loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: "postgres://x",
      APP_DATABASE_URL: "postgres://x",
    }).captcha;
    const local = (secretKey: string) =>
      turnstileVerifier({ ...cfg, secretKey }, () => {
        throw new Error("no call");
      });
    expect(await local(TURNSTILE_TEST.passSecret)(TOKEN, null)).toEqual({ ok: true });
    expect(await local(TURNSTILE_TEST.passSecret)("other", null)).toMatchObject({ ok: false });
    expect(await local(TURNSTILE_TEST.failSecret)(TOKEN, null)).toMatchObject({ ok: false });
    expect(await local(TURNSTILE_TEST.spentSecret)(TOKEN, null)).toMatchObject({
      ok: false,
      codes: ["timeout-or-duplicate"],
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, seedHostToken } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  MemoryExporter,
  SEED_NOW,
  SimulatedClock,
  Telemetry,
  makeDeviceKey,
  newTraceparent,
  parseTraceparent,
  signDeviceRequest,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { route } from "../http/conventions.js";
import { sweepVendorHealth } from "../jobs/vendor-health.js";
import { setTelemetry } from "./index.js";
import { setOperatorStatus } from "./status.js";

/**
 * M8-16 · Watching production, on the demo seed (Fri Sep 25, 2026, 10:41 PM):
 * - a Room 9 phone's order is traced from the room page to the bar computer's alarm;
 * - an error with a guest's phone number reaches error tracking, and the log, with it stripped;
 * - the public status page shows each part, follows the vendor-health sweep and an operator's post.
 */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
let host = "";
let bar: { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
const clock = new SimulatedClock(SEED_NOW);
const memory = new MemoryExporter();
const tel = new Telemetry({ service: "west4-api", exporter: memory, flushMs: 0 });
const logged: string[] = [];
// Fixtures from the demo seed: Marcus T.'s phone, and an email and a token in the same shapes.
const PHONE = "+12125550145";
const EMAIL = "marcus.t@example.com";
const TOKEN = "q7Zk2XbV9pLmN4tR8sW1yA0c";

const cookieOf = (h: string | string[] | undefined) =>
  String(Array.isArray(h) ? h[0] : h).split(";")[0]!;

const jager = async () =>
  (
    await raw.query<{ id: string }>(
      `select v.id from menu_variants v join menu_items i on i.id = v.item_id
        where i.venue_id = $1 and i.name = 'Jäger Bomb' limit 1`,
      [venueId],
    )
  ).rows[0]!.id;

async function signed(method: "POST", path: string, body = "") {
  const headers = await signDeviceRequest({
    deviceId: bar.id,
    privateKey: bar.key.privateKey,
    method,
    path,
    body,
  });
  return app.inject({ method, url: path, headers, ...(body ? { payload: body } : {}) });
}

beforeAll(async () => {
  setTelemetry(tel);
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  const k = await makeDeviceKey();
  bar = {
    id: (
      await raw.query<{ id: string }>(
        "insert into devices (venue_id, kind, name, public_key) values ($1, 'bar_computer', 'Bar trace', $2) returning id",
        [venueId, JSON.stringify(k.publicJwk)],
      )
    ).rows[0]!.id,
    key: k,
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    logger: { level: "info", stream: { write: (line: string) => void logged.push(line) } },
    extraRoutes: (scope) => {
      // A fixture route that fails the way a bug would, with personal data in the error and the log.
      scope.post(
        "/v1/fixture/explode",
        { config: route({ principals: ["public"], module: "core", idempotency: "none" }) },
        async (request) => {
          request.log.info(
            { guest: { phone: PHONE, email: EMAIL }, note: `token=${TOKEN}` },
            `texting ${PHONE}`,
          );
          throw new Error(`Twilio refused ${PHONE} for ${EMAIL} with ${TOKEN}`);
        },
      );
    },
  });
  await app.ready();
  host = cookieOf(
    (
      await app.inject({
        method: "POST",
        url: "/v1/public/room-session/host",
        payload: { token: seedHostToken("sess_room9") },
      })
    ).headers["set-cookie"],
  );
});

afterAll(async () => {
  await app?.close();
  await raw?.end();
  await db?.drop();
  setTelemetry(new Telemetry({ service: "west4-api", exporter: null }));
});

describe("a traced room order (M8-16)", () => {
  it("shows its path from the room page to the bar computer's alarm, with the time it took", async () => {
    // The room page starts the trace and sends it with the order.
    const pageSpan = parseTraceparent(newTraceparent())!;
    const placed = await app.inject({
      method: "POST",
      url: "/v1/public/room-session/orders",
      headers: {
        cookie: host,
        traceparent: `00-${pageSpan.traceId}-${pageSpan.spanId}-01`,
      },
      payload: {
        client_order_id: "trace-order-0001",
        lines: [{ variant_id: await jager(), qty: 1 }],
      },
    });
    expect(placed.statusCode, placed.body).toBe(201);
    const orderId = placed.json<{ order: { id: string } }>().order.id;
    // The page reports its own span, the send as the guest waited for it.
    const reported = await app.inject({
      method: "POST",
      url: "/v1/public/telemetry",
      payload: {
        service: "guest",
        errors: [],
        spans: [
          {
            name: "room.order.send",
            traceparent: `00-${pageSpan.traceId}-${pageSpan.spanId}-01`,
            duration_ms: 140,
          },
        ],
      },
    });
    expect(reported.statusCode).toBe(202);

    // 1.8 seconds later on the venue's clock, the bar computer's alarm rings for it.
    clock.advance({ milliseconds: 1800 });
    const rang = await signed("POST", `/v1/venues/${venueId}/orders/${orderId}/rang`);
    expect(rang.statusCode, rang.body).toBe(204);
    // A second ring (the minute reminder) doesn't measure it again.
    clock.advance({ seconds: 60 });
    expect((await signed("POST", `/v1/venues/${venueId}/orders/${orderId}/rang`)).statusCode).toBe(
      204,
    );

    await tel.flush();
    const trace = memory.spans().filter((s) => s.traceId === pageSpan.traceId);
    const server = trace.find((s) => s.name === "POST /v1/public/room-session/orders")!;
    const alarm = trace.find((s) => s.name === "bar.alarm")!;
    const page = trace.find((s) => s.name === "room.order.send")!;
    expect(page.spanId).toBe(pageSpan.spanId);
    expect(page.parentSpanId).toBeNull();
    expect(page.endMs - page.startMs).toBe(140);
    expect(server.parentSpanId).toBe(pageSpan.spanId);
    expect(server.attributes["part"]).toBe("ordering");
    expect(server.attributes["order.id"]).toBe(orderId);
    expect(alarm.parentSpanId).toBe(server.spanId);
    // The simulated clock also runs on in real time, so a few milliseconds more than 1.8 s.
    expect(alarm.endMs - alarm.startMs).toBeGreaterThanOrEqual(1800);
    expect(alarm.endMs - alarm.startMs).toBeLessThan(3000);
    expect(trace.filter((s) => s.name === "bar.alarm")).toHaveLength(1);
    const measured = memory.metrics().filter((m) => m.name === "order_to_alarm_ms");
    expect(measured).toHaveLength(1);
    expect(measured[0]!.value).toBe(alarm.endMs - alarm.startMs);
    expect(measured[0]!.attributes["slow"]).toBe(false);
  });

  it("only the venue's own bar or front-desk computer reports a ring", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/orders/${ids["room_9"]}/rang`,
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe("error tracking and logs strip personal data (M8-16)", () => {
  it("an error with a guest's phone number reaches the tracker with the number stripped", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/fixture/explode" });
    expect(res.statusCode).toBe(500);
    await tel.flush();
    const reports = memory
      .logs()
      .filter(
        (l) => l.severity === "error" && l.attributes["http.route"] === "/v1/fixture/explode",
      );
    expect(reports).toHaveLength(1);
    expect(reports[0]!.body).toBe("Twilio refused [phone] for [email] with [token]");
    expect(reports[0]!.traceId).toBeTruthy();
    const exported = JSON.stringify(memory.records);
    const log = logged.join("\n");
    for (const secret of [PHONE, EMAIL, TOKEN, "2125550145"]) {
      expect(exported).not.toContain(secret);
      expect(log).not.toContain(secret);
    }
    expect(log).toContain("texting [phone]");
    expect(log).toContain("/v1/fixture/explode");
  });

  it("the screens' errors arrive scrubbed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/telemetry",
      payload: {
        service: "guest",
        errors: [
          { message: `pay failed for ${EMAIL}`, stack: `at /pay/${TOKEN}`, page: "/r/room-9" },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    await tel.flush();
    const report = memory.logs().find((l) => l.attributes["client.service"] === "guest")!;
    expect(report.body).toBe("pay failed for [email]");
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });
});

describe("the public status page (M8-16)", () => {
  const status = async () =>
    (await app.inject({ method: "GET", url: "/v1/public/status" })).json<{
      parts: { part: string; state: string; note: string | null }[];
    }>().parts;

  it("shows each part", async () => {
    expect((await status()).map((p) => `${p.part} ${p.state}`)).toEqual([
      "ordering operational",
      "payments operational",
      "printing operational",
      "texts operational",
    ]);
  });

  it("follows Stripe's trouble, and an operator's post over it, then clears", async () => {
    const pool = new pg.Pool({ connectionString: db.url, max: 2 });
    try {
      const feed = async (url: string | URL | Request) =>
        new Response(
          JSON.stringify({
            status: { indicator: String(url).includes("stripe") ? "major" : "none" },
          }),
        );
      await sweepVendorHealth(
        pool,
        clock.now(),
        {
          statusUrls: {
            stripe: "https://status.stripe.test",
            twilio: "https://status.twilio.test",
          },
          minCalls: 20,
          ratePercent: 20,
          windowMinutes: 5,
        } as never,
        feed as typeof fetch,
      );
      let parts = await status();
      expect(parts.find((p) => p.part === "payments")!.state).toBe("degraded");
      expect(parts.find((p) => p.part === "texts")!.state).toBe("operational");

      // A drill (M8-07): an operator posts it, and the page shows the post over the sweep's state.
      await setOperatorStatus(
        pool,
        "ordering",
        "maintenance",
        `Drill at a venue · call ${PHONE}`,
        "ops",
        clock.now().toString(),
      );
      parts = await status();
      expect(parts.find((p) => p.part === "ordering")).toMatchObject({
        state: "maintenance",
        note: "Drill at a venue · call [phone]",
      });
      await setOperatorStatus(pool, "ordering", null, null, "ops", clock.now().toString());
      await sweepVendorHealth(
        pool,
        clock.now(),
        {
          statusUrls: { stripe: null, twilio: null },
          minCalls: 20,
          ratePercent: 20,
          windowMinutes: 5,
        } as never,
        feed as typeof fetch,
      );
      parts = await status();
      expect(parts.every((p) => p.state === "operational")).toBe(true);
    } finally {
      await pool.end();
    }
  });
});

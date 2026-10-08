import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  JsonLinesExporter,
  MemoryExporter,
  OtlpHttpExporter,
  Telemetry,
  burnRate,
  cardOutcome,
  encodeMetrics,
  firingBurnAlerts,
  formatTraceparent,
  isSensitiveKey,
  makeClientReporter,
  type ClientTelemetryBody,
  p95,
  parseOtlpHeaders,
  parseTraceparent,
  partOfRoute,
  scrubText,
  scrubValue,
} from "../index.js";

// Every phone number, email and secret in the demo seed: none may survive a scrub.
const seed = readFileSync(new URL("../../../../seed/west4-friday.json", import.meta.url), "utf8");
const PHONES = [...new Set(seed.match(/\+1\d{10}/g))];
const EMAILS = [...new Set(seed.match(/[\w.+-]+@[\w-]+\.[\w.]+/g))];
const TOKENS = [
  "WEST4DEMOABHISHEKTOTPSECRET2026A", // the demo TOTP secret
  "q7Zk2XbV9pLmN4tR8sW1yA", // a 16-byte base64url room or pay token
  "Qm9yZTJfc2Vzc2lvbl90b2tlbl8yNA4x", // a 24-byte session token
  "sk_test_51NxYzAbCdEf0123456789",
  "rk_live_9a8b7c6d5e4f",
  "whsec_abc123def456",
  "pi_3Nabc123_secret_XyZ987",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl",
];
const CARDS = ["4242424242424242", "4000 0566 5566 5556", "5555-5555-5555-4444"];

describe("scrubbing personal data (M8-16)", () => {
  it("finds the seed's fixtures", () => {
    expect(PHONES.length).toBeGreaterThan(10);
    expect(EMAILS.length).toBeGreaterThan(0);
  });

  it("strips every fixture phone, email, token and card from a message", () => {
    const message = [
      ...PHONES.map((p) => `text to ${p} failed`),
      "call (212) 555-0123 or 212.555.0199 or 212 555 0142",
      ...EMAILS.map((e) => `mail to ${e}`),
      ...TOKENS.map((t) => `token ${t}`),
      "GET /v1/public/join?token=abcDEF&room=9",
      "Authorization: Bearer abc.def.ghi",
      ...CARDS.map((c) => `card ${c}`),
    ].join("\n");
    const out = scrubText(message);
    for (const secret of [...PHONES, ...EMAILS, ...TOKENS, ...CARDS, "abcDEF", "abc.def.ghi"])
      expect(out).not.toContain(secret);
    for (const p of ["2125550123", "555-0123", "555.0199", "555 0142"])
      expect(out).not.toContain(p);
    expect(out).toContain("[phone]");
    expect(out).toContain("[email]");
    expect(out).toContain("[token]");
    expect(out).toContain("[card]");
  });

  it("keeps what debugging needs: ids, amounts, times, error codes", () => {
    const text =
      "order 550e8400-e29b-41d4-a716-446655440000 for $618.60 (61860 cents) at 2026-09-25T22:41:00-04:00 · ordering_closed · room 9";
    expect(scrubText(text)).toBe(text);
  });

  it("replaces values under personal or secret keys, whatever they look like", () => {
    const out = scrubValue({
      guest_name: "Marcus T.",
      firstName: "Marcus",
      phone_e164: "+12125550145",
      headers: { authorization: "Bearer x", cookie: "west4_session=abc", "x-api-key": "k" },
      card: { last4: "4242" },
      total_cents: 61860,
      room: "Room 9",
      code: "ordering_closed",
    }) as Record<string, unknown>;
    expect(out).toEqual({
      guest_name: "[redacted]",
      firstName: "[redacted]",
      phone_e164: "[redacted]",
      headers: { authorization: "[redacted]", cookie: "[redacted]", "x-api-key": "[redacted]" },
      card: "[redacted]",
      total_cents: 61860,
      room: "Room 9",
      code: "ordering_closed",
    });
    expect(isSensitiveKey("service.name")).toBe(false);
    expect(isSensitiveKey("venue_id")).toBe(false);
  });

  it("scrubs an error's message and stack", () => {
    const e = new Error("no answer from +12125550145 (marcus@example.com)");
    const out = scrubValue(e) as { message: string; stack: string };
    expect(out.message).toBe("no answer from [phone] ([email])");
    expect(out.stack).not.toContain("+12125550145");
  });
});

describe("telemetry records", () => {
  it("never exports a fixture phone, email or token, in errors, logs, spans or metrics", async () => {
    const memory = new MemoryExporter();
    const lines: string[] = [];
    const t = new Telemetry({ service: "test", exporter: memory, flushMs: 0 });
    const json = new Telemetry({
      service: "test",
      exporter: new JsonLinesExporter((l) => lines.push(l)),
      flushMs: 0,
    });
    for (const tel of [t, json]) {
      for (const p of PHONES) tel.captureError(new Error(`Twilio refused ${p}`), { to: p });
      for (const e of EMAILS) tel.log("warn", `bounced ${e}`, { email: e, note: e });
      for (const k of TOKENS) {
        const span = tel.startSpan(`GET /pay/${k}`, { attributes: { url: `/pay/${k}` } });
        span.end({ error: new Error(`bad token ${k}`) });
        tel.count("calls", 1, { token: k, path: `/x?token=${k}` });
      }
      await tel.flush();
    }
    const exported = JSON.stringify(memory.records) + lines.join("\n");
    for (const secret of [...PHONES, ...EMAILS, ...TOKENS]) expect(exported).not.toContain(secret);
    expect(memory.logs().filter((l) => l.severity === "error").length).toBe(
      PHONES.length + TOKENS.length,
    );
  });

  it("ties a child span to its parent's trace through a traceparent header", async () => {
    const memory = new MemoryExporter();
    let now = 1_000;
    const t = new Telemetry({ service: "api", exporter: memory, flushMs: 0, now: () => now });
    const root = t.startSpan("room.order.submit");
    const parent = parseTraceparent(root.traceparent);
    expect(parent).toEqual({ traceId: root.traceId, spanId: root.spanId });
    const child = t.startSpan("POST /v1/public/room-session/orders", { parent });
    now = 1_250;
    child.end();
    root.end();
    await t.flush();
    const [c, r] = memory.spans();
    expect(c!.traceId).toBe(r!.traceId);
    expect(c!.parentSpanId).toBe(r!.spanId);
    expect(c!.endMs - c!.startMs).toBe(250);
    expect(parseTraceparent("00-00000000000000000000000000000000-0000000000000000-01")).toBeNull();
    expect(parseTraceparent("garbage")).toBeNull();
    expect(formatTraceparent({ traceId: "a".repeat(32), spanId: "b".repeat(16) })).toBe(
      `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    );
  });

  it("sends OTLP/HTTP JSON to the configured endpoint with its headers", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const exporter = new OtlpHttpExporter(
      "https://collector.example/",
      parseOtlpHeaders("x-honeycomb-team=abc,api-key=k%3Dv"),
      async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return { ok: true, status: 200 };
      },
    );
    const t = new Telemetry({ service: "api", exporter, flushMs: 0 });
    t.startSpan("x").end();
    t.log("info", "hello");
    t.observe("order_to_alarm_ms", 1200);
    await t.flush();
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://collector.example/v1/logs",
      "https://collector.example/v1/metrics",
      "https://collector.example/v1/traces",
    ]);
    expect(calls[0]!.headers["api-key"]).toBe("k=v");
    const traces = JSON.parse(calls.find((c) => c.url.endsWith("traces"))!.body);
    expect(traces.resourceSpans[0].resource.attributes[0]).toEqual({
      key: "service.name",
      value: { stringValue: "api" },
    });
  });

  it("puts a duration in the right histogram bucket", () => {
    const m = encodeMetrics([
      {
        kind: "metric",
        service: "api",
        name: "order_to_alarm_ms",
        type: "histogram",
        value: 2500,
        unit: "ms",
        atMs: 0,
        attributes: {},
      },
    ]);
    const dp = m.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.histogram!.dataPoints[0]!;
    expect(dp.bucketCounts.indexOf("1")).toBe(dp.explicitBounds.indexOf(3000));
  });

  it("an exporter that fails drops its batch, never throws", async () => {
    const t = new Telemetry({
      service: "api",
      exporter: { export: () => Promise.reject(new Error("down")) },
      flushMs: 0,
    });
    t.log("info", "x");
    await expect(t.flush()).resolves.toBeUndefined();
    expect(t.dropped).toBe(1);
  });
});

describe("targets", () => {
  it("names the part a route belongs to", () => {
    expect(partOfRoute("/v1/public/room-session/orders")).toBe("ordering");
    expect(partOfRoute("/v1/venues/:venueId/orders")).toBe("ordering");
    expect(partOfRoute("/v1/venues/:venueId/payments/:paymentId/tap")).toBe("payments");
    expect(partOfRoute("/v1/public/pay/:token")).toBe("payments");
    expect(partOfRoute("/v1/venues/:venueId/print-host/next")).toBe("printing");
    expect(partOfRoute("/v1/print/cloudprnt")).toBe("printing");
    expect(partOfRoute("/v1/hooks/twilio/status")).toBe("texts");
    expect(partOfRoute("/v1/venues/:venueId/conversations")).toBe("texts");
    expect(partOfRoute("/v1/venues/:venueId/board")).toBeNull();
  });

  it("counts card failures on our side, not declines", () => {
    expect(cardOutcome("succeeded", null)).toBe("ok");
    expect(cardOutcome("unknown", null)).toBe("our_side");
    expect(cardOutcome("failed", "card_declined")).toBe("declined");
    expect(cardOutcome("failed", "insufficient_funds")).toBe("declined");
    expect(cardOutcome("failed", "reader_offline")).toBe("our_side");
    expect(cardOutcome("failed", "timeout")).toBe("our_side");
    expect(cardOutcome("canceled", null)).toBeNull();
  });

  it("works out burn rates and which alerts fire", () => {
    // 99.9%: 1 bad in 1,000 burns exactly at 1; 15 bad in 1,000 burns at 15.
    expect(burnRate(1, 1000, 0.999)).toBeCloseTo(1);
    expect(burnRate(0, 0, 0.999)).toBe(0);
    const fast = firingBurnAlerts(0.999, {
      60: { bad: 15, total: 1000 },
      5: { bad: 2, total: 100 },
      360: { bad: 20, total: 6000 },
      30: { bad: 2, total: 500 },
    });
    expect(fast.map((a) => a.longMinutes)).toEqual([60]);
    expect(p95([100, 200, 300, 400, 5000])).toBe(5000);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });
});

describe("the screens' reporter", () => {
  it("scrubs before sending, drops repeats and caps a flood", async () => {
    const sent: ClientTelemetryBody[] = [];
    let now = 0;
    const r = makeClientReporter({
      service: "guest",
      post: async (b) => void sent.push(b),
      now: () => now,
      maxPerMinute: 3,
      delayMs: 10_000,
    });
    r.error(new Error(`no text to ${PHONES[0]}`), { page: `/r/${TOKENS[1]}?x=1` });
    r.error(new Error(`no text to ${PHONES[0]}`)); // the same message again within the minute
    for (let i = 0; i < 5; i++) r.error(new Error(`loop ${i}`));
    r.span({ name: "room.order.send", traceparent: "garbage", duration_ms: 5 });
    await r.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.errors.map((e) => e.message)).toEqual([
      "no text to [phone]",
      "loop 0",
      "loop 1",
    ]);
    expect(sent[0]!.errors[0]!.page).toBe("/r/[token]");
    expect(sent[0]!.spans).toEqual([]);
    now = 61_000;
    r.error(new Error(`no text to ${PHONES[0]}`));
    await r.flush();
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent)).not.toContain(PHONES[0]!);
  });
});

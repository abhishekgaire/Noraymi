import { describe, expect, it } from "vitest";
import { SEED_NOW, Temporal } from "@west4/shared";
import { RETENTION, RETENTION_POLICY, retentionCutoffs } from "./retention.js";

/** M8-12: each kind's cutoff on the simulated clock (Fri Sep 25, 2026, 10:41 PM in New York). */
const cut = retentionCutoffs(SEED_NOW, "America/New_York");
const local = (kind: string) =>
  cut[kind]!.toZonedDateTimeISO("America/New_York").toPlainDateTime().toString();

describe("retention cutoffs", () => {
  it("lets each kind go after its time, in calendar terms on the venue's clock", () => {
    expect(local("guests")).toBe("2024-09-25T22:41:00");
    expect(local("bookings")).toBe("2023-09-25T22:41:00");
    expect(local("waitlist_entries")).toBe("2023-09-25T22:41:00");
    expect(local("enquiries")).toBe("2023-09-25T22:41:00");
    expect(local("messages")).toBe("2022-09-25T22:41:00");
    expect(local("consents")).toBe("2022-09-25T22:41:00");
    expect(local("print_payloads")).toBe("2026-08-26T22:41:00");
    expect(local("webhook_payloads")).toBe("2026-06-27T22:41:00");
    expect(local("idempotency_keys")).toBe("2026-09-18T22:41:00");
    expect(local("venue_events")).toBe("2026-09-22T22:41:00");
    expect(local("singers")).toBe("2026-08-26T22:41:00");
    expect(local("booking_cards")).toBe("2026-08-26T22:41:00");
    expect(local("tab_cards")).toBe("2026-09-18T22:41:00");
    expect(local("message_bodies_at_twilio")).toBe("2026-08-26T22:41:00");
  });

  it("puts a guest seen 24 months and a day ago past the cutoff, and one seen yesterday inside it", () => {
    const zoned = SEED_NOW.toZonedDateTimeISO("America/New_York");
    const old = zoned.subtract({ months: 24, days: 1 }).toInstant();
    const yesterday = zoned.subtract({ days: 1 }).toInstant();
    expect(Temporal.Instant.compare(old, cut["guests"]!)).toBe(-1);
    expect(Temporal.Instant.compare(yesterday, cut["guests"]!)).toBe(1);
  });

  it("counts real days across daylight saving (72 hours of events stays 72 hours)", () => {
    const sunday = Temporal.Instant.from("2026-11-02T12:00:00Z");
    const c = retentionCutoffs(sunday, "America/New_York");
    expect(sunday.since(c["venue_events"]!).total("hours")).toBe(72);
  });

  it("never removes the money, wage and audit records, and keeps them their years", () => {
    const keep = RETENTION_POLICY.filter((r) => r.action === "keep").map((r) => r.kind);
    for (const r of RETENTION) expect(keep).toContain(r.table);
    for (const kind of Object.keys(cut)) expect(RETENTION.map((r) => r.table)).not.toContain(kind);
  });
});

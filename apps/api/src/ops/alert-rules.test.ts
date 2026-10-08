import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { ALERT_RULES, ESCALATE_AFTER_MINUTES, alertRule } from "./alert-rules.js";
import { dueSlots } from "./paging.js";
import { parseSns, readAlarm, verifySns } from "./sns.js";
import { makeSnsSigner } from "./sns-fixture.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const RUNBOOKS = join(ROOT, "docs/runbooks");

describe("every alert rule links a runbook that exists (M8-17)", () => {
  it("each rule's runbook is a file in docs/runbooks", () => {
    for (const r of ALERT_RULES) {
      expect(r.runbook, r.id).toMatch(/^docs\/runbooks\/[a-z0-9-]+\.md$/);
      expect(existsSync(join(ROOT, r.runbook)), `${r.id} → ${r.runbook}`).toBe(true);
    }
  });

  it("every rule but the test page has its own runbook, one per alert", () => {
    const own = ALERT_RULES.filter((r) => r.id !== "test-page");
    expect(new Set(own.map((r) => r.runbook)).size).toBe(own.length);
  });

  it("every CloudWatch alarm in Terraform names a known rule and a runbook that exists", () => {
    const tf = readdirSync(join(ROOT, "infra/staging"))
      .filter((f) => f.endsWith(".tf"))
      .map((f) => readFileSync(join(ROOT, "infra/staging", f), "utf8"))
      .join("\n");
    const found = [...tf.matchAll(/rule:([a-z0-9-]+) runbook:(docs\/runbooks\/[a-z0-9-]+\.md)/g)];
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const [, id, runbook] of found) {
      const r = alertRule(id!);
      expect(r, id).not.toBeNull();
      expect(r!.runbook).toBe(runbook);
      expect(r!.sources).toContain("cloudwatch");
      expect(existsSync(join(ROOT, runbook!)), runbook).toBe(true);
    }
  });

  it("every relative link inside the runbooks resolves", () => {
    for (const file of readdirSync(RUNBOOKS).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join(RUNBOOKS, file), "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^https?:/.test(target!)) continue;
        expect(existsSync(resolve(RUNBOOKS, target!)), `${file} → ${target}`).toBe(true);
      }
    }
  });

  it("device problems stay with the manager; money and targets page us", () => {
    expect(alertRule("device-offline")!.audience).toBe("manager");
    expect(alertRule("venue-offline")!.audience).toBe("manager");
    for (const id of [
      "payment-failures",
      "capture-sweep-failed",
      "money-dead-letters",
      "db-failover",
      "webhook-lag",
      "payout-unreconciled",
      "target-burn",
      "readers-offline",
    ])
      expect(alertRule(id)!.audience, id).toBe("us");
  });
});

describe("the escalation policy", () => {
  const opened = Temporal.Instant.from("2026-09-26T02:41:00Z");
  const both = [{ slot: "first" as const }, { slot: "second" as const }];
  it("goes to the first responder at once and the second after 10 minutes unacknowledged", () => {
    expect(ESCALATE_AFTER_MINUTES).toBe(10);
    expect(dueSlots(opened, opened, both)).toEqual(["first"]);
    expect(dueSlots(opened, opened.add({ minutes: 9, seconds: 59 }), both)).toEqual(["first"]);
    expect(dueSlots(opened, opened.add({ minutes: 10 }), both)).toEqual(["first", "second"]);
  });
  it("goes straight to the second when the first slot is empty, and nowhere with no rota", () => {
    expect(dueSlots(opened, opened, [{ slot: "second" }])).toEqual(["second"]);
    expect(dueSlots(opened, opened.add({ hours: 1 }), [])).toEqual([]);
  });
});

describe("SNS messages to the alarm hook", () => {
  const signer = makeSnsSigner();
  const base = {
    Type: "Notification" as const,
    MessageId: "m-1",
    TopicArn: "arn:aws:sns:us-east-1:123:west4-staging-pages",
    Timestamp: "2026-09-26T02:41:00.000Z",
    Message: JSON.stringify({
      AlarmName: "west4-staging-target-burn-payments-fast",
      AlarmDescription: "rule:target-burn runbook:docs/runbooks/target-burn.md · payments",
      NewStateValue: "ALARM",
    }),
  };

  it("believes a message signed with the signing certificate, and nothing altered", async () => {
    const m = signer.sign(base);
    expect(await verifySns(parseSns(JSON.stringify(m))!, signer.getCert)).toBe(true);
    expect(await verifySns({ ...m, Message: "{}" }, signer.getCert)).toBe(false);
    expect(
      await verifySns({ ...m, SigningCertURL: "https://evil.example.com/x.pem" }, signer.getCert),
    ).toBe(false);
  });

  it("reads the alarm's rule and state, and an RDS event", () => {
    expect(readAlarm(base.Message)).toEqual({
      kind: "alarm",
      name: "west4-staging-target-burn-payments-fast",
      rule: "target-burn",
      state: "ALARM",
    });
    expect(
      readAlarm(
        JSON.stringify({
          "Event Source": "db-instance",
          "Source ID": "west4-staging",
          "Event Message": "Multi-AZ instance failover completed",
        }),
      ),
    ).toMatchObject({ kind: "rds", source: "west4-staging" });
    expect(readAlarm("not json")).toEqual({ kind: "unknown" });
  });
});

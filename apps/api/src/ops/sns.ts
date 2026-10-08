import { createVerify } from "node:crypto";

/**
 * Amazon SNS messages to the alarm hook (M8-17): CloudWatch alarms and RDS failover events reach
 * us through the pages topic. A message is believed only when its signature verifies against
 * Amazon's signing certificate (fetched from an sns.<region>.amazonaws.com URL, outside any
 * transaction, and cached) and its TopicArn is the one PAGES_TOPIC_ARN names.
 */
export interface SnsMessage {
  readonly Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  readonly MessageId: string;
  readonly TopicArn: string;
  readonly Message: string;
  readonly Timestamp: string;
  readonly SignatureVersion: string;
  readonly Signature: string;
  readonly SigningCertURL: string;
  readonly Subject?: string;
  readonly SubscribeURL?: string;
  readonly Token?: string;
}

const NOTIFICATION = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const CONFIRMATION = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
] as const;

/** Amazon's canonical string to sign: each present field's name and value, a line each. */
export function stringToSign(m: SnsMessage): string {
  const fields = m.Type === "Notification" ? NOTIFICATION : CONFIRMATION;
  let out = "";
  for (const f of fields) {
    const v = (m as unknown as Record<string, string | undefined>)[f];
    if (v !== undefined) out += `${f}\n${v}\n`;
  }
  return out;
}

const AMAZON_URL = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\//;
export const isAmazonUrl = (url: string): boolean => AMAZON_URL.test(url);

export function parseSns(body: unknown): SnsMessage | null {
  let m: unknown = body;
  if (typeof body === "string") {
    try {
      m = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  for (const k of ["Type", "MessageId", "TopicArn", "Message", "Timestamp", "Signature"])
    if (typeof r[k] !== "string") return null;
  if (typeof r["SigningCertURL"] !== "string" || typeof r["SignatureVersion"] !== "string")
    return null;
  return m as SnsMessage;
}

export type CertFetcher = (url: string) => Promise<string>;

const certs = new Map<string, string>();
export const fetchCert: CertFetcher = async (url) => {
  const cached = certs.get(url);
  if (cached) return cached;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`signing certificate: ${res.status}`);
  const pem = await res.text();
  certs.set(url, pem);
  return pem;
};

/** Whether the message's signature is Amazon's. Never throws; a bad message is just false. */
export async function verifySns(m: SnsMessage, getCert: CertFetcher = fetchCert): Promise<boolean> {
  if (!isAmazonUrl(m.SigningCertURL) || !m.SigningCertURL.endsWith(".pem")) return false;
  const algorithm =
    m.SignatureVersion === "2" ? "RSA-SHA256" : m.SignatureVersion === "1" ? "RSA-SHA1" : null;
  if (!algorithm) return false;
  try {
    const pem = await getCert(m.SigningCertURL);
    return createVerify(algorithm).update(stringToSign(m)).verify(pem, m.Signature, "base64");
  } catch {
    return false;
  }
}

/** What an alarm message asks for, read from its JSON Message. */
export type AlarmEvent =
  | {
      kind: "alarm";
      name: string;
      rule: string | null;
      state: "ALARM" | "OK" | "INSUFFICIENT_DATA";
    }
  | { kind: "rds"; source: string; message: string }
  | { kind: "unknown" };

export function readAlarm(message: string): AlarmEvent {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(message) as Record<string, unknown>;
  } catch {
    return { kind: "unknown" };
  }
  if (typeof m["AlarmName"] === "string" && typeof m["NewStateValue"] === "string") {
    const description = typeof m["AlarmDescription"] === "string" ? m["AlarmDescription"] : "";
    const rule = /(?:^|\s)rule:([a-z0-9-]+)/.exec(description)?.[1] ?? null;
    const state = m["NewStateValue"] as "ALARM" | "OK" | "INSUFFICIENT_DATA";
    return { kind: "alarm", name: m["AlarmName"], rule, state };
  }
  if (typeof m["Event Source"] === "string" && typeof m["Source ID"] === "string")
    return {
      kind: "rds",
      source: m["Source ID"],
      message: typeof m["Event Message"] === "string" ? m["Event Message"] : "",
    };
  return { kind: "unknown" };
}

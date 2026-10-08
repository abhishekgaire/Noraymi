import type { ConsentRecord } from "./prepare.js";

/**
 * What an imported consent becomes (M9-03; spec 11 · Consent and timing):
 *   - opt_out: any opt-out, honored at once. An SMS opt-out, of service texts
 *     or of marketing, is kept as an opt-out of every text (kind `texts`), so a
 *     guest who opted out on the old site gets no text from us.
 *   - marketing_with_proof: a marketing opt-in with all of its proof: the
 *     form, its wording, the IP address and the time.
 *   - dropped_no_proof: a marketing opt-in missing any of that proof. It isn't
 *     imported as consent; the report lists it and what's missing.
 *   - service: an opt-in to service texts, which need no proof.
 */
export type ConsentOutcome = "service" | "marketing_with_proof" | "opt_out" | "dropped_no_proof";

export function consentOutcome(
  x: Pick<ConsentRecord, "kind" | "givenAt" | "revokedAt" | "form" | "textVersion" | "ip">,
): { outcome: ConsentOutcome; missing: string[] } {
  if (x.revokedAt !== null) return { outcome: "opt_out", missing: [] };
  if (x.kind === "texts") return { outcome: "service", missing: [] };
  const missing = [
    x.form ? null : "the form",
    x.textVersion ? null : "its wording",
    x.ip ? null : "the IP address",
    x.givenAt ? null : "the time",
  ].filter((m): m is string => m !== null);
  return missing.length === 0
    ? { outcome: "marketing_with_proof", missing }
    : { outcome: "dropped_no_proof", missing };
}

/** The kind an imported consent is stored as: an SMS opt-out stops every text. */
export function storedKind(x: Pick<ConsentRecord, "channel" | "kind" | "revokedAt">) {
  return x.revokedAt !== null && x.channel === "sms" ? "texts" : x.kind;
}

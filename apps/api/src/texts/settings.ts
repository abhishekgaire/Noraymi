import type { West4Env } from "../config.js";

/**
 * Texts from our platform's Twilio account (M1-23): phone confirmation codes
 * and PIN-reset links. They aren't among the venue's 14 guest texts (spec 11),
 * so they never go from a venue's subaccount. Locally, with no real
 * credentials, texts are logged instead of sent.
 */
export interface TextSettings {
  readonly mode: "twilio" | "log";
  readonly accountSid: string;
  readonly authToken: string;
  readonly fromNumber: string;
}

const PLACEHOLDER = /replace_me/;

export function loadTextSettings(
  env: West4Env,
  source: Record<string, string | undefined> = process.env,
): TextSettings {
  const accountSid = source["TWILIO_ACCOUNT_SID"] ?? "";
  const authToken = source["TWILIO_AUTH_TOKEN"] ?? "";
  const fromNumber = source["TWILIO_FROM_NUMBER"] ?? "";
  const unset =
    !accountSid || !authToken || !fromNumber || PLACEHOLDER.test(accountSid + authToken);
  if (unset) {
    if (env === "local") return { mode: "log", accountSid: "", authToken: "", fromNumber: "" };
    throw new Error("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER must be set");
  }
  return { mode: "twilio", accountSid, authToken, fromNumber };
}

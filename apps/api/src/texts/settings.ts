import type { West4Env } from "../config.js";

/**
 * Texts to our own on-call responders (M8-17's pages), never a venue's texts: a venue texts only
 * from its own Twilio account (D123). Optional everywhere: with no `PAGING_TWILIO_*` variables, pages
 * go by email only (locally they're logged instead). We hold no Twilio account for any venue.
 */
export interface TextSettings {
  readonly mode: "twilio" | "log" | "off";
  readonly accountSid: string;
  readonly authToken: string;
  readonly fromNumber: string;
}

const PLACEHOLDER = /replace_me/;

export function loadTextSettings(
  env: West4Env,
  source: Record<string, string | undefined> = process.env,
): TextSettings {
  const accountSid = source["PAGING_TWILIO_ACCOUNT_SID"] ?? "";
  const authToken = source["PAGING_TWILIO_AUTH_TOKEN"] ?? "";
  const fromNumber = source["PAGING_TWILIO_FROM_NUMBER"] ?? "";
  const unset =
    !accountSid || !authToken || !fromNumber || PLACEHOLDER.test(accountSid + authToken);
  if (unset)
    return { mode: env === "local" ? "log" : "off", accountSid: "", authToken: "", fromNumber: "" };
  return { mode: "twilio", accountSid, authToken, fromNumber };
}

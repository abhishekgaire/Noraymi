/**
 * Opt-out and help wording in a guest's text (M2-23; spec 11 · Consent and
 * timing). STOP and the carriers' other one-word keywords count only as the
 * whole message ("cancel my booking" is a booking question, not an opt-out);
 * a sentence counts when it asks to stop texting ("please stop texting me").
 */
const STOP_WORDS = new Set([
  "stop",
  "stopall",
  "stop all",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "revoke",
  "optout",
  "opt out",
  "opt-out",
]);
const HELP_WORDS = new Set(["help", "info"]);

const STOP_SENTENCES = [
  /\b(stop|quit|cease)\b.{0,20}\b(text|texting|texts|message|messaging|messages|msg|msgs|sms|contacting)\b/,
  /\b(don'?t|do not|never)\b.{0,10}\b(text|message|msg|contact)\b.{0,6}\bme\b/,
  /\bunsubscribe\b/,
  /\b(remove|take)\b.{0,6}\bme\b.{0,15}\b(list|texts?|messages?|off)\b/,
  /\bopt(-| )?out\b/,
];

export function smsKeyword(body: string): "stop" | "help" | null {
  const plain = body
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  if (STOP_WORDS.has(plain)) return "stop";
  if (HELP_WORDS.has(plain)) return "help";
  if (STOP_SENTENCES.some((r) => r.test(plain))) return "stop";
  return null;
}

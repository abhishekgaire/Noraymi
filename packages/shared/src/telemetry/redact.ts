/**
 * Personal data stripped before telemetry leaves (M8-16; spec 13 · Watching production,
 * spec 12 · How long we keep things: logs and error reports 30 days, personal data stripped).
 * Every log line, error report, span and metric goes through here, in the API, the job workers,
 * the staff app, the desktop app and the guest web, before it is written or exported.
 *
 * Two passes:
 * - by field: a value under a key that names personal data or a secret (name, phone, email,
 *   token, card, cookie, authorization, …) is replaced whole, whatever it looks like;
 * - by shape: inside any string, phone numbers, email addresses, card numbers (Luhn-valid,
 *   13 to 19 digits), bearer tokens, JWTs, Stripe keys and client secrets, secret-looking
 *   query parameters and long random tokens are replaced with a marker.
 *
 * Names can't be found by shape in free text, so they're stripped by field; error messages are
 * written without guests' names (apps/api http/errors.ts).
 */

export const REDACTED = "[redacted]";

/** Words in a key (snake_case, camelCase, kebab-case or dotted) that mark its value as personal or secret. */
const SENSITIVE_WORDS = new Set([
  "name",
  "names",
  "phone",
  "phones",
  "mobile",
  "email",
  "emails",
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passcode",
  "pin",
  "otp",
  "totp",
  "recovery",
  "authorization",
  "cookie",
  "cookies",
  "card",
  "pan",
  "cvc",
  "cvv",
  "address",
  "dob",
  "birthdate",
  "birthday",
  "signature",
  "apikey",
  "credential",
  "credentials",
]);

/** Keys that look sensitive by their words but carry no personal data. */
const SAFE_KEYS = new Set(["service.name", "span.name", "metric.name", "exception.type"]);

export function isSensitiveKey(key: string): boolean {
  if (SAFE_KEYS.has(key)) return false;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true;
  // api_key, private_key, x-api-key, session_key
  return (
    words.includes("key") && words.some((w) => w === "api" || w === "private" || w === "session")
  );
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
// Stripe secret, restricted and publishable keys, webhook secrets, and client secrets (pi_…_secret_…).
const STRIPE =
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+|\bwhsec_[A-Za-z0-9]+|\b[a-z]{2,6}_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g;
const SECRET_PARAM =
  /([?&;\s](?:token|code|secret|key|password|signature|sig|auth|session|otp|t)=)[^&;\s#"']+/gi;
// A long run of letters and digits mixing both (a random token), 20 characters or more.
const LONG_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;
// US and international phone numbers: +1 212 555 0123, (212) 555-0123, 212.555.0123, +442071234567.
const PHONE =
  /(?<![\w-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])|(?<![\w-])\+\d{10,15}(?![\w-])/g;
const CARDISH = /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TOKENISH = /(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{20,}/;

/** A long run that's only our ids (UUIDs) and short words between them is kept. */
function scrubLongToken(m: string): string {
  const rest = m.replace(UUID, "-");
  return rest.split("-").some((part) => TOKENISH.test(part)) || !m.match(UUID) ? "[token]" : m;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** One string with every phone number, email, card number and token in it replaced. */
export function scrubText(text: string): string {
  return (
    text
      .replace(BEARER, (_m, scheme: string) => `${scheme} [token]`)
      .replace(JWT, "[token]")
      .replace(STRIPE, "[token]")
      .replace(SECRET_PARAM, "$1[token]")
      .replace(EMAIL, "[email]")
      .replace(CARDISH, (m) => {
        const digits = m.replace(/[ -]/g, "");
        return luhn(digits) ? "[card]" : m;
      })
      .replace(PHONE, "[phone]")
      // UUIDs are our ids, not secrets; anything else long and random is.
      .replace(LONG_TOKEN, scrubLongToken)
  );
}

/**
 * A copy of any value with personal data stripped: strings scrubbed, sensitive keys replaced,
 * errors turned into { type, message, stack } scrubbed the same way. Cycles and depth are cut.
 */
export function scrubValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return "[deep]";
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      type: value.name,
      message: scrubText(value.message),
    };
    if (value.stack) out["stack"] = scrubText(value.stack);
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string") out["code"] = scrubText(code);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      isSensitiveKey(k) && v !== null && v !== undefined
        ? REDACTED
        : scrubValue(v, depth + 1, seen);
  }
  return out;
}

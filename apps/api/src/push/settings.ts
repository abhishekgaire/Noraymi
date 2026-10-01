import type { West4Env } from "../config.js";

/**
 * Web push (M1-22): the VAPID key pair that signs every push and the contact
 * address the push services may write to. Staging and production set them in
 * the environment; local development falls back to a fixed local-only pair so
 * subscriptions survive a restart (the keys below have no value anywhere else).
 */
export interface PushSettings {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

const LOCAL_PUBLIC_KEY =
  "BG3PnNQEC-d0pnC8nQQS9N9eOSWjN9s3NkV5cO3HZIdJiBl32EdMGKznggjKKKZJYfLJwXpUrLQb1iU7fQUT8yc";
const LOCAL_PRIVATE_KEY = "skLsLu-dt43PcmZxUDOaJLDjIDnZxmYM5ha7ca0TJCc";

export function loadPushSettings(
  env: West4Env,
  source: Record<string, string | undefined> = process.env,
): PushSettings {
  const publicKey = source["VAPID_PUBLIC_KEY"] ?? (env === "local" ? LOCAL_PUBLIC_KEY : undefined);
  const privateKey =
    source["VAPID_PRIVATE_KEY"] ?? (env === "local" ? LOCAL_PRIVATE_KEY : undefined);
  const subject =
    source["VAPID_SUBJECT"] ?? (env === "local" ? "mailto:dev@west4.local" : undefined);
  if (!publicKey || !privateKey || !subject) {
    throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set");
  }
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new Error("VAPID_SUBJECT must be a mailto: address or an https: URL");
  }
  return { publicKey, privateKey, subject };
}

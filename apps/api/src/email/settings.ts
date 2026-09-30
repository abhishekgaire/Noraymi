import type { West4Env } from "../config.js";
import { parseAllowList, type AllowList } from "./policy.js";

/**
 * Where email goes (M1-18). The adapter is provider-neutral: any transactional
 * provider hands out SMTP credentials, so the founder's pick is one URL in
 * SMTP_URL, and locally it points at the mail catcher in docker-compose.yml.
 */
export interface EmailSettings {
  readonly env: West4Env;
  /** smtp://user:pass@host:port, or smtps:// for implicit TLS. */
  readonly smtpUrl: string;
  /** The From header, for example `West 4 <no-reply@example.com>`. */
  readonly from: string;
  /**
   * Staging sends only to our own addresses. Null means no list: local
   * (everything lands in the catcher) and production (real staff addresses).
   * On staging an empty EMAIL_ALLOW_LIST is an empty list, so nothing sends.
   */
  readonly allowList: AllowList | null;
}

export function loadEmailSettings(
  env: West4Env,
  source: Record<string, string | undefined> = process.env,
): EmailSettings {
  const smtpUrl = source["SMTP_URL"] ?? (env === "local" ? "smtp://localhost:1025" : undefined);
  if (!smtpUrl) throw new Error("SMTP_URL is not set");
  const from =
    source["EMAIL_FROM"] ?? (env === "local" ? "West 4 <no-reply@west4.local>" : undefined);
  if (!from) throw new Error("EMAIL_FROM is not set");
  const rawList = source["EMAIL_ALLOW_LIST"];
  const allowList =
    env === "staging" ? parseAllowList(rawList ?? "") : rawList ? parseAllowList(rawList) : null;
  return { env, smtpUrl, from, allowList };
}

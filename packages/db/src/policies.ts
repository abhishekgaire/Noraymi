import { createHash } from "node:crypto";
import type { Queryable } from "./tenancy.js";

/**
 * Policy versions (M5-06; Data model · policy_versions): the exact words a
 * guest accepts, kept for good with their SHA-256. Publishing words that
 * match the newest version keeps it; different words make the next version.
 */
export interface PolicyVersion {
  readonly id: string;
  readonly version: number;
  readonly text: string;
  readonly hash: string;
  readonly published_at: string;
}

/** The kinds the guest-facing pages publish here; the tab and room-card consents publish their own. */
export type PolicyKind = "deposit" | "marketing_opt_in";

export const policyHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export async function currentPolicy(
  c: Queryable,
  venueId: string,
  kind: PolicyKind = "deposit",
): Promise<PolicyVersion | null> {
  return (
    (
      await c.query<PolicyVersion>(
        `select id, version, text, hash, published_at from policy_versions
          where venue_id = $1 and kind = $2 order by version desc limit 1`,
        [venueId, kind],
      )
    ).rows[0] ?? null
  );
}

export async function publishPolicy(
  c: Queryable,
  venueId: string,
  input: { text: string; at: string; by: string | null; kind?: PolicyKind },
): Promise<{ version: PolicyVersion; created: boolean }> {
  const kind = input.kind ?? "deposit";
  const current = await currentPolicy(c, venueId, kind);
  if (current && current.text === input.text) return { version: current, created: false };
  const r = await c.query<PolicyVersion>(
    `insert into policy_versions (venue_id, kind, version, text, hash, published_at, published_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id, version, text, hash, published_at`,
    [
      venueId,
      kind,
      (current?.version ?? 0) + 1,
      input.text,
      policyHash(input.text),
      input.at,
      input.by,
    ],
  );
  return { version: r.rows[0]!, created: true };
}

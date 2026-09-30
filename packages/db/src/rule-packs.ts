import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type { Temporal } from "@west4/shared";
import { canonicalJson, type RulePack } from "@west4/shared";
import type { Queryable } from "./tenancy.js";

/**
 * Signing and resolving rule packs (M1-10). Ed25519 over the canonical JSON;
 * the private key lives in the key service (a KMS-encrypted secret), the
 * public keys in rule_pack_signing_keys.
 */
export interface RulePackRow {
  readonly id: string;
  readonly version: string;
  readonly effective_on: string;
  readonly data: RulePack;
  readonly approved_by: string[];
  readonly signature: string;
  readonly key_id: string;
}

export function signRulePack(pack: RulePack, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(canonicalJson(pack), "utf8"), key).toString("base64");
}

export function verifyRulePack(pack: RulePack, signature: string, publicKeyPem: string): boolean {
  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return false;
  }
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(pack), "utf8"),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function generateSigningKey(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function publicKeyOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: "spki", format: "pem" })
    .toString();
}

/** A stable id for a public key: the first 16 hex chars of its SHA-256. */
export async function keyIdOf(publicKeyPem: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 16);
}

export interface ResolvedRulePack {
  readonly version: string;
  readonly effectiveOn: string;
  readonly pack: RulePack;
}

/**
 * The version in force for a business date: the newest version whose
 * signature checks against an active key, with at least two approvers, whose
 * effective_on is on or before the date. Run as app_rw; it only reads.
 */
export async function rulePackFor(
  client: Queryable,
  packId: string,
  businessDate: Temporal.PlainDate,
): Promise<ResolvedRulePack | null> {
  const rows = await client.query<RulePackRow & { public_key: string | null }>(
    `select p.id, p.version, p.effective_on::text, p.data, p.approved_by, p.signature, p.key_id, k.public_key
       from rule_packs p
       left join rule_pack_signing_keys k on k.key_id = p.key_id and k.retired_at is null
      where p.id = $1 and p.effective_on <= $2::date
      order by p.effective_on desc, p.version desc`,
    [packId, businessDate.toString()],
  );
  for (const row of rows.rows) {
    if (!usable(row)) continue;
    return { version: row.version, effectiveOn: row.effective_on, pack: row.data };
  }
  return null;
}

/** Every usable version, oldest first: the data behind Admin's notice of what changes and when. */
export async function rulePackVersions(
  client: Queryable,
  packId: string,
): Promise<ResolvedRulePack[]> {
  const rows = await client.query<RulePackRow & { public_key: string | null }>(
    `select p.id, p.version, p.effective_on::text, p.data, p.approved_by, p.signature, p.key_id, k.public_key
       from rule_packs p
       left join rule_pack_signing_keys k on k.key_id = p.key_id and k.retired_at is null
      where p.id = $1 order by p.effective_on, p.version`,
    [packId],
  );
  return rows.rows
    .filter(usable)
    .map((r) => ({ version: r.version, effectiveOn: r.effective_on, pack: r.data }));
}

function usable(row: RulePackRow & { public_key: string | null }): boolean {
  if (new Set(row.approved_by.filter((a) => a.trim() !== "")).size < 2) return false;
  if (row.public_key === null) return false;
  return verifyRulePack(row.data, row.signature, row.public_key);
}

/**
 * Publish a version: sign it and record the two approvers. Runs as the table
 * owner (the bootstrap script now, the Console in M1-36). Idempotent: an
 * existing (id, version) is left alone.
 */
export async function publishRulePack(
  client: Queryable,
  args: {
    pack: RulePack;
    effectiveOn: string;
    approvedBy: readonly string[];
    privateKeyPem: string;
  },
): Promise<{ inserted: boolean; keyId: string }> {
  const approvers = [...new Set(args.approvedBy.map((a) => a.trim()).filter((a) => a !== ""))];
  if (approvers.length < 2) throw new Error("a rule-pack version needs two named approvers");
  const publicKeyPem = publicKeyOf(args.privateKeyPem);
  const keyId = await keyIdOf(publicKeyPem);
  await client.query(
    "insert into rule_pack_signing_keys (key_id, public_key) values ($1, $2) on conflict (key_id) do nothing",
    [keyId, publicKeyPem],
  );
  const signature = signRulePack(args.pack, args.privateKeyPem);
  const r = await client.query(
    `insert into rule_packs (id, version, effective_on, data, approved_by, signature, key_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id, version) do nothing`,
    [
      args.pack.id,
      args.pack.version,
      args.effectiveOn,
      JSON.stringify(args.pack),
      approvers,
      signature,
      keyId,
    ],
  );
  return { inserted: r.rowCount === 1, keyId };
}

import type { RulePack } from "@west4/shared";
import { keyIdOf, publicKeyOf, signRulePack } from "./rule-packs.js";
import type { Queryable } from "./tenancy.js";

/**
 * Rule-pack drafts (M1-36, spec 12 · 11): a proposed version with its data
 * and effective date, approved by two different people in the Console, then
 * signed and published through the definer door. The same person approving
 * twice counts once; one approval never publishes.
 */
export interface DraftApproval {
  readonly staff_id: string;
  readonly name: string;
  readonly at: string;
}

export interface RulePackDraft {
  readonly id: string;
  readonly pack_id: string;
  readonly version: string;
  readonly effective_on: string;
  readonly data: RulePack;
  readonly created_by: string;
  readonly created_at: string;
  readonly approvals: DraftApproval[];
  readonly published_at: string | null;
}

const COLS =
  "id, pack_id, version, effective_on::text, data, created_by, created_at::text, approvals, published_at::text";

export async function createRulePackDraft(
  c: Queryable,
  input: { pack: RulePack; effectiveOn: string; createdBy: string },
): Promise<RulePackDraft> {
  const r = await c.query<RulePackDraft>(
    `insert into rule_pack_drafts (pack_id, version, effective_on, data, created_by)
       values ($1, $2, $3, $4, $5) returning ${COLS}`,
    [
      input.pack.id,
      input.pack.version,
      input.effectiveOn,
      JSON.stringify(input.pack),
      input.createdBy,
    ],
  );
  return r.rows[0]!;
}

export async function rulePackDrafts(c: Queryable, packId?: string): Promise<RulePackDraft[]> {
  const r = await c.query<RulePackDraft>(
    packId
      ? `select ${COLS} from rule_pack_drafts where pack_id = $1 order by created_at desc`
      : `select ${COLS} from rule_pack_drafts order by created_at desc`,
    packId ? [packId] : [],
  );
  return r.rows;
}

export async function rulePackDraft(c: Queryable, id: string): Promise<RulePackDraft | null> {
  const r = await c.query<RulePackDraft>(`select ${COLS} from rule_pack_drafts where id = $1`, [
    id,
  ]);
  return r.rows[0] ?? null;
}

/** Adds the person's approval once; a second click by the same person changes nothing. */
export async function approveRulePackDraft(
  c: Queryable,
  input: { id: string; staffId: string; name: string; at: string },
): Promise<RulePackDraft | null> {
  const approval: DraftApproval = { staff_id: input.staffId, name: input.name, at: input.at };
  const r = await c.query<RulePackDraft>(
    `update rule_pack_drafts
        set approvals = case
          when exists (select 1 from jsonb_array_elements(approvals) a where a->>'staff_id' = $2)
            then approvals
          else approvals || $3::jsonb end
      where id = $1 and published_at is null
      returning ${COLS}`,
    [input.id, input.staffId, JSON.stringify(approval)],
  );
  return r.rows[0] ?? null;
}

export const distinctApprovers = (draft: RulePackDraft): DraftApproval[] => {
  const seen = new Set<string>();
  return draft.approvals.filter((a) =>
    seen.has(a.staff_id) ? false : (seen.add(a.staff_id), true),
  );
};

/** Signs with the key service's key and publishes through the door. Refuses fewer than two approvers. */
export async function publishRulePackDraft(
  c: Queryable,
  input: { draft: RulePackDraft; privateKeyPem: string; at: string },
): Promise<{ inserted: boolean; keyId: string }> {
  const approvers = distinctApprovers(input.draft);
  if (approvers.length < 2) throw new Error("a rule-pack version needs two approvers");
  const publicKeyPem = publicKeyOf(input.privateKeyPem);
  const keyId = await keyIdOf(publicKeyPem);
  const signature = signRulePack(input.draft.data, input.privateKeyPem);
  const r = await c.query<{ inserted: boolean }>(
    `select publish_rule_pack_version($1, $2, $3::date, $4::jsonb, $5::text[], $6, $7, $8) as inserted`,
    [
      input.draft.pack_id,
      input.draft.version,
      input.draft.effective_on,
      JSON.stringify(input.draft.data),
      approvers.map((a) => a.name),
      signature,
      keyId,
      publicKeyPem,
    ],
  );
  await c.query(`update rule_pack_drafts set published_at = $2 where id = $1`, [
    input.draft.id,
    input.at,
  ]);
  return { inserted: r.rows[0]?.inserted ?? false, keyId };
}

/** Every pack id with at least one published version. */
export async function rulePackIds(c: Queryable): Promise<string[]> {
  const r = await c.query<{ id: string }>("select distinct id from rule_packs order by id");
  return r.rows.map((x) => x.id);
}

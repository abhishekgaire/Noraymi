/** One approval as the API returns it (M2-15). */
export interface Approval {
  readonly id: string;
  readonly kind: string;
  readonly amount_cents: number | null;
  readonly reason: string;
  readonly payload: { readonly description?: string };
  readonly requested_by: string;
  readonly requested_by_name: string;
  readonly requested_at: string;
  readonly routed_to: string;
  readonly routed_to_name: string;
  readonly status: "pending" | "approved" | "declined" | "expired";
  readonly decided_at: string | null;
}

export interface ApprovalLists {
  readonly waiting_for_me: readonly Approval[];
  readonly asked_by_me: readonly Approval[];
}

export const approvalKinds = [
  "comp",
  "void",
  "refund",
  "clock_pause",
  "tip_review",
  "paid_out",
  "party_size_down",
  "card_on_file",
  "over_hold",
] as const;

export function kindKey(kind: string) {
  const known = (approvalKinds as readonly string[]).includes(kind) ? kind : "comp";
  return `approvals.kind.${known as (typeof approvalKinds)[number]}` as const;
}

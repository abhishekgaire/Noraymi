/** One approval as the API returns it (M2-15). */
export interface Approval {
  readonly id: string;
  readonly kind: string;
  readonly amount_cents: number | null;
  readonly reason: string;
  readonly payload: {
    readonly description?: string;
    /** A tip from a paper slip (M6-09): why it needs approval, the venue's limits, and the slip's photo. */
    readonly reasons?: readonly ("over_pct" | "over_cents" | "late")[];
    readonly limits?: {
      readonly over_pct: number;
      readonly over_cents: number;
      readonly late_hours: number;
    };
    readonly photo_file_id?: string;
  };
  readonly requested_by: string;
  readonly requested_by_name: string;
  readonly requested_at: string;
  readonly routed_to: string;
  readonly routed_to_name: string;
  readonly status: "pending" | "approved" | "declined" | "expired";
  readonly decided_at: string | null;
  /** From a practice check (training mode, M7-03). */
  readonly training?: boolean;
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

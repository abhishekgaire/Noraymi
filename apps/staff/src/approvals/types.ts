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
  /** How it was decided (D124) and by whom. */
  readonly decided_with?: "phone" | "pin" | "none";
  readonly approver_name?: string | null;
  /** From a practice check (training mode, M7-03). */
  readonly training?: boolean;
}

export interface ApprovalLists {
  readonly waiting_for_me: readonly Approval[];
  readonly asked_by_me: readonly Approval[];
  /** How the venue decides approvals (D124), and who may type their PIN at the register. */
  readonly mode?: "phone" | "pin" | "none";
  readonly approvers?: readonly {
    readonly user_id: string;
    readonly name: string;
    /** On the clock now (U-08): the register's dialog picks this one first. */
    readonly on_clock?: boolean;
  }[];
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
  "discount",
  "tip_change",
  "tax_exempt",
  "missed_sale",
] as const;

export function kindKey(kind: string) {
  const known = (approvalKinds as readonly string[]).includes(kind) ? kind : "comp";
  return `approvals.kind.${known as (typeof approvalKinds)[number]}` as const;
}

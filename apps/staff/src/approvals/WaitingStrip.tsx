import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { PinApproval } from "./PinApproval.js";
import { kindKey, type Approval, type ApprovalLists } from "./types.js";

/**
 * The requester's side of an approval (M2-15; screens N18 · Requester): each
 * request this person asked for reads "Waiting for Andy" and then the
 * decision, while they keep working. A decision stays until it's dismissed.
 */
export function WaitingStrip({ venueId }: { venueId: string }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const [shown, setShown] = useState<readonly Approval[]>([]);
  // How the venue decides (D124): with "pin", a pending line offers Manager's PIN on this register.
  const [mode, setMode] = useState<ApprovalLists["mode"]>("phone");
  const [approvers, setApprovers] = useState<NonNullable<ApprovalLists["approvers"]>>([]);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const watching = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const r = await api<ApprovalLists>("GET", `/v1/venues/${venueId}/approvals`);
      for (const a of r.asked_by_me) if (a.status === "pending") watching.current.add(a.id);
      setShown(r.asked_by_me.filter((a) => watching.current.has(a.id)));
      setMode(r.mode ?? "phone");
      setApprovers(r.approvers ?? []);
    } catch {
      // The strip is a convenience; the screen keeps working without it.
    }
  }, [venueId]);

  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type.startsWith("approval."))) void load();
      }),
    [subscribe, load],
  );

  if (shown.length === 0) return null;
  return (
    <ul className="band waiting" aria-live="polite">
      {shown.map((a) => (
        <li key={a.id}>
          <span>{t(kindKey(a.kind))}</span>{" "}
          <span>
            {a.status === "pending"
              ? t("approvals.waitingFor", { name: a.routed_to_name })
              : a.status === "approved"
                ? t("approvals.approved", { name: a.approver_name ?? a.routed_to_name })
                : a.status === "declined"
                  ? t("approvals.declined", { name: a.approver_name ?? a.routed_to_name })
                  : t("approvals.expired")}
          </span>
          {a.status === "pending" && mode === "pin" && pinFor !== a.id && (
            <button type="button" className="secondary" onClick={() => setPinFor(a.id)}>
              {t("approvals.pin.button")}
            </button>
          )}
          {a.status === "pending" && mode === "pin" && pinFor === a.id && (
            <PinApproval
              venueId={venueId}
              approvalId={a.id}
              approvers={approvers}
              onDone={() => {
                setPinFor(null);
                void load();
              }}
            />
          )}
          {a.status !== "pending" && (
            <button
              type="button"
              className="link"
              onClick={() => {
                watching.current.delete(a.id);
                setShown((s) => s.filter((x) => x.id !== a.id));
              }}
            >
              {t("approvals.dismiss")}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

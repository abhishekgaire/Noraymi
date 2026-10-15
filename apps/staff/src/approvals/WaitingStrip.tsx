import { useCallback, useEffect, useRef, useState } from "react";
import { APPROVALS_CHANGED, api, askManagerPin } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { kindKey, type Approval, type ApprovalLists } from "./types.js";

/** How long a decided request stays on the strip before it clears itself (U-08). */
const DECIDED_CLEARS_MS = 8000;

/**
 * The requester's side of an approval (M2-15; screens N18 · Requester): each
 * request this person asked for reads "Waiting for Andy" and then the
 * decision, while they keep working. With approvals by a manager's PIN at the register (D124) it
 * reads "Needs a manager's PIN" and Manager's PIN opens the same dialog the action opened (U-08), so
 * no line names a phone that isn't used. A decision clears itself after a few seconds, or on Dismiss.
 */
export function WaitingStrip({ venueId }: { venueId: string }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const [shown, setShown] = useState<readonly Approval[]>([]);
  // How the venue decides (D124): with "pin", a pending line offers Manager's PIN on this register.
  const [mode, setMode] = useState<ApprovalLists["mode"]>("phone");
  const watching = useRef(new Set<string>());
  const clearing = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const load = useCallback(async () => {
    try {
      const r = await api<ApprovalLists>("GET", `/v1/venues/${venueId}/approvals`);
      for (const a of r.asked_by_me) if (a.status === "pending") watching.current.add(a.id);
      setShown(r.asked_by_me.filter((a) => watching.current.has(a.id)));
      setMode(r.mode ?? "phone");
    } catch {
      // The strip is a convenience; the screen keeps working without it.
    }
  }, [venueId]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    const again = () => void load();
    window.addEventListener(APPROVALS_CHANGED, again);
    return () => window.removeEventListener(APPROVALS_CHANGED, again);
  }, [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type.startsWith("approval."))) void load();
      }),
    [subscribe, load],
  );

  // Each decided request clears itself a few seconds after it shows here.
  useEffect(() => {
    for (const a of shown) {
      if (a.status === "pending" || clearing.current.has(a.id)) continue;
      clearing.current.set(
        a.id,
        setTimeout(() => {
          clearing.current.delete(a.id);
          watching.current.delete(a.id);
          setShown((s) => s.filter((x) => x.id !== a.id));
        }, DECIDED_CLEARS_MS),
      );
    }
  }, [shown]);
  useEffect(() => {
    const timers = clearing.current;
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, []);

  if (shown.length === 0) return null;
  return (
    <ul className="band waiting" aria-live="polite">
      {shown.map((a) => (
        <li key={a.id}>
          <span>{t(kindKey(a.kind))}</span>{" "}
          <span>
            {a.status === "pending"
              ? mode === "pin"
                ? t("approvals.pin.needs")
                : t("approvals.waitingFor", { name: a.routed_to_name })
              : a.status === "approved"
                ? t("approvals.approved", { name: a.approver_name ?? a.routed_to_name })
                : a.status === "declined"
                  ? t("approvals.declined", { name: a.approver_name ?? a.routed_to_name })
                  : t("approvals.expired")}
          </span>
          {a.status === "pending" && mode === "pin" && (
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void askManagerPin({ venueId, approvalId: a.id, routedTo: a.routed_to }).then(() =>
                  load(),
                )
              }
            >
              {t("approvals.pin.button")}
            </button>
          )}
          {a.status !== "pending" && (
            <button
              type="button"
              className="link"
              onClick={() => {
                watching.current.delete(a.id);
                clearTimeout(clearing.current.get(a.id));
                clearing.current.delete(a.id);
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

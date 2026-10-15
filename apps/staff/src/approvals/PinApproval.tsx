import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MessageKey } from "@west4/shared";
import {
  ApiCallError,
  NetworkError,
  api,
  setManagerPinPrompt,
  type ManagerPinAsk,
  type ManagerPinOutcome,
} from "../api.js";
import { useT } from "../i18n.js";
import { Dialog, useSheetDialog } from "../layout/Dialog.js";
import { kindKey, type Approval, type ApprovalLists } from "./types.js";

/**
 * Manager's PIN at the register (F-04; D124; U-08; screens N18): with approvals decided this way, the
 * action that needs one opens this dialog right where it was asked, in the same look as Your PIN
 * again: "Needs a manager's PIN", the manager on the clock picked (else the first), their PIN,
 * Approve. An owner or a manager other than the requester approves or declines; the server checks the
 * PIN with the sign-in's lockouts on this device, decides and audits it. Later closes it, and the
 * waiting strip keeps offering it. Mounted once, for every screen (App.tsx).
 */
interface Asking extends ManagerPinAsk {
  readonly answer: (outcome: ManagerPinOutcome) => void;
}

export function ManagerPinDialog() {
  const [asking, setAsking] = useState<Asking | null>(null);
  useEffect(() => {
    setManagerPinPrompt(
      (ask) =>
        new Promise<ManagerPinOutcome>((resolve) =>
          setAsking({
            ...ask,
            answer: (outcome) => {
              setAsking(null);
              resolve(outcome);
            },
          }),
        ),
    );
    return () => setManagerPinPrompt(null);
  }, []);
  if (!asking) return null;
  return (
    <Dialog onTop onClose={() => asking.answer(null)}>
      <PinApprovalSheet key={asking.approvalId} asking={asking} />
    </Dialog>
  );
}

type Approvers = NonNullable<ApprovalLists["approvers"]>;

/** Who is picked first: the one it was routed to if they're on the clock, else anyone on it, else the first. */
export function firstApprover(approvers: Approvers, routedTo: string | null): string {
  const onClock = approvers.filter((a) => a.on_clock);
  return (
    onClock.find((a) => a.user_id === routedTo)?.user_id ??
    onClock[0]?.user_id ??
    approvers[0]?.user_id ??
    ""
  );
}

/** A refusal in the staff's words, never the server's text (U-08). */
function problemKey(err: unknown): MessageKey {
  if (err instanceof NetworkError) return "approvals.pin.offline";
  if (err instanceof ApiCallError) {
    if (err.code === "unauthorized") return "pinAgain.wrong";
    if (err.code === "rate_limited") return "pinAgain.locked";
    if (err.code === "forbidden") return "approvals.pin.notAllowed";
  }
  return "approvals.failed";
}

function PinApprovalSheet({ asking }: { asking: Asking }) {
  const { t, money } = useT();
  const sheet = useSheetDialog(t("approvals.pin.title"));
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [approvers, setApprovers] = useState<Approvers>([]);
  const [what, setWhat] = useState<Approval | null>(null);
  const [who, setWho] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  const load = async () => {
    setState("loading");
    try {
      const r = await api<ApprovalLists>("GET", `/v1/venues/${asking.venueId}/approvals`);
      const list = r.approvers ?? [];
      setApprovers(list);
      setWhat(r.asked_by_me.find((a) => a.id === asking.approvalId) ?? null);
      setWho(firstApprover(list, asking.routedTo));
      setState("ready");
    } catch {
      setState("failed");
    }
  };
  useEffect(() => {
    // Loaded once per request asked for (the sheet is keyed by it).
    void load();
  }, []);
  useEffect(() => {
    if (state === "ready") input.current?.focus();
  }, [state]);

  const outcomeOf = (a: Approval): ManagerPinOutcome => {
    const name = a.approver_name ?? a.routed_to_name;
    if (a.status === "approved")
      return { status: "approved", message: t("approvals.approved", { name }) };
    if (a.status === "declined")
      return { status: "declined", message: t("approvals.declined", { name }) };
    if (a.status === "expired") return { status: "expired", message: t("approvals.expired") };
    return null;
  };

  const send = async (decision: "approve" | "decline", e?: FormEvent) => {
    e?.preventDefault();
    if (!who || !/^\d{4,8}$/.test(pin)) {
      setProblem("approvals.pin.needed");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const r = await api<{ approval: Approval }>(
        "POST",
        `/v1/venues/${asking.venueId}/approvals/${asking.approvalId}/pin`,
        { user_id: who, pin, decision },
      );
      asking.answer(outcomeOf(r.approval));
    } catch (err) {
      setPin("");
      // Decided meanwhile (on the approver's phone): say what was decided.
      if (err instanceof ApiCallError && err.code === "version_conflict") {
        try {
          const { approval } = await api<{ approval: Approval }>(
            "GET",
            `/v1/venues/${asking.venueId}/approvals/${asking.approvalId}`,
          );
          const outcome = outcomeOf(approval);
          if (outcome) return asking.answer(outcome);
        } catch {
          // Falls through to the words below.
        }
      }
      setProblem(problemKey(err));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="sheet pin-again pin-approval"
      {...sheet.root}
      onSubmit={(e) => void send("approve", e)}
    >
      <h2 {...sheet.title}>{t("approvals.pin.title")}</h2>
      {what && (
        <p className="small">
          {t(kindKey(what.kind))}
          {what.payload.description ? ` · ${what.payload.description}` : ""}
          {what.amount_cents !== null ? ` · ${money(what.amount_cents as never)}` : ""}
        </p>
      )}
      {state === "loading" && (
        <p className="small muted" role="status">
          {t("shell.loading")}
        </p>
      )}
      {state === "failed" && (
        <p className="error small" role="alert">
          {t("approvals.pin.loadFailed")}{" "}
          <button type="button" className="link" onClick={() => void load()}>
            {t("approvals.pin.retry")}
          </button>
        </p>
      )}
      {state === "ready" && approvers.length === 0 && (
        <p className="small muted" role="status">
          {t("approvals.pin.nobody")}
        </p>
      )}
      {state === "ready" && approvers.length > 0 && (
        <>
          <fieldset>
            <legend>{t("approvals.pin.who")}</legend>
            {approvers.map((a) => (
              <label key={a.user_id} className="check">
                <input
                  type="radio"
                  name={`pin-approver-${asking.approvalId}`}
                  checked={who === a.user_id}
                  onChange={() => {
                    setWho(a.user_id);
                    input.current?.focus();
                  }}
                />{" "}
                {a.name}
              </label>
            ))}
          </fieldset>
          <label>
            <span>{t("approvals.pin.pin")}</span>
            <input
              ref={input}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              value={pin}
              onChange={(e) => {
                setProblem(null);
                setPin(e.target.value.replace(/\D/g, ""));
              }}
            />
          </label>
        </>
      )}
      {problem && (
        <p className="error small" role="alert">
          {t(problem)}
        </p>
      )}
      <div className="actions">
        {state === "ready" && approvers.length > 0 && (
          <>
            <button type="submit" className="primary" disabled={busy}>
              {t("approvals.approve")}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void send("decline")}
            >
              {t("approvals.decline")}
            </button>
          </>
        )}
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => asking.answer(null)}
        >
          {t("approvals.pin.later")}
        </button>
      </div>
    </form>
  );
}

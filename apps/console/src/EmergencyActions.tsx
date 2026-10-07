import { useCallback, useEffect, useState, type FormEvent } from "react";
import { EMERGENCY_ACTIONS, EMERGENCY_APPROVAL_MINUTES, NIGHT_FIXES } from "@west4/shared";
import { api } from "./api.js";

/**
 * Emergency actions in the Console (M8-11; spec 02 · Support access; spec 13 ·
 * On call; screens · Console). Four actions and nothing else. One of us asks
 * with a target and a reason; the venue's owner is told at once; a second
 * person on our side approves it here, in their own session, within
 * EMERGENCY_APPROVAL_MINUTES, and it runs then. The one who asked sees
 * Withdraw, never Approve.
 */
interface Emergency {
  id: string;
  action: string;
  target: string;
  reason: string;
  requested_by: string;
  requested_by_name: string | null;
  decided_by_name: string | null;
  state: "requested" | "expired" | "declined" | "withdrawn" | "approved" | "done" | "failed";
  result: Record<string, unknown> | null;
}
interface Fix {
  kind: string;
  id: string;
  reason: string;
}

const ACTION_NAMES: Record<string, string> = {
  resync_payment: "Re-sync a payment",
  cancel_reader_action: "Cancel a reader action",
  requeue_print: "Requeue a print",
  close_night: "Close a stuck night",
};
const TARGET_LABEL: Record<string, string> = {
  resync_payment: "Payment id",
  cancel_reader_action: "Reader id",
  requeue_print: "Print job id",
  close_night: "Night (YYYY-MM-DD)",
};
const FIX_NAMES: Record<string, string> = {
  clock_out_shift: "Clock out a shift left open",
  clear_draft: "Clear a stale draft",
  expire_approval: "Expire an approval whose target is gone",
};
const STATE_NAMES: Record<Emergency["state"], string> = {
  requested: "Waiting for a second approver",
  expired: "Expired",
  declined: "Declined",
  withdrawn: "Withdrawn",
  approved: "Running",
  done: "Done",
  failed: "Didn't finish",
};

export function EmergencyActions({
  venue,
  staffId,
}: {
  venue: { id: string; name: string };
  staffId: string;
}) {
  const [rows, setRows] = useState<Emergency[] | null>(null);
  const [action, setAction] = useState<string>(EMERGENCY_ACTIONS[0]);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [fixes, setFixes] = useState<Fix[]>([]);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/v1/console/venues/${venue.id}/emergency-actions`;

  const load = useCallback(async () => {
    const r = await api<{ emergency_actions: Emergency[] }>("GET", base);
    setRows(r.emergency_actions);
  }, [base]);

  useEffect(() => {
    load().catch((e: Error) => setMessage({ kind: "error", text: e.message }));
    const timer = setInterval(() => void load().catch(() => {}), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (work: () => Promise<unknown>, ok: string | null) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      if (ok) setMessage({ kind: "ok", text: ok });
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const ask = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api("POST", base, {
        action,
        target: target.trim(),
        reason: reason.trim(),
        ...(action === "close_night" ? { fixes } : {}),
      });
      setTarget("");
      setReason("");
      setFixes([]);
    }, `Asked. ${venue.name}'s owner has been told. A second person on our team approves it.`);
  };

  const answer = (row: Emergency, verb: "approve" | "decline" | "withdraw") =>
    void run(
      () => api("POST", `${base}/${row.id}/${verb}`, {}),
      verb === "approve" ? "Approved. It ran; the outcome is below." : null,
    );

  return (
    <section className="panel" aria-labelledby="emergency-h">
      <h3 id="emergency-h">Emergency actions</h3>
      <p className="muted">
        Each needs a reason and a second approver on our side within {EMERGENCY_APPROVAL_MINUTES}{" "}
        minutes, and tells the owner at once.
      </p>
      {message && (
        <p className={message.kind === "error" ? "error" : "ok"} role="status">
          {message.text}
        </p>
      )}
      <form className="grant-form" onSubmit={ask} aria-label="Ask for an emergency action">
        <label>
          <span>Action</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            {EMERGENCY_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_NAMES[a]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{TARGET_LABEL[action]}</span>
          <input value={target} required onChange={(e) => setTarget(e.target.value)} />
        </label>
        <label>
          <span>Why</span>
          <input
            value={reason}
            required
            minLength={3}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {action === "close_night" && (
          <fieldset>
            <legend>Stale items to fix first (an open tab, room or uncounted drawer never)</legend>
            {fixes.map((f, i) => (
              <div key={i} className="fix-row">
                <select
                  aria-label="Fix"
                  value={f.kind}
                  onChange={(e) =>
                    setFixes(fixes.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))
                  }
                >
                  {NIGHT_FIXES.map((k) => (
                    <option key={k} value={k}>
                      {FIX_NAMES[k]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Item id"
                  value={f.id}
                  onChange={(e) =>
                    setFixes(fixes.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))
                  }
                />
                <input
                  aria-label="Reason for this fix"
                  value={f.reason}
                  onChange={(e) =>
                    setFixes(fixes.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))
                  }
                />
              </div>
            ))}
            <button
              type="button"
              className="secondary"
              onClick={() => setFixes([...fixes, { kind: NIGHT_FIXES[0], id: "", reason: "" }])}
            >
              Add a fix
            </button>
          </fieldset>
        )}
        <button type="submit" disabled={busy}>
          Ask for a second approver
        </button>
      </form>
      {rows === null ? (
        <p role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No emergency actions at {venue.name}.</p>
      ) : (
        <ul className="grant-history" aria-label="Emergency actions">
          {rows.map((row) => (
            <li key={row.id}>
              <strong>{ACTION_NAMES[row.action] ?? row.action}</strong> · {STATE_NAMES[row.state]} ·
              asked by {row.requested_by_name ?? "?"}
              {row.decided_by_name ? ` · ${row.decided_by_name}` : ""} · {row.reason}
              {row.state === "failed" && row.result?.["message"] ? (
                <span className="error"> · {String(row.result["message"])}</span>
              ) : null}
              {row.state === "requested" &&
                (row.requested_by === staffId ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => answer(row, "withdraw")}
                  >
                    Withdraw
                  </button>
                ) : (
                  <>
                    <button type="button" disabled={busy} onClick={() => answer(row, "approve")}>
                      Approve and run
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => answer(row, "decline")}
                    >
                      Decline
                    </button>
                  </>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

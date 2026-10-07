import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SUPPORT_ACTIONS, SUPPORT_GRANT_MAX_MINUTES } from "@west4/shared";
import { api } from "./api.js";

/**
 * Support access in the Console (M8-10; spec 02 · Support access; screens ·
 * Console notes 2 and 3). Our staff member asks with a reason, a scope (read,
 * or write for one named action) and a length up to 60 minutes; the request
 * waits for the venue's owner, who approves in Admin → Console. While it's
 * open: the time left, [End now], and the masked support view (guest phone
 * numbers masked, no ID scans). A write grant's one action runs once.
 */
interface Grant {
  id: string;
  staff_name: string | null;
  reason: string;
  scope: "read" | "write";
  action: string | null;
  minutes: number;
  state: "waiting" | "open" | "ended" | "declined" | "revoked";
  seconds_left: number | null;
  action_used_at: string | null;
}
interface SupportView {
  guests: { id: string; name: string; phone_masked: string | null; has_email: boolean }[];
  checks: { id: string; number: string; kind: string; status: string; business_date: string }[];
  print_jobs: {
    id: string;
    kind: string;
    station: string;
    status: string;
    reprint_n: number;
    failed_at: string | null;
  }[];
}

const ACTION_NAMES: Record<string, string> = { requeue_print: "Requeue a print" };
const STATE_NAMES: Record<Grant["state"], string> = {
  waiting: "Waiting",
  open: "Open",
  ended: "Ended",
  declined: "Declined",
  revoked: "Ended early",
};

const timeLeft = (seconds: number | null) => {
  const s = Math.max(0, seconds ?? 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
};

export function SupportAccess({ venue }: { venue: { id: string; name: string } }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [action, setAction] = useState<string>(SUPPORT_ACTIONS[0]);
  const [minutes, setMinutes] = useState(30);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<SupportView | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ support_grants: Grant[] }>(
      "GET",
      `/v1/console/venues/${venue.id}/support-grants`,
    );
    setGrants(r.support_grants);
  }, [venue.id]);

  useEffect(() => {
    load().catch((e: Error) => setMessage({ kind: "error", text: e.message }));
    const timer = setInterval(() => void load().catch(() => {}), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const open = grants?.find((g) => g.state === "open") ?? null;
  const waiting = grants?.find((g) => g.state === "waiting") ?? null;
  const openId = open?.id ?? null;

  useEffect(() => {
    if (!openId) {
      setView(null);
      return;
    }
    api<SupportView>("GET", `/v1/venues/${venue.id}/support/view`, undefined, {
      "x-support-grant": openId,
    })
      .then(setView)
      .catch((e: Error) => setMessage({ kind: "error", text: e.message }));
  }, [openId, venue.id]);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api("POST", `/v1/console/venues/${venue.id}/support-grants`, {
        reason: reason.trim(),
        scope,
        ...(scope === "write" ? { action } : {}),
        minutes,
      });
      setReason("");
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const end = async (g: Grant) => {
    setBusy(true);
    try {
      await api("POST", `/v1/console/venues/${venue.id}/support-grants/${g.id}/end`, {});
      await load();
    } finally {
      setBusy(false);
    }
  };

  const requeue = async (g: Grant, jobId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await api(
        "POST",
        `/v1/venues/${venue.id}/support/actions/requeue_print`,
        { job_id: jobId },
        { "x-support-grant": g.id },
      );
      setMessage({ kind: "ok", text: "Print requeued. The action is used." });
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="support-access-h">
      <h3 id="support-access-h">Support access</h3>
      {message && (
        <p className={message.kind === "error" ? "error" : "ok"} role="status">
          {message.text}
        </p>
      )}
      {grants === null ? (
        <p role="status">Loading…</p>
      ) : open ? (
        <div className="grant-open">
          <p>
            <strong>Open</strong> · {timeLeft(open.seconds_left)} ·{" "}
            {open.scope === "read"
              ? "Read only"
              : `Read only, plus once: ${ACTION_NAMES[open.action ?? ""] ?? open.action}${open.action_used_at ? " (used)" : ""}`}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void end(open)}
          >
            End now
          </button>
          {view && (
            <>
              <h4>Guests (masked)</h4>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Phone</th>
                    <th>Email</th>
                  </tr>
                </thead>
                <tbody>
                  {view.guests.map((g) => (
                    <tr key={g.id}>
                      <td>{g.name}</td>
                      <td>{g.phone_masked ?? "—"}</td>
                      <td>{g.has_email ? "on file (hidden)" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4>Print jobs</h4>
              <table>
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Station</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {view.print_jobs.map((j) => (
                    <tr key={j.id}>
                      <td>{j.kind}</td>
                      <td>{j.station}</td>
                      <td>{j.status}</td>
                      <td>
                        {open.scope === "write" &&
                          open.action === "requeue_print" &&
                          !open.action_used_at && (
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              onClick={() => void requeue(open, j.id)}
                            >
                              Requeue
                            </button>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      ) : waiting ? (
        <div className="grant-waiting">
          <p role="status">Waiting for {venue.name} to approve</p>
          <p className="muted">{waiting.reason}</p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void end(waiting)}
          >
            Withdraw
          </button>
        </div>
      ) : (
        <form className="grant-form" onSubmit={(e) => void ask(e)}>
          <label>
            <span>Reason</span>
            <input
              value={reason}
              required
              minLength={3}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label>
            <span>Scope</span>
            <select value={scope} onChange={(e) => setScope(e.target.value as "read" | "write")}>
              <option value="read">Read</option>
              <option value="write">Write, one named action</option>
            </select>
          </label>
          {scope === "write" && (
            <label>
              <span>Action</span>
              <select value={action} onChange={(e) => setAction(e.target.value)}>
                {SUPPORT_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {ACTION_NAMES[a] ?? a}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>Minutes (up to {SUPPORT_GRANT_MAX_MINUTES})</span>
            <input
              type="number"
              min={1}
              max={SUPPORT_GRANT_MAX_MINUTES}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </label>
          <button type="submit" disabled={busy}>
            Request access
          </button>
        </form>
      )}
      {grants && grants.length > 0 && (
        <ul className="grant-history">
          {grants.slice(0, 5).map((g) => (
            <li key={g.id}>
              {STATE_NAMES[g.state]} · {g.scope} · {g.minutes} min · {g.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

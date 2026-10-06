import { useCallback, useEffect, useState } from "react";
import { api, ApiCallError } from "../api.js";
import { kindKey, type Approval, type ApprovalLists } from "../approvals/types.js";
import { readDevice, signedApi } from "../device.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * N18 Approvals inbox (M2-15; spec 02 · Approvals): on a manager's or owner's
 * own phone, "Approvals · N" with each request's line, amount, reason, who
 * asked and when, and [Approve] and [Decline]. The decision is signed with
 * this phone's own device key; the API refuses it from any other device, in
 * a PIN session, or from the person who asked.
 */
export function Approvals() {
  const { t, money, time } = useT();
  const { state } = useSession();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [list, setList] = useState<readonly Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const r = await api<ApprovalLists>("GET", `/v1/venues/${venueId}/approvals?status=pending`);
      setList(r.waiting_for_me);
      setError(null);
    } catch {
      setError(t("approvals.failed"));
    }
  }, [venueId, t]);

  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type.startsWith("approval."))) void load();
      }),
    [subscribe, load],
  );

  const decide = async (id: string, decision: "approve" | "decline") => {
    setBusy(id);
    try {
      const device = await readDevice();
      if (!device || device.kind !== "staff_phone") {
        setError(t("approvals.ownPhone"));
        return;
      }
      await signedApi(device, "POST", `/v1/venues/${venueId}/approvals/${id}/decide`, {
        decision,
      });
      await load();
    } catch (e) {
      setError(
        e instanceof ApiCallError && e.code === "forbidden"
          ? t("approvals.ownPhone")
          : t("approvals.failed"),
      );
    } finally {
      setBusy(null);
    }
  };

  // A slip's tip (M6-09): its reasons in this phone's language, from the venue's own limits.
  const reasonOf = (a: Approval) => {
    const { reasons, limits } = a.payload;
    if (a.kind !== "tip_review" || !reasons || !limits) return a.reason;
    return reasons
      .map((r) =>
        r === "over_pct"
          ? t("approvals.tipReason.over_pct", { pct: limits.over_pct })
          : r === "over_cents"
            ? t("approvals.tipReason.over_cents", { amount: money(limits.over_cents as never) })
            : t("approvals.tipReason.late", { hours: limits.late_hours }),
      )
      .join(" · ");
  };
  const seeSlip = async (fileId: string) => {
    try {
      const r = await api<{ url: string }>("GET", `/v1/venues/${venueId}/files/${fileId}`);
      window.open(r.url, "_blank", "noopener");
    } catch {
      setError(t("approvals.failed"));
    }
  };

  if (list === null && !error)
    return (
      <section className="screen">
        <p role="status">{t("shell.loading")}</p>
      </section>
    );

  return (
    <section className="screen approvals">
      <h1>{t("approvals.title", { count: list?.length ?? 0 })}</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {list?.length === 0 && <p className="muted">{t("approvals.none")}</p>}
      <ul className="cards">
        {list?.map((a) => (
          <li key={a.id} className="card">
            <div className="row">
              <strong>
                {t(kindKey(a.kind))}
                {a.payload.description ? ` · ${a.payload.description}` : ""}
              </strong>
              {a.amount_cents !== null && <span>{money(a.amount_cents as never)}</span>}
            </div>
            <p>{t("approvals.reason", { reason: reasonOf(a) })}</p>
            {a.payload.photo_file_id && (
              <button
                type="button"
                className="link"
                onClick={() => void seeSlip(a.payload.photo_file_id!)}
              >
                {t("approvals.seeSlip")}
              </button>
            )}
            <p className="muted">
              {t("approvals.asked", {
                name: a.requested_by_name,
                time: time(a.requested_at, timeZone),
              })}
            </p>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={busy === a.id}
                onClick={() => void decide(a.id, "approve")}
              >
                {t("approvals.approve")}
              </button>
              <button
                type="button"
                disabled={busy === a.id}
                onClick={() => void decide(a.id, "decline")}
              >
                {t("approvals.decline")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

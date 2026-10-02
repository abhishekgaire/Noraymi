import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Payments · Disputes (M4-24; screens N37): each dispute with its
 * deadline, the evidence already gathered (the receipt, the room clock, the
 * booking's accepted policy, damage photos, who served), a note, and Submit.
 * Owners and managers, in a passkey session.
 */
interface Dispute {
  readonly id: string;
  readonly reason: string;
  readonly amount_cents: number;
  readonly status: string;
  readonly due_by: string | null;
  readonly submitted_at: string | null;
  readonly outcome: "won" | "lost" | null;
  readonly withdrawn_cents: number;
  readonly reinstated_cents: number;
  readonly evidence: {
    readonly receipt: { readonly number: string } | null;
    readonly clock: readonly string[];
    readonly policy: { readonly version_id: string } | null;
    readonly damage_photos: readonly string[];
    readonly served: readonly string[];
    readonly note: string | null;
  };
}

export function Disputes({ venueId }: { venueId: string }) {
  const { t, money, date } = useT();
  const [list, setList] = useState<readonly Dispute[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(
        (await api<{ disputes: Dispute[] }>("GET", `/v1/venues/${venueId}/disputes`)).disputes,
      );
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (d: Dispute) => {
    setBusy(d.id);
    try {
      const note = (notes[d.id] ?? "").trim();
      if (note)
        await api(
          "POST",
          `/v1/venues/${venueId}/disputes/${d.id}/evidence`,
          { note },
          {
            idempotencyKey: `note-${d.id}-${Date.now()}`,
          },
        );
      await api("POST", `/v1/venues/${venueId}/disputes/${d.id}/submit`, undefined, {
        idempotencyKey: `submit-${d.id}`,
      });
      await load();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="disputes" aria-labelledby="disputes-h">
      <h2 id="disputes-h">{t("disputes.title")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("disputes.failed")}
        </p>
      )}
      {list === null && !failed && <p role="status">{t("shell.loading")}</p>}
      {list?.length === 0 && <p>{t("disputes.none")}</p>}
      <ul>
        {list?.map((d) => (
          <li
            key={d.id}
            aria-label={t("disputes.item", { amount: money(d.amount_cents as never) })}
          >
            <h3>
              {t("disputes.item", { amount: money(d.amount_cents as never) })} · {d.reason}
            </h3>
            <p className="small">
              {d.outcome
                ? t(d.outcome === "won" ? "disputes.won" : "disputes.lost")
                : d.submitted_at
                  ? t("disputes.submitted", { date: date(d.submitted_at) })
                  : d.due_by
                    ? t("disputes.due", { date: date(d.due_by) })
                    : d.status}
            </p>
            <ul className="evidence">
              {d.evidence.receipt && (
                <li>{t("disputes.receipt", { number: d.evidence.receipt.number })}</li>
              )}
              {d.evidence.clock.length > 0 && (
                <li>{t("disputes.clock", { n: d.evidence.clock.length })}</li>
              )}
              <li>{d.evidence.policy ? t("disputes.policy") : t("disputes.noPolicy")}</li>
              {d.evidence.damage_photos.length > 0 && (
                <li>{t("disputes.photos", { n: d.evidence.damage_photos.length })}</li>
              )}
              {d.evidence.served.length > 0 && (
                <li>{t("disputes.served", { n: d.evidence.served.length })}</li>
              )}
            </ul>
            {(d.withdrawn_cents > 0 || d.reinstated_cents > 0) && (
              <p className="small">
                {t("disputes.funds", {
                  out: money(d.withdrawn_cents as never),
                  back: money(d.reinstated_cents as never),
                })}
              </p>
            )}
            {!d.submitted_at && !d.outcome && (
              <>
                <label>
                  <span>{t("disputes.note")}</span>
                  <textarea
                    value={notes[d.id] ?? d.evidence.note ?? ""}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [d.id]: e.target.value }))}
                  />
                </label>
                <button
                  type="button"
                  className="primary"
                  disabled={busy === d.id}
                  onClick={() => void submit(d)}
                >
                  {t("disputes.submit")}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Admin → Disputes (M4-24): owners and managers. */
export function DisputesScreen() {
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  return venueId ? <Disputes venueId={venueId} /> : null;
}

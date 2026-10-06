import { useCallback, useEffect, useState } from "react";
import { api, ApiCallError } from "../api.js";
import { useVenueTime } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * Close the night, its open bar tabs (M6-16; Staff screens and the bar POS · Charging the remaining tabs;
 * screens Night note 5). M7 builds the rest of the screen. The open bar tabs with their totals and cards;
 * guests still at the bar close on the reader. "Charge the remaining tabs" (owners and managers) asks once,
 * with how many cards and the total, then charges each tab not waiting on an approval at its balance with
 * no tip. A tab waiting on an approval is skipped until it's decided; the tab cut-off catches anything left.
 */
interface NightTab {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly card: { readonly brand: string; readonly last4: string } | null;
  readonly total_cents: number;
  readonly rest_cents: number;
  readonly waiting_for: string | null;
  readonly chargeable: boolean;
}
interface Night {
  readonly business_date: string;
  readonly bar_tabs: readonly NightTab[];
  readonly charge_remaining: { readonly count: number; readonly total_cents: number };
  readonly tab_cut_off_at: string | null;
}

export function CloseTheNight() {
  const { t, money, time } = useT();
  const { state } = useSession();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const venueTime = useVenueTime(timeZone, signedIn?.membership.venue.day_cutover ?? "06:00");
  const date = venueTime?.businessDate.toString() ?? null;
  const [night, setNight] = useState<Night | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!venueId || !date) return;
    try {
      setNight(await api<Night>("GET", `/v1/venues/${venueId}/nights/${date}`));
      setError(null);
    } catch {
      setError(t("night.failed"));
    }
  }, [venueId, date, t]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some((e) => e.type.startsWith("tab.") || e.type.startsWith("approval."))
        )
          void load();
      }),
    [subscribe, load],
  );

  const charge = async () => {
    if (!night || !date) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ tabs: { started: boolean }[] }>(
        "POST",
        `/v1/venues/${venueId}/nights/${date}/charge-remaining-tabs`,
        night.charge_remaining,
        { idempotencyKey: `charge-remaining-${date}-${Date.now()}` },
      );
      setDone(
        t("night.charged", {
          count: r.tabs.filter((x) => x.started).length,
          total: money(night.charge_remaining.total_cents as never),
        }),
      );
    } catch (e) {
      // The open tabs changed since the confirmation: nothing was charged; show them again.
      setError(
        e instanceof ApiCallError && e.code === "version_conflict"
          ? t("night.changed")
          : t("night.chargeFailed"),
      );
    } finally {
      setConfirming(false);
      setBusy(false);
      void load();
    }
  };

  if (night === null && !error)
    return (
      <section className="screen">
        <p role="status">{t("shell.loading")}</p>
      </section>
    );

  const remaining = night?.charge_remaining ?? { count: 0, total_cents: 0 };
  return (
    <section className="screen close-night" aria-labelledby="night-title">
      <h1 id="night-title">{t("menu.closeNight")}</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="notice">
          {done}
        </p>
      )}
      <section className="card" aria-labelledby="night-tabs">
        <h2 id="night-tabs">{t("night.barTabs")}</h2>
        {night?.tab_cut_off_at && (
          <p className="small">
            {t("night.cutOffAt", { time: time(night.tab_cut_off_at, timeZone) })}
          </p>
        )}
        {night?.bar_tabs.length === 0 ? (
          <p className="muted">{t("night.noTabs")}</p>
        ) : (
          <ul className="night-tabs">
            {night?.bar_tabs.map((tab) => (
              <li key={tab.id} className="row night-tab">
                <span>
                  <strong data-guest-text>{tab.name}</strong>
                  {tab.card && (
                    <span className="small" data-guest-text>
                      {` · ${tab.card.brand} ··${tab.card.last4}`}
                    </span>
                  )}
                </span>
                <span>{money(tab.total_cents as never)}</span>
                {tab.waiting_for ? (
                  <span className="badge-text">
                    {t("rail.badge.waiting", { name: tab.waiting_for })}
                    {" · "}
                    {t("night.skipped")}
                  </span>
                ) : tab.state === "tipping" ? (
                  <span className="badge-text">{t("night.tipping")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {confirming ? (
          <div className="confirm" role="group" aria-labelledby="night-confirm">
            <p id="night-confirm">
              <strong>{t("night.chargeRemaining")}</strong>
            </p>
            <p>{t("night.cards", { count: remaining.count })}</p>
            <p>{t("night.inAll", { total: money(remaining.total_cents as never) })}</p>
            <p className="small">{t("night.noTip")}</p>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void charge()}
              >
                {busy ? t("night.charging") : t("night.chargeThem")}
              </button>
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                {t("night.back")}
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={remaining.count === 0}
              onClick={() => {
                setDone(null);
                setConfirming(true);
              }}
            >
              {t("night.chargeRemaining")}
            </button>
          </div>
        )}
      </section>
    </section>
  );
}

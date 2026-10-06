import { useCallback, useEffect, useState } from "react";
import { api, ApiCallError } from "../api.js";
import { useVenueTime } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import { CashPanel } from "./CashPanel.js";
import { DrawerPanel } from "./DrawerPanel.js";
import { NightChecks, type Check } from "./NightChecks.js";
import { ReportPanel } from "./ReportPanel.js";
import { UnmatchedPayments } from "./UnmatchedPayments.js";
import { TipsPanel } from "./TipsPanel.js";
import { TapPayment } from "./TapPayment.js";

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
/** A tab whose capture failed (M6-17; screens Night note 12): on this list until a manager settles it. */
interface FailedTab {
  readonly id: string;
  readonly name: string;
  readonly check_id: string;
  readonly card: { readonly brand: string; readonly last4: string } | null;
  readonly business_date: string;
  readonly owed_cents: number;
  readonly saved_card: boolean;
}
interface Night {
  readonly business_date: string;
  readonly capture_failed: readonly FailedTab[];
  readonly bar_tabs: readonly NightTab[];
  readonly charge_remaining: { readonly count: number; readonly total_cents: number };
  readonly tab_cut_off_at: string | null;
  readonly checks: readonly Check[];
  readonly closed: { readonly closed_at: string; readonly z_number: number } | null;
  readonly late_money_posts_to: string | null;
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
      {night && venueId && date && (
        <NightChecks
          venueId={venueId}
          date={date}
          timeZone={timeZone}
          checks={night.checks}
          closed={night.closed}
          postsTo={night.late_money_posts_to}
          onChanged={() => void load()}
        />
      )}
      {venueId && date && (
        <ReportPanel key={night?.closed ? "z" : "x"} venueId={venueId} date={date} />
      )}
      {venueId && <UnmatchedPayments venueId={venueId} timeZone={timeZone} />}
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
      {night && night.capture_failed.length > 0 && (
        <section className="card" aria-labelledby="night-failed">
          <h2 id="night-failed">{t("night.failedTabs")}</h2>
          <p className="small">{t("night.failedHint")}</p>
          <ul className="night-tabs night-failed-tabs">
            {night.capture_failed.map((tab) => (
              <FailedTabRow key={tab.id} venueId={venueId} tab={tab} onChanged={load} />
            ))}
          </ul>
        </section>
      )}
      {venueId && date && (
        <div className="card">
          <TipsPanel venueId={venueId} date={date} />
        </div>
      )}
      {venueId && (
        <div className="card">
          <DrawerPanel
            venueId={venueId}
            canHandOver={
              signedIn?.membership.role === "owner" || signedIn?.membership.role === "manager"
            }
          />
        </div>
      )}
    </section>
  );
}

/** One tab whose capture failed: what it owes, settled by the saved card, another card or cash. */
function FailedTabRow({
  venueId,
  tab,
  onChanged,
}: {
  venueId: string;
  tab: FailedTab;
  onChanged: () => void;
}) {
  const { t, money, date } = useT();
  const [way, setWay] = useState<"card" | "cash" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const settleUrl = `/v1/venues/${venueId}/tabs/${tab.id}/settle`;
  const savedCard = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api<{ status: string }>(
        "POST",
        settleUrl,
        { method: "saved_card", amount_cents: tab.owed_cents },
        { idempotencyKey: `settle-${tab.id}-${Date.now()}` },
      );
      setNote(
        r.status === "captured"
          ? t("night.settled")
          : r.status === "failed" || r.status === "canceled"
            ? t("night.savedDeclined")
            : t("pay.unknown"),
      );
    } catch (e) {
      setNote(
        e instanceof ApiCallError && e.code === "payment_unknown"
          ? t("pay.unknown")
          : t("night.savedDeclined"),
      );
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <li className="night-failed">
      <div className="row night-tab">
        <span>
          <strong data-guest-text>{tab.name}</strong>
          {tab.card && (
            <span className="small" data-guest-text>
              {` · ${tab.card.brand} ··${tab.card.last4}`}
            </span>
          )}
        </span>
        <span>
          {t("night.owes", {
            amount: money(tab.owed_cents as never),
            date: date(tab.business_date),
          })}
        </span>
      </div>
      {note && (
        <p role="status" className="notice">
          {note}
        </p>
      )}
      {way === "card" ? (
        <TapPayment
          venueId={venueId}
          checkId={tab.check_id}
          dueCents={tab.owed_cents}
          payUrl={settleUrl}
          onDone={() => {
            setWay(null);
            onChanged();
          }}
        />
      ) : way === "cash" ? (
        <CashPanel
          venueId={venueId}
          checkId={tab.check_id}
          dueCents={tab.owed_cents}
          payUrl={settleUrl}
          oneTap
          onTaken={() => {
            setWay(null);
            setNote(t("night.settled"));
            onChanged();
          }}
        />
      ) : (
        <div className="actions">
          {tab.saved_card && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void savedCard()}
            >
              {t("savedCard.title")}
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setWay("card")}
          >
            {t("closeTab.anotherCard")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setWay("cash")}
          >
            {t("cash.title")}
          </button>
        </div>
      )}
      {way && (
        <button type="button" className="link" onClick={() => setWay(null)}>
          {t("night.settleBack")}
        </button>
      )}
    </li>
  );
}

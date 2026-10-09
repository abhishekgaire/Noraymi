"use client";

import { useState } from "react";
import { cents, formatMoney, t, type MessageKey } from "@west4/shared";
import { clockWords, dateWords, hhmmWords } from "../../site/data";
import { PayButton } from "../../site/pay-button";

/** The manage view the booking link carries (M5-11; GET /v1/public/bookings/{token} · manage). */
export interface ManageView {
  readonly id: string;
  readonly status: string;
  readonly slug: string;
  readonly business_date: string;
  readonly starts_at: string;
  readonly time: string;
  readonly minutes: number;
  readonly time_zone: string;
  readonly size_tier: string;
  readonly party_size: number;
  readonly min_guests: number | null;
  readonly max_guests: number | null;
  readonly deposit_cents: number;
  readonly held_cents: number;
  readonly owed_cents: number;
  readonly cutoff_words: string | null;
  readonly before_cutoff: boolean;
  readonly running_late_until: string | null;
  readonly grace_min: number;
  readonly can_change: boolean;
  readonly can_run_late: boolean;
  /** M5-12: cancelling, what it would do now, and once cancelled the refund or the kept part. */
  readonly can_cancel: boolean;
  readonly cancel_preview: { refund_cents: number; kept_cents: number } | null;
  readonly cancelled_via: string | null;
  readonly refund: { amount_cents: number; status: "pending" | "refunded" | "failed" } | null;
  readonly kept_cents: number;
  /** M5-13: a staff or big-party booking waiting on its payment link: the hold, the policy and what to pay. */
  readonly pay: {
    readonly deposit_cents: number;
    readonly card_hold: boolean;
    readonly pending_until: string;
    readonly policy: { id: string; version: number; text: string } | null;
  } | null;
}

interface Change {
  readonly party_size?: number;
  readonly business_date?: string;
  readonly time?: string;
}

interface Answer {
  readonly booking: ManageView;
  readonly deposit_cents: number;
  readonly collect_cents: number;
  readonly refund_cents: number;
  readonly stays_cents: number;
  readonly pay_url: string | null;
  readonly running_late_until: string | null;
}

const money = (c: number) => formatMoney("en", cents(c));

/**
 * The manage page (M5-11; screens · Manage): the booking, its deposit and the
 * refund cut-off, with Change party size, Change time or date and Running
 * late. Every change is previewed first (what the deposit becomes, what is
 * paid or refunded, or, past the cut-off, that the deposit already paid stays)
 * and only the guest's Confirm makes it. A difference to pay opens the payment
 * page; the booking link rides in the fragment so it comes back here.
 */
export function Manage({
  token,
  initial,
  onChanged,
}: {
  token: string;
  initial: ManageView;
  onChanged: (next: ManageView) => void;
}) {
  const m = initial;
  const path = `/v1/public/bookings/${encodeURIComponent(token)}`;
  const [open, setOpen] = useState<"party" | "time" | null>(null);
  const [party, setParty] = useState(m.party_size);
  const [day, setDay] = useState(m.business_date);
  const [time, setTime] = useState(m.time);
  const [times, setTimes] = useState<{ time: string; free: boolean }[] | null>(null);
  const [preview, setPreview] = useState<{ change: Change; answer: Answer } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [late, setLate] = useState<string | null>(m.running_late_until);
  const [cancelling, setCancelling] = useState(false);

  const tier = t("en", `site.book.tier.${m.size_tier}` as MessageKey);
  const when = t("en", "manage.when", {
    date: dateWords(m.business_date),
    time: clockWords(m.starts_at, m.time_zone),
    guests: m.party_size,
  });

  async function patch(body: object): Promise<Answer | { reason: string } | null> {
    const r = await fetch(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await r.json().catch(() => null)) as
      (Answer & { error?: { details?: { reason?: string } } }) | null;
    if (r.ok && json) return json;
    return { reason: json?.error?.details?.reason ?? "failed" };
  }

  const reasonWords = (reason: string) =>
    t(
      "en",
      ([
        "off_grid",
        "past",
        "started",
        "too_big",
        "closed",
        "pay_difference_first",
        "call_venue",
        "too_late",
      ].includes(reason)
        ? `manage.refused.${reason}`
        : reason === "room_not_free" || reason === "no_room"
          ? "manage.refused.no_room"
          : "manage.failed") as MessageKey,
    );

  async function ask(change: Change) {
    setBusy(true);
    setError(null);
    const answer = await patch({ ...change, preview: true }).catch(() => null);
    setBusy(false);
    if (!answer) return setError(t("en", "manage.failed"));
    if ("reason" in answer) return setError(reasonWords(answer.reason));
    setPreview({ change, answer });
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const answer = await patch({
      ...preview.change,
      ...(preview.answer.stays_cents > 0 ? { accept_keep: true } : {}),
    }).catch(() => null);
    setBusy(false);
    if (!answer) return setError(t("en", "manage.failed"));
    if ("reason" in answer) return setError(reasonWords(answer.reason));
    if (answer.pay_url) {
      window.location.assign(`${answer.pay_url}#b=${encodeURIComponent(token)}`);
      return;
    }
    setPreview(null);
    setOpen(null);
    onChanged(answer.booking);
  }

  async function payDifference() {
    setBusy(true);
    const r = await fetch(`${path}/pay`, { method: "POST" }).catch(() => null);
    const body = (await r?.json().catch(() => null)) as { pay_url?: string } | null;
    if (body?.pay_url) {
      window.location.assign(`${body.pay_url}#b=${encodeURIComponent(token)}`);
      return;
    }
    setBusy(false);
    setError(t("en", "manage.failed"));
  }

  async function runningLate() {
    setBusy(true);
    setError(null);
    const answer = await patch({ running_late: true }).catch(() => null);
    setBusy(false);
    if (!answer) return setError(t("en", "manage.failed"));
    if ("reason" in answer) return setError(reasonWords(answer.reason));
    setLate(answer.running_late_until);
    onChanged(answer.booking);
  }

  async function cancelIt() {
    setBusy(true);
    setError(null);
    const r = await fetch(path, { method: "DELETE" }).catch(() => null);
    const body = (await r?.json().catch(() => null)) as {
      booking?: ManageView;
      error?: { details?: { reason?: string } };
    } | null;
    setBusy(false);
    if (r?.ok && body?.booking) return onChanged(body.booking);
    setError(reasonWords(body?.error?.details?.reason ?? "failed"));
  }

  async function loadTimes(date: string) {
    setTimes(null);
    const q = new URLSearchParams({
      date,
      guests: String(m.party_size),
      hours: String(m.minutes / 60),
    });
    const r = await fetch(
      `/v1/public/venues/${encodeURIComponent(m.slug)}/availability?${q}`,
    ).catch(() => null);
    const body = (await r?.json().catch(() => null)) as {
      slots?: { time: string; free: boolean }[];
    } | null;
    setTimes(body?.slots ?? []);
  }

  const outcome = (a: Answer) => {
    const lines: string[] = [];
    if (a.deposit_cents !== m.deposit_cents)
      lines.push(t("en", "manage.depositBecomes", { amount: money(a.deposit_cents) }));
    if (a.collect_cents > 0)
      lines.push(t("en", "manage.payDifference", { amount: money(a.collect_cents) }));
    if (a.refund_cents > 0)
      lines.push(t("en", "manage.refundBack", { amount: money(a.refund_cents) }));
    if (a.stays_cents > 0)
      lines.push(
        t("en", "manage.depositStays", {
          amount: money(a.deposit_cents),
          cutoff: m.cutoff_words ?? "",
        }),
      );
    if (a.booking.size_tier !== m.size_tier)
      lines.push(
        t("en", "manage.newRoom", {
          tier: t("en", `site.book.tier.${a.booking.size_tier}` as MessageKey),
        }),
      );
    if (lines.length === 0) lines.push(t("en", "manage.noMoney"));
    return lines;
  };

  return (
    <section aria-labelledby="manage-h" className="manage">
      <h2 id="manage-h">{t("en", "manage.title")}</h2>
      <p className="lead">{t("en", "site.book.confirmedWhat", { tier, when })}</p>
      {m.status === "pending" && m.pay && (
        <div className="terms" aria-label={t("en", "site.book.terms")}>
          <p>
            {t("en", "manage.heldUntil", {
              time: clockWords(m.pay.pending_until, m.time_zone),
              date: new Intl.DateTimeFormat("en-US", {
                timeZone: m.time_zone,
                weekday: "short",
                month: "short",
                day: "numeric",
              }).format(new Date(m.pay.pending_until)),
            })}
          </p>
          {m.cutoff_words && (
            <p className="cutoff">{t("en", "site.book.cutoff", { cutoff: m.cutoff_words })}</p>
          )}
          {m.pay.policy?.text
            .split("\n")
            .filter((line) => line.trim())
            .map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          <PayButton
            token={token}
            label={
              m.pay.card_hold
                ? t("en", "payPage.cardHoldTitle")
                : t("en", "payPage.payDeposit", { amount: money(m.pay.deposit_cents) })
            }
          />
        </div>
      )}
      {m.held_cents > 0 && (
        <p>{t("en", "site.book.depositPaid", { amount: money(m.held_cents) })}</p>
      )}
      {m.cutoff_words && (
        <p className="cutoff">
          {m.before_cutoff
            ? t("en", "site.book.cutoff", { cutoff: m.cutoff_words })
            : t("en", "manage.pastCutoff", { cutoff: m.cutoff_words })}
        </p>
      )}
      {m.owed_cents > 0 && (
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => void payDifference()}
        >
          {t("en", "manage.payDifferenceButton", { amount: money(m.owed_cents) })}
        </button>
      )}
      {late && (
        <p role="status">
          {t("en", "manage.lateHeld", { time: clockWords(late, m.time_zone), grace: m.grace_min })}
        </p>
      )}
      {error && <p role="alert">{error}</p>}

      {preview ? (
        <div className="manage-preview" aria-live="polite">
          {outcome(preview.answer).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {preview.answer.collect_cents > 0
              ? t("en", "manage.confirmAndPay", { amount: money(preview.answer.collect_cents) })
              : t("en", "manage.confirm")}
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => setPreview(null)}>
            {t("en", "manage.keepAsIs")}
          </button>
        </div>
      ) : (
        m.can_change && (
          <div className="manage-actions">
            <button
              type="button"
              className="button"
              onClick={() => setOpen(open === "party" ? null : "party")}
            >
              {t("en", "manage.changeParty")}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setOpen(open === "time" ? null : "time");
                void loadTimes(day);
              }}
            >
              {t("en", "manage.changeTime")}
            </button>
          </div>
        )
      )}

      {!preview && open === "party" && (
        <div className="manage-party">
          <div className="stepper">
            <button
              type="button"
              aria-label={t("en", "manage.fewer")}
              disabled={party <= 1}
              onClick={() => setParty(party - 1)}
            >
              −
            </button>
            <span aria-live="polite">{t("en", "manage.guests", { n: party })}</span>
            <button
              type="button"
              aria-label={t("en", "manage.more")}
              disabled={m.max_guests !== null && party >= m.max_guests}
              onClick={() => setParty(party + 1)}
            >
              +
            </button>
          </div>
          {m.min_guests !== null && party < m.min_guests && (
            <p className="small">{t("en", "manage.billedAs", { min: m.min_guests })}</p>
          )}
          <button
            type="button"
            className="button primary"
            disabled={busy || party === m.party_size}
            onClick={() => void ask({ party_size: party })}
          >
            {t("en", "manage.updateTo", { n: party })}
          </button>
        </div>
      )}

      {!preview && open === "time" && (
        <div className="manage-time">
          <label>
            {t("en", "manage.date")}
            <input
              type="date"
              value={day}
              onChange={(e) => {
                setDay(e.target.value);
                void loadTimes(e.target.value);
              }}
            />
          </label>
          <label>
            {t("en", "manage.time")}
            <select value={time} onChange={(e) => setTime(e.target.value)}>
              {(times ?? [{ time: m.time, free: true }]).map((s) => (
                <option key={s.time} value={s.time}>
                  {hhmmWords(s.time)}
                  {s.free ? "" : ` · ${t("en", "manage.taken")}`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button primary"
            disabled={busy || (day === m.business_date && time === m.time)}
            onClick={() =>
              void ask({
                ...(day !== m.business_date ? { business_date: day } : {}),
                ...(time !== m.time ? { time } : {}),
              })
            }
          >
            {t("en", "manage.pickNewTime")}
          </button>
        </div>
      )}

      {!preview && m.can_run_late && !late && (
        <button type="button" className="button" disabled={busy} onClick={() => void runningLate()}>
          {t("en", "manage.runningLate")}
        </button>
      )}

      {!preview && m.can_cancel && !cancelling && (
        <button type="button" className="button" onClick={() => setCancelling(true)}>
          {t("en", "manage.cancel")}
        </button>
      )}
      {!preview && cancelling && (
        <div className="manage-preview" role="dialog" aria-label={t("en", "manage.cancel")}>
          {m.cancel_preview &&
            m.cancel_preview.kept_cents === 0 &&
            m.cancel_preview.refund_cents > 0 && (
              <p>
                {t("en", "manage.cancelRefund", {
                  amount: money(m.cancel_preview.refund_cents),
                  cutoff: m.cutoff_words ?? "",
                })}
              </p>
            )}
          {m.cancel_preview && m.cancel_preview.kept_cents > 0 && (
            <p>
              {t(
                "en",
                m.cancel_preview.refund_cents > 0 ? "manage.cancelKept" : "manage.cancelKeptAll",
                {
                  kept: money(m.cancel_preview.kept_cents),
                  refund: money(m.cancel_preview.refund_cents),
                  cutoff: m.cutoff_words ?? "",
                },
              )}
            </p>
          )}
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void cancelIt()}
          >
            {t("en", "manage.yesCancel")}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => setCancelling(false)}
          >
            {t("en", "manage.keepIt")}
          </button>
        </div>
      )}
    </section>
  );
}

/** A cancelled booking (M5-12): the refund as it goes ("Refund pending", then "Refunded") or what was kept. */
export function Cancelled({ view }: { view: ManageView }) {
  return (
    <section aria-labelledby="cancelled-h" className="manage">
      <h2 id="cancelled-h">{t("en", "manage.cancelled")}</h2>
      {view.refund && (
        <p role="status">
          {t(
            "en",
            view.refund.status === "refunded"
              ? "manage.refunded"
              : view.refund.status === "pending"
                ? "manage.refundPending"
                : "manage.refundFailed",
            { amount: money(view.refund.amount_cents) },
          )}
        </p>
      )}
      {view.kept_cents > 0 && (
        <p>{t("en", "manage.depositKept", { amount: money(view.kept_cents) })}</p>
      )}
    </section>
  );
}

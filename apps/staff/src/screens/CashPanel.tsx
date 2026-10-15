import { useState } from "react";
import { cashOffers, changeDue } from "@west4/rules";
import { cents, parseDollars } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Cash (M4-13; Payment flows · Cash; screens N21): Exact, the next $5, $10
 * or $20, or Other; the change due in large type; a cash-tip field; and once
 * taken, where it went ("Logged to Diego · front-desk drawer", or the
 * person's staff bank on a phone), with "Wrong amount? Fix the change".
 */
export interface Taken {
  readonly id: string;
  readonly change_cents: number;
  readonly logged_to: { readonly name: string; readonly drawer: string | null };
}

const newKey = () => `cash-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
/** Typed dollars as cents through the shared parser, never a float (U-06). */
const toCents = (text: string): number | null => parseDollars(text);

/**
 * Both prices before the guest chooses (U-02; Money rules 10): "Card $13.92 · Cash $13.41", with the
 * cash price the API worked out. Nothing with the cash discount off or nothing due.
 */
export function CardAndCash({
  cardCents,
  cashCents,
}: {
  cardCents: number;
  cashCents: number | null | undefined;
}) {
  const { t, money } = useT();
  if (cashCents === null || cashCents === undefined || cardCents <= 0 || cashCents === cardCents)
    return null;
  return (
    <p className="small card-and-cash">
      {t("cash.bothPrices", { card: money(cents(cardCents)), cash: money(cents(cashCents)) })}
    </p>
  );
}

export function CashPanel({
  venueId,
  checkId,
  dueCents,
  cashCents = null,
  shareId,
  onTaken,
  oneTap = false,
  payUrl,
}: {
  venueId: string;
  checkId: string;
  dueCents: number;
  /**
   * The cash price of `dueCents` with the cash discount on (U-02), as the API gave it: Exact, the bill
   * offers, the change and Take are worked from it. Null with the discount off; a split's share passes
   * its own cash price (U-03, D133). What's sent is still `dueCents`, discounted on the server.
   */
  cashCents?: number | null;
  /** A split's share (M4-14): the payment pays it. */
  shareId?: string | null;
  onTaken: (taken: Taken) => void;
  /** The bar's quick sale (M6-05): one tap on what the guest handed over takes it. */
  oneTap?: boolean;
  /** Cash on a bar tab (M6-11): the tab's own pay route, which cancels its hold once the cash is in. */
  payUrl?: string;
}) {
  const { t, money } = useT();
  const [tendered, setTendered] = useState<number | null>(null);
  const [other, setOther] = useState("");
  const [tip, setTip] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tipCents = toCents(tip) ?? 0;
  // What the cash pays: the cash price with the cash discount on, else what's due.
  const owedCents = cashCents !== null && cashCents > 0 ? cashCents : dueCents;
  const offers = cashOffers(owedCents + tipCents);
  const change =
    tendered === null ? null : changeDue({ owedCents, tipCents, tenderedCents: tendered });

  const take = async (handed: number | null = tendered) => {
    const owed = handed === null ? null : changeDue({ owedCents, tipCents, tenderedCents: handed });
    if (handed === null || owed === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Taken>(
        "POST",
        payUrl ?? `/v1/venues/${venueId}/checks/${checkId}/payments`,
        {
          method: "cash",
          amount_cents: dueCents,
          tendered_cents: handed,
          ...(tipCents > 0 ? { tip_cents: tipCents } : {}),
          ...(shareId ? { share_id: shareId } : {}),
        },
        { idempotencyKey: newKey() },
      );
      onTaken(r);
    } catch (e) {
      const err = e instanceof ApiCallError ? e : null;
      setError(
        err?.code === "over_amount_due"
          ? t("cash.overDue")
          : err?.details["reason"] === "not_your_drawer"
            ? // A drawer per person (M7-07): only its owner takes cash into it.
              t("cash.notYourDrawer", { owner: String(err.details["owner"] ?? "") })
            : t("cash.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  if (dueCents <= 0) return null;
  return (
    <section className="cash" aria-label={t("cash.title")}>
      <h3>{t("cash.title")}</h3>
      {owedCents !== dueCents && <CardAndCash cardCents={dueCents} cashCents={owedCents} />}
      <div className="team-actions" role="group" aria-label={t("cash.handedOver")}>
        {offers.map((o) => (
          <button
            key={o.kind}
            type="button"
            className={tendered === o.cents ? "primary" : "secondary"}
            onClick={() => {
              setTendered(o.cents);
              setOther("");
              if (oneTap) void take(o.cents);
            }}
          >
            {o.kind === "exact" ? t("cash.exact", { amount: money(o.cents) }) : money(o.cents)}
          </button>
        ))}
        <label>
          <span>{t("cash.other")}</span>
          <input
            inputMode="decimal"
            aria-label={t("cash.other")}
            value={other}
            onChange={(e) => {
              setOther(e.target.value);
              setTendered(toCents(e.target.value));
            }}
          />
        </label>
      </div>
      <label>
        <span>{t("cash.tip")}</span>
        <input
          inputMode="decimal"
          aria-label={t("cash.tip")}
          value={tip}
          onChange={(e) => setTip(e.target.value)}
        />
      </label>
      {tendered !== null && (
        <p className="change-due" aria-label={t("cash.change")}>
          {change === null ? (
            <span className="error">{t("cash.short")}</span>
          ) : (
            <>
              {t("cash.change")} <strong>{money(change)}</strong>
            </>
          )}
        </p>
      )}
      <button
        type="button"
        className="primary"
        disabled={busy || change === null}
        onClick={() => void take()}
      >
        {t("cash.take", { amount: money(cents(owedCents + tipCents)) })}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** What happened to the cash, kept on the room screen after the room goes to cleaning. */
export function CashResult({ venueId, taken: first }: { venueId: string; taken: Taken }) {
  const { t, money } = useT();
  const [taken, setTaken] = useState<Taken>(first);
  const [fixing, setFixing] = useState(false);
  const [fixed, setFixed] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fix = async () => {
    const amount = toCents(fixed);
    if (amount === null) return;
    setBusy(true);
    try {
      const r = await api<{ change_cents: number }>(
        "POST",
        `/v1/venues/${venueId}/payments/${taken.id}/change`,
        { tendered_cents: amount },
        { idempotencyKey: newKey() },
      );
      setTaken({ ...taken, change_cents: r.change_cents });
      setFixing(false);
    } catch {
      setError(t("cash.short"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cash" aria-label={t("cash.taken")}>
      <h3>{t("cash.title")}</h3>
      <p className="change-due" aria-label={t("cash.change")}>
        {t("cash.change")} <strong>{money(cents(taken.change_cents))}</strong>
      </p>
      <p role="status">
        {taken.logged_to.drawer
          ? t("cash.logged", {
              name: taken.logged_to.name,
              drawer: taken.logged_to.drawer.toLowerCase(),
            })
          : t("cash.loggedBank", { name: taken.logged_to.name })}
      </p>
      {fixing ? (
        <div className="team-actions">
          <label>
            <span>{t("cash.handedOver")}</span>
            <input
              inputMode="decimal"
              aria-label={t("cash.handedOver")}
              value={fixed}
              onChange={(e) => setFixed(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy || toCents(fixed) === null}
            onClick={() => void fix()}
          >
            {t("cash.fixSave")}
          </button>
        </div>
      ) : (
        <button type="button" className="link" onClick={() => setFixing(true)}>
          {t("cash.fix")}
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

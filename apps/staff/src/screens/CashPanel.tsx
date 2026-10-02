import { useState } from "react";
import { cashOffers, changeDue } from "@west4/rules";
import { cents } from "@west4/shared";
import { api, type ApiCallError } from "../api.js";
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
const toCents = (text: string): number | null => {
  const m = /^\s*\$?(\d+)(?:\.(\d{1,2}))?\s*$/.exec(text);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : null;
};

export function CashPanel({
  venueId,
  checkId,
  dueCents,
  onTaken,
}: {
  venueId: string;
  checkId: string;
  dueCents: number;
  onTaken: (taken: Taken) => void;
}) {
  const { t, money } = useT();
  const [tendered, setTendered] = useState<number | null>(null);
  const [other, setOther] = useState("");
  const [tip, setTip] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tipCents = toCents(tip) ?? 0;
  const offers = cashOffers(dueCents + tipCents);
  const change =
    tendered === null
      ? null
      : changeDue({ owedCents: dueCents, tipCents, tenderedCents: tendered });

  const take = async () => {
    if (tendered === null || change === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Taken>(
        "POST",
        `/v1/venues/${venueId}/checks/${checkId}/payments`,
        {
          method: "cash",
          amount_cents: dueCents,
          tendered_cents: tendered,
          ...(tipCents > 0 ? { tip_cents: tipCents } : {}),
        },
        { idempotencyKey: newKey() },
      );
      onTaken(r);
    } catch (e) {
      setError(
        (e as ApiCallError)?.code === "over_amount_due" ? t("cash.overDue") : t("cash.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  if (dueCents <= 0) return null;
  return (
    <section className="cash" aria-label={t("cash.title")}>
      <h3>{t("cash.title")}</h3>
      <div className="team-actions" role="group" aria-label={t("cash.handedOver")}>
        {offers.map((o) => (
          <button
            key={o.kind}
            type="button"
            className={tendered === o.cents ? "primary" : "secondary"}
            onClick={() => {
              setTendered(o.cents);
              setOther("");
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
        {t("cash.take", { amount: money(cents(dueCents + tipCents)) })}
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
    <section className="cash" aria-label={t("cash.title")}>
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

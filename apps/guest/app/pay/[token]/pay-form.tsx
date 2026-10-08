"use client";

import { useEffect, useRef, useState } from "react";
import { cents, formatMoney, t } from "@west4/shared";
import { Countdown } from "../../site/countdown";

/**
 * The pay step (M4-15): Stripe.js from js.stripe.com with our publishable key
 * and the venue's account, and the Payment Element. While our server waits
 * for Stripe's answer it says it's still checking and shows no second pay
 * button. With the fake Stripe (local runs and tests), a test card stands in
 * for the Payment Element.
 */
export interface PayPage {
  readonly status: "open" | "paid" | "checking" | "declined" | "lapsed";
  readonly kind: "balance" | "deposit";
  /** A booking's deposit (M5-09): the hold's countdown, the policy above the pay button, where to pick again. */
  readonly deposit: {
    readonly seconds_left: number | null;
    readonly more_time_left: number;
    readonly cutoff_words: string | null;
    readonly policy: { id: string; version: number; text: string; hash: string } | null;
    readonly pick_again_url: string | null;
  } | null;
  readonly amount_cents: number;
  readonly venue_name: string;
  readonly client_secret: string | null;
  readonly publishable_key: string;
  readonly stripe_account: string;
  readonly mode: "stripe" | "fake" | "off";
}

interface StripeLike {
  elements(options: { clientSecret: string }): {
    create(kind: "payment"): { mount(el: HTMLElement): void };
  };
  confirmPayment(options: {
    elements: unknown;
    redirect: "if_required";
  }): Promise<{ error?: { message?: string } }>;
}
declare global {
  interface Window {
    Stripe?: (key: string, options: { stripeAccount: string }) => StripeLike;
  }
}

export function PayForm({
  token,
  page: first,
  nonce,
}: {
  token: string;
  page: PayPage;
  nonce: string;
}) {
  const [page, setPage] = useState(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mount = useRef<HTMLDivElement>(null);
  const stripe = useRef<{ client: StripeLike; elements: unknown } | null>(null);

  useEffect(() => {
    if (page.mode !== "stripe" || page.status !== "open" || !page.client_secret || stripe.current)
      return;
    const script = document.createElement("script");
    script.src = "https://js.stripe.com/v3/";
    script.nonce = nonce;
    script.onload = () => {
      if (!window.Stripe || !mount.current || !page.client_secret) return;
      const client = window.Stripe(page.publishable_key, { stripeAccount: page.stripe_account });
      const elements = client.elements({ clientSecret: page.client_secret });
      elements.create("payment").mount(mount.current);
      stripe.current = { client, elements };
    };
    document.head.appendChild(script);
  }, [page, nonce]);

  const confirm = async (testCard?: string) => {
    setBusy(true);
    setError(null);
    // Pressing Pay: a deposit records the policy read above the button; a declined card starts a new try.
    const started = await fetch(`/v1/public/pay/${encodeURIComponent(token)}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        page.deposit?.policy ? { policy_version_id: page.deposit.policy.id } : {},
      ),
    });
    if (!started.ok) {
      // The hold ran out, or the policy changed: the page reloads to say so.
      window.location.reload();
      return;
    }
    if (stripe.current) {
      const r = await stripe.current.client.confirmPayment({
        elements: stripe.current.elements,
        redirect: "if_required",
      });
      if (r.error) setError(r.error.message ?? t("en", "payPage.declined"));
    }
    setPage({ ...page, status: "checking" });
    const res = await fetch(`/v1/public/pay/${encodeURIComponent(token)}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(testCard ? { test_card: testCard } : {}),
    });
    const next = (await res.json()) as PayPage;
    setPage(next);
    setBusy(false);
  };

  const amount = formatMoney("en", cents(page.amount_cents));
  const deposit = page.deposit;
  const payLabel = t("en", deposit ? "payPage.payDeposit" : "payPage.pay", { amount });
  return (
    <main className="guest pay-page">
      <header>
        <p className="venue">{page.venue_name}</p>
        <h1>{t("en", deposit ? "payPage.depositTitle" : "payPage.title", { amount })}</h1>
      </header>
      {deposit &&
        page.status !== "paid" &&
        page.status !== "lapsed" &&
        deposit.seconds_left !== null && (
          <Countdown
            token={token}
            secondsLeft={deposit.seconds_left}
            moreTimeLeft={deposit.more_time_left}
            moreTimeUrl={`/v1/public/pay/${encodeURIComponent(token)}/more-time`}
          />
        )}
      {page.status === "lapsed" ? (
        <section aria-labelledby="lapsed-h">
          <h2 id="lapsed-h">{t("en", "site.book.lapsed")}</h2>
          {deposit?.pick_again_url && (
            <a className="button" href={deposit.pick_again_url}>
              {t("en", "site.book.pickAgain")}
            </a>
          )}
        </section>
      ) : page.status === "paid" ? (
        <p role="status">{t("en", "payPage.paid", { amount })}</p>
      ) : page.status === "checking" ? (
        <p role="status">{t("en", "payPage.checking")}</p>
      ) : (
        <>
          {page.status === "declined" && <p role="alert">{t("en", "payPage.declined")}</p>}
          {error && <p role="alert">{error}</p>}
          {deposit?.policy && (
            <section aria-labelledby="terms-h" className="terms">
              <h2 id="terms-h">{t("en", "site.book.terms")}</h2>
              {deposit.cutoff_words && (
                <p className="cutoff">
                  {t("en", "site.book.cutoff", { cutoff: deposit.cutoff_words })}
                </p>
              )}
              {deposit.policy.text
                .split("\n")
                .filter((line) => line.trim())
                .map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              <p className="small">
                {t("en", "site.book.policyVersion", { n: deposit.policy.version })}
              </p>
            </section>
          )}
          {page.mode === "stripe" ? (
            <>
              <div ref={mount} className="payment-element" />
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {payLabel}
              </button>
            </>
          ) : (
            <div className="test-card">
              <p className="small">{t("en", "payPage.testMode")}</p>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void confirm("pm_card_visa")}
              >
                {payLabel}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void confirm("pm_card_chargeDeclined")}
              >
                {t("en", "payPage.testDecline")}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { cents, formatMoney, t } from "@west4/shared";

/**
 * The pay step (M4-15): Stripe.js from js.stripe.com with our publishable key
 * and the venue's account, and the Payment Element. While our server waits
 * for Stripe's answer it says it's still checking and shows no second pay
 * button. With the fake Stripe (local runs and tests), a test card stands in
 * for the Payment Element.
 */
export interface PayPage {
  readonly status: "open" | "paid" | "checking" | "declined";
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
  return (
    <main className="guest pay-page">
      <header>
        <p className="venue">{page.venue_name}</p>
        <h1>{t("en", "payPage.title", { amount })}</h1>
      </header>
      {page.status === "paid" ? (
        <p role="status">{t("en", "payPage.paid", { amount })}</p>
      ) : page.status === "checking" ? (
        <p role="status">{t("en", "payPage.checking")}</p>
      ) : (
        <>
          {page.status === "declined" && <p role="alert">{t("en", "payPage.declined")}</p>}
          {error && <p role="alert">{error}</p>}
          {page.mode === "stripe" ? (
            <>
              <div ref={mount} className="payment-element" />
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {t("en", "payPage.pay", { amount })}
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
                {t("en", "payPage.pay", { amount })}
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

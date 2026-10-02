"use client";

import { Fragment, useState } from "react";
import { cents, formatMoney, t } from "@west4/shared";

/**
 * "Your bill" (M4-16; screens N5): the presented check on a guest's phone,
 * its room's tablet and the booking link. The finalized revision's lines,
 * tax, the 20% gratuity, the deposit, each payment as it lands and what's
 * left to pay; then the ways to pay, or "Paid in full". A tablet shows the
 * bill with no ways to pay. Card on file (M4-17) and Pay my share (M4-18)
 * join the ways to pay in their own tickets.
 */
export interface GuestBill {
  readonly check_id: string;
  readonly number: string;
  readonly revision: number;
  readonly status: "finalized" | "partly_paid" | "paid";
  readonly room_time_cents: number;
  readonly drinks_cents: number;
  readonly other_cents: number;
  readonly subtotal_cents: number;
  readonly tax_cents: number;
  readonly gratuity_cents: number;
  readonly tax_pct: string | null;
  readonly gratuity_pct: string | null;
  readonly total_cents: number;
  readonly deposit_cents: number;
  readonly amount_due_cents: number;
  readonly payments: readonly {
    readonly kind: "card" | "cash" | "online" | "card_on_file" | "share" | "other";
    readonly amount_cents: number;
    readonly last4: string | null;
    readonly name: string | null;
    readonly share_no: number | null;
    readonly shares: number | null;
  }[];
  readonly card_on_file?: { readonly brand: string; readonly last4: string } | null;
  /** Staff chose Card on file: the guest's "Pay with Amex ··1005" (M4-17). */
  readonly on_file_request?: { readonly payment_id: string; readonly amount_cents: number } | null;
  /** Pay my share (M4-18), when the venue offers it. */
  readonly pay_share?: { readonly shares: number } | null;
}

/** The guest's share, as POST /room-session/shares answers it. */
export interface ShareAnswer {
  readonly share: {
    readonly share_no: number;
    readonly shares: number;
    readonly share_cents: number;
    readonly tax_cents: number;
    readonly gratuity_cents: number;
    readonly amount_cents: number;
    readonly state: "open" | "paying" | "paid";
  } | null;
  readonly url: string | null;
  readonly nothing_left: boolean;
}

const BRANDS: Record<string, string> = {
  amex: "Amex",
  visa: "Visa",
  mastercard: "Mastercard",
  discover: "Discover",
};

const money = (c: number) =>
  c < 0 ? `−${formatMoney("en", cents(-c))}` : formatMoney("en", cents(c));

function paidLabel(p: GuestBill["payments"][number]): string {
  if (p.kind === "share" && p.share_no !== null)
    return t("en", "yourBill.paidBy.share", {
      name: p.name ?? "",
      n: p.share_no,
      of: p.shares ?? p.share_no,
    });
  if ((p.kind === "card" || p.kind === "card_on_file") && p.last4)
    return t("en", "yourBill.paidBy.card", { last4: p.last4 });
  if (p.kind === "cash") return t("en", "yourBill.paidBy.cash");
  if (p.kind === "online") return t("en", "yourBill.paidBy.online");
  return t("en", "yourBill.paidBy.other");
}

export function YourBill({
  bill,
  payLink,
  payCash,
  payOnFile,
  payShare,
}: {
  bill: GuestBill;
  /** Starts this guest's share of the bill (M4-18). */
  payShare?: (kind: "even" | "items", name: string | null) => Promise<ShareAnswer | null>;
  /** Confirms the card on file staff asked for; answers paid, declined or checking (M4-17). */
  payOnFile?: (paymentId: string) => Promise<"paid" | "declined" | "checking" | null>;
  /** Asks for a payment-page link; absent on a tablet. */
  payLink?: () => Promise<string | null>;
  /** "Pay cash to staff"; absent on a tablet. */
  payCash?: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [cashSent, setCashSent] = useState(false);
  const [onFile, setOnFile] = useState<"declined" | "checking" | null>(null);
  const [mine, setMine] = useState<ShareAnswer | null>(null);
  const [name, setName] = useState("");
  const [shareFailed, setShareFailed] = useState(false);
  const paid = bill.status === "paid";

  const another = async () => {
    if (!payLink) return;
    setBusy(true);
    setError(false);
    const url = await payLink().catch(() => null);
    if (url) window.location.assign(url);
    else {
      setError(true);
      setBusy(false);
    }
  };
  const confirmOnFile = async () => {
    if (!payOnFile || !bill.on_file_request) return;
    setBusy(true);
    const r = await payOnFile(bill.on_file_request.payment_id).catch(() => null);
    setOnFile(r === "declined" ? "declined" : r === "paid" ? null : "checking");
    setBusy(false);
  };
  const share = async (kind: "even" | "items") => {
    if (!payShare) return;
    setBusy(true);
    setShareFailed(false);
    const r = await payShare(kind, name.trim() || null).catch(() => null);
    if (r) setMine(r);
    else setShareFailed(true);
    setBusy(false);
  };
  const cash = async () => {
    if (!payCash) return;
    setBusy(true);
    setCashSent(await payCash().catch(() => false));
    setBusy(false);
  };

  return (
    <section className="bill your-bill" aria-labelledby="your-bill-h">
      <h2 id="your-bill-h">{t("en", "yourBill.title", { number: bill.number })}</h2>
      {bill.revision > 1 && (
        <p className="hint">{t("en", "yourBill.revision", { n: bill.revision })}</p>
      )}
      <dl>
        <dt>{t("en", "yourBill.roomTime")}</dt>
        <dd>{money(bill.room_time_cents)}</dd>
        <dt>{t("en", "yourBill.drinks")}</dt>
        <dd>{money(bill.drinks_cents)}</dd>
        {bill.other_cents !== 0 && (
          <>
            <dt>{t("en", "yourBill.other")}</dt>
            <dd>{money(bill.other_cents)}</dd>
          </>
        )}
        <dt>{t("en", "yourBill.tax", { pct: bill.tax_pct ?? "" })}</dt>
        <dd>{money(bill.tax_cents)}</dd>
        {bill.gratuity_cents > 0 && (
          <>
            <dt>{t("en", "yourBill.gratuity", { pct: bill.gratuity_pct ?? "" })}</dt>
            <dd>{money(bill.gratuity_cents)}</dd>
          </>
        )}
        <dt>
          <strong>{t("en", "yourBill.total")}</strong>
        </dt>
        <dd>
          <strong>{money(bill.total_cents)}</strong>
        </dd>
        {bill.deposit_cents > 0 && (
          <>
            <dt>{t("en", "yourBill.deposit")}</dt>
            <dd>{money(-bill.deposit_cents)}</dd>
          </>
        )}
        {bill.payments.map((p, i) => (
          <Fragment key={i}>
            <dt>{paidLabel(p)}</dt>
            <dd>{money(-p.amount_cents)}</dd>
          </Fragment>
        ))}
        <dt>
          <strong>{t("en", "yourBill.due")}</strong>
        </dt>
        <dd>
          <strong>{money(Math.max(bill.amount_due_cents, 0))}</strong>
        </dd>
      </dl>

      {paid ? (
        <p className="notice" role="status">
          {t("en", "yourBill.paid")}
        </p>
      ) : (
        (payLink || payCash) && (
          <div className="ways" role="group" aria-labelledby="ways-h">
            <h3 id="ways-h">{t("en", "yourBill.ways")}</h3>
            {payOnFile && bill.on_file_request && bill.card_on_file && onFile !== "checking" && (
              <button type="button" disabled={busy} onClick={() => void confirmOnFile()}>
                {t("en", "yourBill.payOnFile", {
                  brand: BRANDS[bill.card_on_file.brand] ?? bill.card_on_file.brand,
                  last4: bill.card_on_file.last4,
                })}
              </button>
            )}
            {onFile === "checking" && <p role="status">{t("en", "payPage.checking")}</p>}
            {onFile === "declined" && <p role="alert">{t("en", "payPage.declined")}</p>}
            {payShare && bill.pay_share && (
              <div className="pay-share" role="group" aria-labelledby="share-h">
                <h3 id="share-h">{t("en", "payShare.title")}</h3>
                {!mine && (
                  <>
                    <label>
                      <span>{t("en", "payShare.name")}</span>
                      <input
                        value={name}
                        maxLength={40}
                        autoComplete="given-name"
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                    <button type="button" disabled={busy} onClick={() => void share("items")}>
                      {t("en", "payShare.mine")}
                    </button>
                    <button type="button" disabled={busy} onClick={() => void share("even")}>
                      {t("en", "payShare.even", { n: bill.pay_share.shares })}
                    </button>
                  </>
                )}
                {mine?.share && mine.share.state === "paid" && (
                  <p role="status">{t("en", "payShare.paid")}</p>
                )}
                {mine && mine.nothing_left && mine.share?.state !== "paid" && (
                  <p role="status">{t("en", "payShare.nothingLeft")}</p>
                )}
                {mine?.share && mine.url && (
                  <>
                    <p>
                      <strong>
                        {t("en", "payShare.yours", {
                          n: mine.share.share_no,
                          of: mine.share.shares,
                          amount: money(mine.share.share_cents),
                        })}
                      </strong>
                    </p>
                    <p className="hint">
                      {t("en", "payShare.includes", {
                        tax: money(mine.share.tax_cents),
                        gratuity: money(mine.share.gratuity_cents),
                      })}
                    </p>
                    {mine.share.amount_cents < mine.share.share_cents && (
                      <p className="notice">
                        {t("en", "payShare.less", { amount: money(mine.share.amount_cents) })}
                      </p>
                    )}
                    <a className="button" href={mine.url}>
                      {t("en", "payShare.pay", { amount: money(mine.share.amount_cents) })}
                    </a>
                  </>
                )}
                {shareFailed && <p role="alert">{t("en", "payShare.failed")}</p>}
              </div>
            )}
            {payLink && (
              <button type="button" disabled={busy} onClick={() => void another()}>
                {t("en", "yourBill.payAnotherWay")}
              </button>
            )}
            {payCash && (
              <button
                type="button"
                className="secondary"
                disabled={busy || cashSent}
                onClick={() => void cash()}
              >
                {t("en", "yourBill.payCash")}
              </button>
            )}
            {cashSent && <p role="status">{t("en", "yourBill.cashSent")}</p>}
            {error && <p role="alert">{t("en", "yourBill.failed")}</p>}
          </div>
        )
      )}
    </section>
  );
}

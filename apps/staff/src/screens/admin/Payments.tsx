import { useCallback, useEffect, useState } from "react";
import { cents, type MessageKey } from "@west4/shared";
import { UnmatchedPayments } from "../UnmatchedPayments.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { GoLive } from "./GoLive.js";

/**
 * Admin → Payments (M4-01; screens N37; Stripe setup 1, 2 and 7), the
 * owner's alone in a passkey session: the venue's Stripe account, "Connect
 * with Stripe" (Stripe's hosted onboarding, so bank details and IDs never
 * pass through us), a banner whenever Stripe needs more information, the
 * Stripe Dashboard, and payouts as Stripe lists them.
 */
interface Account {
  readonly account_id: string | null;
  readonly card_payments_enabled: boolean;
  readonly needs: readonly string[];
  readonly dashboard_url: string | null;
  readonly mode: "stripe" | "fake" | "off";
}
interface Payout {
  readonly id: string;
  readonly amount_cents: number;
  readonly arrival_date: string;
  readonly status: string;
}

export function Payments() {
  const { t, money, date } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [account, setAccount] = useState<Account | null>(null);
  const [payouts, setPayouts] = useState<readonly Payout[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const a = await api<Account>("GET", `/v1/venues/${venueId}/payments`);
    setAccount(a);
    if (a.account_id) {
      const p = await api<{ payouts: Payout[] }>("GET", `/v1/venues/${venueId}/payments/payouts`);
      setPayouts(p.payouts);
    } else setPayouts([]);
  }, [venueId]);

  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load]);

  const connect = async () => {
    setBusy(true);
    try {
      const link = await api<{ url: string }>("POST", `/v1/venues/${venueId}/payments/onboarding`);
      window.location.assign(link.url);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <section className="payments">
      <h2>{t("admin.section.payments")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {account === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          {account.mode !== "stripe" && <p className="small muted">{t("payments.fake")}</p>}
          {!account.account_id ? (
            <p className="muted">{t("payments.noAccount")}</p>
          ) : (
            <>
              {account.needs.length > 0 && (
                <div className="banner amber" role="alert">
                  <strong>{t("payments.needs")}</strong>
                  <p>{t("payments.needs.count", { count: account.needs.length })}</p>
                  <p className="small">{t("payments.needs.hint")}</p>
                </div>
              )}
              <p role="status">
                <strong>
                  {account.card_payments_enabled ? t("payments.enabled") : t("payments.notEnabled")}
                </strong>
              </p>
              <p className="small muted">{t("payments.account", { id: account.account_id })}</p>
              <div className="team-actions">
                {(!account.card_payments_enabled || account.needs.length > 0) && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void connect()}
                  >
                    {t("payments.connect")}
                  </button>
                )}
                {account.dashboard_url && (
                  <a
                    className="button secondary"
                    href={account.dashboard_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("payments.dashboard")}
                  </a>
                )}
              </div>
              {!account.card_payments_enabled && (
                <p className="small muted">{t("payments.connect.hint")}</p>
              )}
              <h3>{t("payments.payouts")}</h3>
              <p className="small muted">{t("payments.payouts.hint")}</p>
              {payouts === null ? (
                <p role="status">{t("shell.loading")}</p>
              ) : payouts.length === 0 ? (
                <p className="muted">{t("payments.noPayouts")}</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>{t("payments.payout.date")}</th>
                      <th>{t("payments.payout.amount")}</th>
                      <th>{t("payments.payout.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payouts.map((p) => (
                      <tr key={p.id}>
                        <td>{date(p.arrival_date)}</td>
                        <td>{money(cents(p.amount_cents))}</td>
                        <td>{t(`payments.payout.${p.status}` as MessageKey)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </>
      )}
      {account?.account_id && <GoLive venueId={venueId} />}
      {venueId && (
        <UnmatchedPayments
          venueId={venueId}
          timeZone={
            state.status === "signedIn" ? state.membership.venue.time_zone : "America/New_York"
          }
        />
      )}
    </section>
  );
}

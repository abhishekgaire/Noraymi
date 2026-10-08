import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Temporal, cents, type MessageKey } from "@west4/shared";
import { api } from "../../api.js";
import { useEvents } from "../../events.js";
import { useT } from "../../i18n.js";

/**
 * Our plan (M8-15; spec 03 · Plan billing). `PlanBanner` shows in Admin to
 * everyone who opens it: a failed plan payment, and once 14 days are up,
 * read-only Admin. `OurPlan` is the owner's part of Admin → Payments: the
 * plan, the rooms it counts, the next invoice and the card, with Stripe's
 * own pages for paying and changing the card.
 */
type PlanState = "none" | "ok" | "payment_failed" | "read_only";
interface PlanStatus {
  readonly state: PlanState;
  readonly payment_failed_at: string | null;
  readonly read_only_from: string | null;
}

export function usePlanStatus(venueId: string): PlanStatus | null {
  const { subscribe } = useEvents();
  const [status, setStatus] = useState<PlanStatus | null>(null);
  const load = useCallback(async () => {
    setStatus(await api<PlanStatus>("GET", `/v1/venues/${venueId}/plan/status`));
  }, [venueId]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "plan.updated"))
          load().catch(() => {});
      }),
    [subscribe, load],
  );
  return status;
}

const dayOf = (at: string, timeZone: string) =>
  Temporal.Instant.from(at).toZonedDateTimeISO(timeZone).toPlainDate();

export function PlanBanner({
  venueId,
  timeZone,
  owner,
}: {
  venueId: string;
  timeZone: string;
  owner: boolean;
}) {
  const { t, date, time } = useT();
  const status = usePlanStatus(venueId);
  if (!status || (status.state !== "payment_failed" && status.state !== "read_only")) return null;
  const readOnly = status.state === "read_only";
  return (
    <p
      className={`notice warn plan-banner${readOnly ? " read-only" : ""}`}
      role="alert"
      data-testid="plan-banner"
    >
      <span>
        {readOnly
          ? t("plan.banner.readOnly", {
              date: date(dayOf(status.payment_failed_at!, timeZone)),
            })
          : t("plan.banner.failed", {
              date: date(dayOf(status.read_only_from!, timeZone)),
              time: time(status.read_only_from!, timeZone),
            })}
      </span>{" "}
      {owner ? (
        <Link to="/admin/payments">{t("plan.banner.pay")}</Link>
      ) : (
        <span>{t("plan.banner.askOwner")}</span>
      )}
    </p>
  );
}

interface Plan {
  readonly plan: "bar" | "rooms" | "rooms_kitchen" | null;
  readonly status?: string;
  readonly state: PlanState;
  readonly room_quantity?: number;
  readonly rooms_now: number;
  readonly next_invoice?: { amount_cents: number; currency: string; date: number | null } | null;
  readonly payment_method?: { brand: string; last4: string } | null;
  readonly pay_url?: string | null;
  readonly reachable?: boolean;
}

export function OurPlan({ venueId, timeZone }: { venueId: string; timeZone: string }) {
  const { t, tn, money, date } = useT();
  const { subscribe } = useEvents();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    setPlan(await api<Plan>("GET", `/v1/venues/${venueId}/plan`));
  }, [venueId]);
  useEffect(() => {
    load().catch(() => setFailed(true));
  }, [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.some((e) => e.type === "plan.updated")) load().catch(() => setFailed(true));
      }),
    [subscribe, load],
  );
  const manage = async () => {
    setBusy(true);
    try {
      const link = await api<{ url: string }>("POST", `/v1/venues/${venueId}/plan/portal`);
      window.location.assign(link.url);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <section className="our-plan" aria-labelledby="our-plan-title">
      <h3 id="our-plan-title">{t("plan.title")}</h3>
      <p className="small muted">{t("plan.hint")}</p>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {plan === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : plan.plan === null ? (
        <p className="muted">{t("plan.none")}</p>
      ) : (
        <>
          <p role="status">
            <strong>{t(`plan.name.${plan.plan}` as MessageKey)}</strong>
            {" · "}
            {plan.state === "ok"
              ? plan.status === "canceled"
                ? t("plan.canceled")
                : t("plan.paid")
              : null}
          </p>
          {plan.plan !== "bar" && (
            <p className="small">{tn("plan.rooms", plan.room_quantity ?? plan.rooms_now)}</p>
          )}
          {plan.reachable === false ? (
            <p className="small muted">{t("plan.unreachable")}</p>
          ) : (
            <>
              {plan.next_invoice && plan.next_invoice.date !== null && (
                <p className="small">
                  {t("plan.next", {
                    amount: money(cents(plan.next_invoice.amount_cents)),
                    date: date(
                      dayOf(
                        Temporal.Instant.fromEpochMilliseconds(
                          plan.next_invoice.date * 1000,
                        ).toString(),
                        timeZone,
                      ),
                    ),
                  })}
                </p>
              )}
              <p className="small">
                {plan.payment_method
                  ? t("plan.card", {
                      brand: plan.payment_method.brand,
                      last4: plan.payment_method.last4,
                    })
                  : t("plan.noCard")}
              </p>
            </>
          )}
          <div className="team-actions">
            {plan.pay_url && (
              <a className="button primary" href={plan.pay_url} target="_blank" rel="noreferrer">
                {t("plan.payNow")}
              </a>
            )}
            <button
              type="button"
              className={plan.pay_url ? "secondary" : "primary"}
              disabled={busy}
              onClick={() => void manage()}
            >
              {t("plan.manage")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

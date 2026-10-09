import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Temporal, staffOrderWordsKey, type MessageKey } from "@west4/shared";
import { api, type ApiCallError } from "../api.js";
import { useClock, useVenueTime } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * Runs on every staff phone (M3-18; screens Staff notes 1 and 18; spec 10 ·
 * Words on every staff screen): orders Ready for a runner with their age, I've
 * got it ("On its way · Andy"), then Delivered ("Delivered · 10:52 · Andy"),
 * or Couldn't serve… with a reason, which goes back to the bar and the manager
 * on duty. Each run's ID line, and a runner can record an ID checked at the
 * room. People who run the bar see tonight's returns, and anyone who may cut
 * off is offered "Cut off Room 1?" on a "Someone looks too drunk" return; a
 * runner never is. Delivered charges nothing: Accept was the sale.
 */
interface Order {
  readonly id: string;
  readonly session_id: string | null;
  readonly room_id: string | null;
  readonly room_name: string | null;
  readonly party_size: number | null;
  readonly ids_checked: number;
  readonly status: string;
  readonly cancel_reason: string | null;
  readonly ready_at: string | null;
  readonly claimed_by: string | null;
  readonly claimed_by_name: string | null;
  readonly returned_reason: string | null;
  readonly returned_by_name: string | null;
  readonly return_resolution: string | null;
  readonly items: readonly {
    qty: number;
    name_snapshot: string;
    options: readonly { name: string }[];
  }[];
}

const REASONS = ["no_id", "too_drunk", "nobody_there", "other"] as const;

export function Runs() {
  const { t } = useT();
  const { state } = useSession();
  const { now } = useClock();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const me = signedIn?.me.user.id ?? "";
  const permissions = signedIn?.membership.permissions ?? [];
  const night = useVenueTime(
    signedIn?.membership.venue.time_zone ?? "America/New_York",
    signedIn?.membership.venue.day_cutover ?? "06:00",
  )?.businessDate.toString();
  const [runs, setRuns] = useState<readonly Order[] | null>(null);
  const [returned, setReturned] = useState<readonly Order[]>([]);
  const [returning, setReturning] = useState<string | null>(null);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("no_id");
  const [error, setError] = useState<string | null>(null);
  const seesReturns = permissions.includes("orders.accept");

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const [r, back] = await Promise.all([
        api<{ orders: Order[] }>("GET", `/v1/venues/${venueId}/orders?status=ready,on_the_way`),
        seesReturns && night
          ? api<{ orders: Order[] }>(
              "GET",
              `/v1/venues/${venueId}/orders?status=returned&business_date=${night}`,
            )
          : Promise.resolve({ orders: [] as Order[] }),
      ]);
      setRuns(r.orders);
      setReturned(back.orders.filter((o) => !o.return_resolution).reverse());
    } catch {
      setError(t("shell.error.cantReach"));
    }
  }, [venueId, seesReturns, night, t]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type.startsWith("order."))) void load();
      }),
    [subscribe, load],
  );

  const act = async (path: string, body: Record<string, unknown> = {}) => {
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}${path}`, body);
      await load();
      return true;
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("runs.failed"));
      await load();
      return false;
    }
  };
  const age = (iso: string | null) => {
    if (!iso || !now) return "0:00";
    const s = Math.max(
      0,
      Math.floor((now.epochMilliseconds - Temporal.Instant.from(iso).epochMilliseconds) / 1000),
    );
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const what = (o: Order) =>
    o.items
      .map((i) => [`${i.qty} × ${i.name_snapshot}`, ...i.options.map((x) => x.name)].join(" · "))
      .join(", ");
  const ids = (o: Order) =>
    o.party_size === null
      ? null
      : o.ids_checked >= o.party_size
        ? t("ids.chip", { checked: o.ids_checked, party: o.party_size })
        : `${t("ids.chip", { checked: o.ids_checked, party: o.party_size })} · ${t("barOrders.runnerChecks")}`;

  return (
    <section className="runs">
      <h1>{t("runs.title")}</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {runs === null ? (
        <p role="status">{t("shell.loading")}</p>
      ) : runs.length === 0 ? (
        <p className="muted">{t("runs.none")}</p>
      ) : (
        <ul className="run-list">
          {runs.map((o) => (
            <li
              key={o.id}
              className={
                o.party_size !== null && o.ids_checked < o.party_size ? "run ids-short" : "run"
              }
              aria-label={`${o.room_name ?? ""} · ${what(o)}`}
            >
              <p className="run-room">
                <strong>{o.room_name}</strong>
              </p>
              <p className="run-what" data-guest-text>
                {what(o)}
              </p>
              <p className="status">
                {t(staffOrderWordsKey(o), { age: age(o.ready_at), name: o.claimed_by_name ?? "" })}
              </p>
              {ids(o) && <p className="small run-ids">{ids(o)}</p>}
              <div className="team-actions">
                {o.status === "ready" && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void act(`/orders/${o.id}/claim`)}
                  >
                    {t("runs.claim")}
                  </button>
                )}
                {(o.status === "on_the_way" || o.status === "ready") &&
                  (o.status === "ready" || o.claimed_by === me) && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void act(`/orders/${o.id}/deliver`)}
                    >
                      {t("runs.deliver")}
                    </button>
                  )}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setReturning(returning === o.id ? null : o.id);
                    setReason("no_id");
                  }}
                >
                  {t("runs.return")}
                </button>
                {o.session_id && o.party_size !== null && o.ids_checked < o.party_size && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void act(`/sessions/${o.session_id}/id-checks`, {
                        method: "visual",
                        order_id: o.id,
                      })
                    }
                  >
                    {t("runs.recordId")}
                  </button>
                )}
              </div>
              {returning === o.id && (
                <form
                  className="invite-fields"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(`/orders/${o.id}/return`, { reason }).then(
                      (ok) => ok && setReturning(null),
                    );
                  }}
                >
                  <label>
                    <span>{t("runs.return.why")}</span>
                    <select
                      aria-label={t("runs.return.why")}
                      value={reason}
                      onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}
                    >
                      {REASONS.map((r) => (
                        <option key={r} value={r}>
                          {t(`orders.return.${r}` as MessageKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="primary">
                    {t("runs.return.send")}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {seesReturns && returned.length > 0 && (
        <section aria-labelledby="returned-h">
          <h2 id="returned-h">{t("runs.returned")}</h2>
          <ul className="run-list">
            {returned.map((o) => (
              <li key={o.id} className="run">
                <p>
                  <strong>{o.room_name}</strong> · <span data-guest-text>{what(o)}</span>
                </p>
                <p className="status">
                  {t("orders.staff.returned", {
                    reason: t(`orders.return.${o.returned_reason ?? "other"}` as MessageKey),
                    name: o.returned_by_name ?? "",
                  })}
                </p>
                {o.returned_reason === "too_drunk" &&
                  permissions.includes("cutoff.apply") &&
                  o.room_id && (
                    <Link className="button primary" to={`/room/${o.room_id}`}>
                      {t("runs.cutOff", { room: o.room_name ?? "" })}
                    </Link>
                  )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

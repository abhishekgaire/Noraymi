import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Temporal, staffOrderWordsKey, type MessageKey } from "@west4/shared";
import { api, type ApiCallError } from "../api.js";
import { useClock, useVenueTime } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { hiddenScreens } from "../navigation.js";
import { useSession } from "../session.js";
import { NotFound } from "./NotFound.js";
import { muteChime, useChimeMute } from "../chime.js";

/**
 * The bar orders screen (M3-15; screens Bar notes 1–6, 8 and 9; spec 10 ·
 * Room orders at the bar): five columns, Waiting for you (ringing and asked
 * to wait, oldest first, still aging), Being made, Ready for a runner,
 * Delivered tonight and Returned, each step only where the order's status
 * allows it, stamped with whoever is signed in. New orders show cyan, amber
 * at 2 minutes and pink at 4. The ID line, the out-tonight list with 86, and
 * "Ticket didn't print · Reprint". Live, with a 15-second check behind it.
 * Only while Bar screen & tickets is on.
 */
interface Order {
  readonly id: string;
  readonly room_name: string | null;
  readonly guest_name: string | null;
  readonly party_size: number | null;
  readonly ids_checked: number;
  readonly status: string;
  readonly cancel_reason: string | null;
  readonly decline_reason: string | null;
  readonly placed_at: string;
  readonly held_at: string | null;
  readonly accepted_at: string | null;
  readonly accepted_by_name: string | null;
  readonly ready_at: string | null;
  readonly claimed_by_name: string | null;
  readonly delivered_at: string | null;
  readonly delivered_by_name: string | null;
  readonly returned_reason: string | null;
  readonly returned_by_name: string | null;
  readonly return_resolution: string | null;
  readonly cancelled_by_name: string | null;
  readonly ticket_job_id: string | null;
  readonly ticket_status: string | null;
  readonly amount_cents: number;
  readonly items: readonly {
    qty: number;
    name_snapshot: string;
    options: readonly { name: string }[];
  }[];
}
interface MenuItem {
  readonly id: string;
  readonly name: string;
  readonly out_tonight: boolean;
}

const ALL = "ringing,held,accepted,ready,on_the_way,delivered,returned,cancelled";
const CHECK_MS = 15_000;
const NEW_S = 60;
const AMBER_S = 120;
const PINK_S = 240;

export function BarOrders() {
  const { t, money } = useT();
  const { state } = useSession();
  const { now } = useClock();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const cutover = signedIn?.membership.venue.day_cutover ?? "06:00";
  const [orders, setOrders] = useState<readonly Order[] | null>(null);
  const [failedJobs, setFailedJobs] = useState<ReadonlySet<string>>(new Set());
  const [items, setItems] = useState<readonly MenuItem[]>([]);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [eightySix, setEightySix] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const night = useVenueTime(timeZone, cutover)?.businessDate.toString();
  const muteLeft = useChimeMute();

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const [o, f, m] = await Promise.all([
        api<{ orders: Order[] }>(
          "GET",
          `/v1/venues/${venueId}/orders?status=${ALL}${night ? `&business_date=${night}` : ""}`,
        ),
        api<{ jobs: { id: string }[] }>("GET", `/v1/venues/${venueId}/print-jobs?status=failed`),
        api<{ categories: { items: MenuItem[] }[] }>("GET", `/v1/venues/${venueId}/menu`),
      ]);
      setOrders(o.orders);
      setFailedJobs(new Set(f.jobs.map((j) => j.id)));
      setItems(m.categories.flatMap((c) => c.items));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId, night]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), CHECK_MS);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some(
            (e) =>
              e.type.startsWith("order.") ||
              e.type.startsWith("print_job.") ||
              e.type === "menu.changed",
          )
        )
          void load();
      }),
    [subscribe, load],
  );

  if (signedIn && hiddenScreens(signedIn.membership.modules).has("barOrders")) return <NotFound />;

  const ageS = (iso: string | null) =>
    iso && now
      ? Math.max(
          0,
          Math.floor((now.epochMilliseconds - Temporal.Instant.from(iso).epochMilliseconds) / 1000),
        )
      : 0;
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const clock = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
          .format(new Date(iso))
          .replace(/ [AP]M$/, "")
      : "";
  const step = async (o: Order, s: string, body: Record<string, unknown> = {}) => {
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/orders/${o.id}/${s}`, body);
      await load();
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("barOrders.failed"));
      await load();
    }
  };
  const reprint = async (jobId: string) => {
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/print-jobs/${jobId}/reprint`);
      await load();
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("barOrders.failed"));
    }
  };
  const setOut = async (itemId: string, out: boolean) => {
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/menu/items/${itemId}/out-tonight`, { out });
      setEightySix("");
      await load();
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("barOrders.failed"));
    }
  };

  const list = orders ?? [];
  const waiting = list.filter((o) => o.status === "ringing" || o.status === "held");
  const making = list.filter((o) => o.status === "accepted");
  const ready = list.filter((o) => o.status === "ready" || o.status === "on_the_way");
  const delivered = list.filter((o) => o.status === "delivered").reverse();
  const returned = list
    .filter((o) => o.status === "returned" || o.status === "cancelled")
    .reverse();

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
  const ticketLine = (o: Order) => {
    if (o.ticket_job_id && failedJobs.has(o.ticket_job_id))
      return (
        <p className="ticket-failed">
          {t("barOrders.ticket.failed")}{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => void reprint(o.ticket_job_id!)}
          >
            {t("alert.reprint")}
          </button>
        </p>
      );
    return null;
  };
  const card = (o: Order, body: ReactNode, tone = "") => (
    <li key={o.id} className={`bar-order ${tone}`} aria-label={`${o.room_name ?? ""} · ${what(o)}`}>
      <p className="bar-order-room">
        <strong>{o.room_name}</strong>
        {o.guest_name && o.party_size !== null && (
          <span className="muted">
            {" "}
            · {t("board.party", { name: o.guest_name, party: o.party_size })}
          </span>
        )}
      </p>
      <p data-guest-text>
        {what(o)} · {money(o.amount_cents as never)}
      </p>
      {ids(o) && <p className="small">{ids(o)}</p>}
      {body}
      {ticketLine(o)}
    </li>
  );

  return (
    <section className="bar-orders">
      <h1>{t("menu.barOrders")}</h1>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {orders === null ? (
        <p role="status">{t("shell.loading")}</p>
      ) : (
        <div className="bar-columns">
          <section aria-labelledby="col-waiting">
            <h2 id="col-waiting">{t("barOrders.col.waiting")}</h2>
            {waiting.length === 0 && <p className="muted small">{t("barOrders.none")}</p>}
            <ul>
              {waiting.map((o) => {
                const age = ageS(o.placed_at);
                const tone =
                  age >= PINK_S ? "pink" : age >= AMBER_S ? "amber" : age < NEW_S ? "new" : "";
                return card(
                  o,
                  <>
                    <p className="status">{t(staffOrderWordsKey(o), { age: mmss(age) })}</p>
                    <div className="team-actions">
                      <button
                        type="button"
                        className="primary"
                        onClick={() => void step(o, "accept")}
                      >
                        {t("barOrders.accept")}
                      </button>
                      {o.status === "ringing" && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void step(o, "hold")}
                        >
                          {t("barOrders.hold")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setDeclining(o.id);
                          setReason("");
                        }}
                      >
                        {t("barOrders.decline")}
                      </button>
                    </div>
                    {declining === o.id && (
                      <form
                        className="invite-fields"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void step(o, "decline", { reason: reason.trim() }).then(() =>
                            setDeclining(null),
                          );
                        }}
                      >
                        <label>
                          <span>{t("barOrders.decline.reason")}</span>
                          <input
                            value={reason}
                            required
                            maxLength={200}
                            onChange={(e) => setReason(e.target.value)}
                          />
                        </label>
                        <button type="submit" className="primary" disabled={!reason.trim()}>
                          {t("barOrders.decline.send")}
                        </button>
                      </form>
                    )}
                  </>,
                  tone,
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="col-making">
            <h2 id="col-making">{t("barOrders.col.making")}</h2>
            <ul>
              {making.map((o) =>
                card(
                  o,
                  <>
                    <p className="status">
                      {t("barOrders.accepted", {
                        name: o.accepted_by_name ?? "",
                        time: clock(o.accepted_at),
                        room: o.room_name ?? "",
                        ticket: t(
                          `barOrders.ticket.${o.ticket_status === "printed" ? "printed" : o.ticket_status === "failed" ? "notPrinted" : "printing"}` as MessageKey,
                        ),
                      })}
                    </p>
                    <button type="button" className="primary" onClick={() => void step(o, "ready")}>
                      {t("barOrders.ready")}
                    </button>
                  </>,
                ),
              )}
            </ul>
          </section>

          <section aria-labelledby="col-ready">
            <h2 id="col-ready">{t("barOrders.col.ready")}</h2>
            <ul>
              {ready.map((o) =>
                card(
                  o,
                  <p className="status">
                    {t(staffOrderWordsKey(o), {
                      age: mmss(ageS(o.ready_at)),
                      name: o.claimed_by_name ?? "",
                    })}
                  </p>,
                ),
              )}
            </ul>
          </section>

          <section aria-labelledby="col-delivered">
            <h2 id="col-delivered">{t("barOrders.col.delivered")}</h2>
            <ul>
              {delivered.map((o) =>
                card(
                  o,
                  <p className="status">
                    {t("orders.staff.delivered", {
                      time: clock(o.delivered_at),
                      name: o.delivered_by_name ?? t("barOrders.someone"),
                    })}
                  </p>,
                ),
              )}
            </ul>
          </section>

          <section aria-labelledby="col-returned">
            <h2 id="col-returned">{t("barOrders.col.returned")}</h2>
            <ul>
              {returned.map((o) =>
                card(
                  o,
                  <>
                    <p className="status">
                      {o.status === "returned"
                        ? t("orders.staff.returned", {
                            reason: t(
                              `orders.return.${o.returned_reason ?? "other"}` as MessageKey,
                            ),
                            name: o.returned_by_name ?? "",
                          })
                        : t(staffOrderWordsKey(o), {
                            reason: o.decline_reason ?? "",
                            name:
                              o.cancel_reason === "cut_off"
                                ? (o.cancelled_by_name ?? "").split(" ")[0]!
                                : (o.cancelled_by_name ?? ""),
                          })}
                    </p>
                    {o.status === "returned" && !o.return_resolution && (
                      <div className="team-actions">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void step(o, "resolve", { resolution: "void_not_made" })}
                        >
                          {t("barOrders.voidNotMade")}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void step(o, "resolve", { resolution: "void_made" })}
                        >
                          {t("barOrders.voidMade")}
                        </button>
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void step(o, "resolve", { resolution: "remake" })}
                        >
                          {t("barOrders.remake")}
                        </button>
                      </div>
                    )}
                  </>,
                ),
              )}
            </ul>
          </section>
        </div>
      )}

      <section className="out-tonight" aria-labelledby="out-h">
        <h2 id="out-h">{t("barOrders.out")}</h2>
        <ul className="faults">
          {items
            .filter((i) => i.out_tonight)
            .map((i) => (
              <li key={i.id}>
                <span data-guest-text>{i.name}</span>{" "}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void setOut(i.id, false)}
                >
                  {t("menuAdmin.86.undo")}
                </button>
              </li>
            ))}
        </ul>
        <form
          className="actions"
          onSubmit={(e) => {
            e.preventDefault();
            const item = items.find((i) => i.name.toLowerCase() === eightySix.trim().toLowerCase());
            if (item) void setOut(item.id, true);
            else setError(t("barOrders.86.unknown"));
          }}
        >
          <label className="grow">
            <span>{t("barOrders.86.label")}</span>
            <input
              list="bar-menu"
              value={eightySix}
              onChange={(e) => setEightySix(e.target.value)}
            />
          </label>
          <datalist id="bar-menu">
            {items
              .filter((i) => !i.out_tonight)
              .map((i) => (
                <option key={i.id} value={i.name} />
              ))}
          </datalist>
          <button type="submit" className="secondary" disabled={!eightySix.trim()}>
            {t("menuAdmin.86")}
          </button>
        </form>
      </section>

      <p className="small muted footer-line">
        {t("barOrders.footer")}{" "}
        <button
          type="button"
          className="secondary"
          disabled={muteLeft > 0}
          onClick={() => muteChime(60)}
        >
          {muteLeft > 0 ? t("barOrders.muted", { s: muteLeft }) : t("barOrders.mute")}
        </button>
      </p>
    </section>
  );
}

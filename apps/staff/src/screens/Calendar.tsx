import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Temporal } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useEvents } from "../events.js";
import "./desk.css";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * DeskCalendar and the phone's Calendar (M2-33; screens DeskCalendar and
 * Calendar): the days ahead from "Tonight" on the venue's clock, each day's
 * bookings, a new staff booking that shows the room and how long it's free and
 * refuses overlapping or past slots, and blocking a date with the bookings it
 * affects.
 */
interface Day {
  readonly business_date: string;
  readonly bookings: number;
  readonly closure: "closed" | "special" | null;
}
interface Booking {
  readonly id: string;
  readonly guest_name: string;
  readonly party_size: number;
  readonly room_name: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly deposit_cents: number;
  readonly status: string;
  readonly running_late_until: string | null;
}
interface FreeRoom {
  readonly room_id: string;
  readonly name: string;
  readonly free_now: boolean;
  readonly until: string | null;
  readonly all_night: boolean;
}

export function Calendar() {
  const { t, money, time, locale } = useT();
  const { state } = useSession();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const cutover = signedIn?.membership.venue.day_cutover ?? "06:00";
  const canBook = signedIn?.membership.permissions.includes("bookings.manage") ?? false;
  const canBlock = signedIn?.membership.permissions.includes("admin.access") ?? false;
  const [days, setDays] = useState<readonly Day[] | null>(null);
  const [tonight, setTonight] = useState("");
  const [day, setDay] = useState("");
  const [bookings, setBookings] = useState<readonly Booking[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [party, setParty] = useState("");
  const [at, setAt] = useState("");
  const [hours, setHours] = useState("2");
  const [roomId, setRoomId] = useState("");
  const [free, setFree] = useState<readonly FreeRoom[]>([]);
  // P-08: the Month view, a month grid of business dates with each one's booking count.
  const [view, setView] = useState<"days" | "month">("days");
  const [month, setMonth] = useState("");
  const [monthDays, setMonthDays] = useState<readonly Day[] | null>(null);

  const loadDays = useCallback(async () => {
    try {
      const r = await api<{ tonight: string; days: Day[] }>(
        "GET",
        `/v1/venues/${venueId}/bookings/days?days=14`,
      );
      setDays(r.days);
      setTonight(r.tonight);
      setDay((d) => d || r.tonight);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  const loadDay = useCallback(async () => {
    if (!day) return;
    try {
      const r = await api<{ bookings: Booking[] }>(
        "GET",
        `/v1/venues/${venueId}/bookings?business_date=${day}`,
      );
      setBookings(r.bookings.filter((b) => b.status !== "cancelled" && b.status !== "no_show"));
    } catch {
      setFailed(true);
    }
  }, [venueId, day]);
  const loadMonth = useCallback(async () => {
    if (!month || view !== "month") return;
    const first = Temporal.PlainYearMonth.from(month);
    try {
      const r = await api<{ days: Day[] }>(
        "GET",
        `/v1/venues/${venueId}/bookings/days?from=${first.toPlainDate({ day: 1 }).toString()}&days=${first.daysInMonth}`,
      );
      setMonthDays(r.days);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId, month, view]);
  useEffect(() => {
    if (venueId) void loadDays();
  }, [venueId, loadDays]);
  useEffect(() => void loadDay(), [loadDay]);
  useEffect(() => {
    if (tonight) setMonth((m) => m || tonight.slice(0, 7));
  }, [tonight]);
  useEffect(() => void loadMonth(), [loadMonth]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "booking.updated")) {
          void loadDays();
          void loadDay();
          void loadMonth();
        }
      }),
    [subscribe, loadDays, loadDay, loadMonth],
  );
  /** A business date before tonight: it can't take a new booking (P-08) or be blocked. */
  const isPast = (d: string) =>
    tonight !== "" && Temporal.PlainDate.compare(Temporal.PlainDate.from(d), tonight) < 0;

  /** The instant a wall-clock time on the selected business date means (after the cutover is the next day). */
  const instantOf = (date: string, hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number) as [number, number];
    let d = Temporal.PlainDate.from(date);
    if (h * 60 + m < Number(cutover.slice(0, 2)) * 60) d = d.add({ days: 1 });
    return Temporal.ZonedDateTime.from({
      timeZone,
      year: d.year,
      month: d.month,
      day: d.day,
      hour: h,
      minute: m,
    }).toInstant();
  };

  // The rooms and how long each is free, at the chosen time.
  useEffect(() => {
    if (!adding || !at || !day) return;
    let live = true;
    void api<{ rooms: FreeRoom[] }>(
      "GET",
      `/v1/venues/${venueId}/rooms/availability?at=${encodeURIComponent(instantOf(day, at).toString())}`,
    )
      .then((r) => live && setFree(r.rooms.filter((x) => x.free_now)))
      .catch(() => live && setFree([]));
    return () => {
      live = false;
    };
  }, [adding, at, day, venueId]);

  const dayLabel = (d: string) => {
    const date = Temporal.PlainDate.from(d);
    const words = date.toLocaleString(locale, { weekday: "short", month: "short", day: "numeric" });
    return d === tonight ? t("calendar.tonightDay", { date: words }) : words;
  };
  const hoursOf = (b: Booking) =>
    Math.round(((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 3_600_000) * 10) / 10;

  const book = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const digits = phone.replace(/\D/g, "");
    const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : null;
    try {
      await api("POST", `/v1/venues/${venueId}/bookings`, {
        guest: { name: name.trim(), ...(e164 ? { phone_e164: e164 } : {}) },
        party_size: Number(party),
        business_date: day,
        time: at,
        hours: Number(hours),
        ...(roomId ? { room_id: roomId } : {}),
      });
      setAdding(false);
      setDone(t("calendar.booked", { name: name.trim() }));
      setName("");
      setPhone("");
      setParty("");
      setAt("");
      setRoomId("");
      await Promise.all([loadDays(), loadDay(), loadMonth()]);
    } catch (err) {
      const reason = err instanceof ApiCallError ? err.details["reason"] : undefined;
      setError(
        reason === "past"
          ? t("calendar.past")
          : err instanceof ApiCallError && err.code === "room_not_free"
            ? t("calendar.notFree")
            : t("calendar.failed"),
      );
    }
  };
  const block = async (cancelAll = false) => {
    setError(null);
    try {
      const made = await api<{ cancelled?: unknown[] }>("POST", `/v1/venues/${venueId}/closures`, {
        date: day,
        kind: "closed",
        // M5-12: "Cancel and refund all": the venue cancels each booking and refunds it in full.
        ...(cancelAll ? { cancel_bookings: true } : {}),
      });
      setBlocking(false);
      setDone(
        cancelAll
          ? t("calendar.cancelledDone", {
              date: dayLabel(day),
              count: made.cancelled?.length ?? 0,
            })
          : t("calendar.blockedDone", { date: dayLabel(day) }),
      );
      await Promise.all([loadDays(), loadMonth()]);
    } catch {
      setError(t("calendar.failed"));
    }
  };

  // M5-13: a staff or big-party booking's payment link: the room held until `pending_until`, and the text.
  const sendLink = async (b: Booking) => {
    setError(null);
    try {
      const sent = await api<{ pending_until: string; texted: boolean }>(
        "POST",
        `/v1/venues/${venueId}/bookings/${b.id}/payment-link`,
      );
      setDone(
        t(sent.texted ? "calendar.linkSent" : "calendar.linkNotTexted", {
          name: b.guest_name,
          time: time(sent.pending_until, timeZone),
        }),
      );
    } catch {
      setError(t("calendar.failed"));
    }
  };

  const current = [...(days ?? []), ...(monthDays ?? [])].find((d) => d.business_date === day);
  const past = day !== "" && isPast(day);
  const pick = (d: string) => {
    setDay(d);
    setBlocking(false);
    if (isPast(d)) setAdding(false);
  };
  const shiftMonth = (by: number) => {
    setMonthDays(null);
    setMonth((m) => Temporal.PlainYearMonth.from(m).add({ months: by }).toString());
  };
  const dayCount = (d: Day) =>
    d.closure === "closed" ? t("calendar.closed") : t("calendar.count", { count: d.bookings });

  /** The month grid: weeks from Sunday, each business date with its booking count, tonight marked. */
  const monthGrid = () => {
    if (!month) return null;
    const ym = Temporal.PlainYearMonth.from(month);
    const first = ym.toPlainDate({ day: 1 });
    const lead = first.dayOfWeek % 7;
    // 2026-09-27 is a Sunday: the weekday names in the screen's language, Sunday first.
    const sunday = Temporal.PlainDate.from("2026-09-27");
    return (
      <div className="month-view">
        <div className="month-nav">
          <button
            type="button"
            className="secondary"
            aria-label={t("calendar.prevMonth")}
            onClick={() => shiftMonth(-1)}
          >
            ‹
          </button>
          <h2 aria-live="polite">
            {first.toLocaleString(locale, { month: "long", year: "numeric" })}
          </h2>
          <button
            type="button"
            className="secondary"
            aria-label={t("calendar.nextMonth")}
            onClick={() => shiftMonth(1)}
          >
            ›
          </button>
        </div>
        {monthDays === null && !failed && <p role="status">{t("shell.loading")}</p>}
        <div className="month-grid" role="group" aria-label={t("calendar.monthGrid")}>
          {Array.from({ length: 7 }, (_, i) => (
            <span key={`w${i}`} className="month-weekday" aria-hidden="true">
              {sunday.add({ days: i }).toLocaleString(locale, { weekday: "short" })}
            </span>
          ))}
          {Array.from({ length: lead }, (_, i) => (
            <span key={`l${i}`} aria-hidden="true" />
          ))}
          {Array.from({ length: ym.daysInMonth }, (_, i) => {
            const date = first.add({ days: i });
            const d = date.toString();
            const info = monthDays?.find((x) => x.business_date === d);
            const words = date.toLocaleString(locale, {
              weekday: "long",
              month: "long",
              day: "numeric",
            });
            return (
              <button
                key={d}
                type="button"
                className={[
                  "month-day",
                  d === tonight ? "today" : "",
                  isPast(d) ? "past" : "",
                  info?.closure === "closed"
                    ? "day-blocked"
                    : (info?.bookings ?? 0) > 0
                      ? "day-busy"
                      : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-pressed={d === day}
                aria-current={d === tonight ? "date" : undefined}
                aria-label={
                  info
                    ? `${d === tonight ? t("calendar.tonightDay", { date: words }) : words} · ${dayCount(info)}`
                    : words
                }
                onClick={() => pick(d)}
              >
                <span className="month-num">{date.day}</span>
                {info && info.closure !== "closed" && info.bookings > 0 && (
                  <span className="month-count">{info.bookings}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <section className="screen calendar desk">
      <div className="desk-head">
        <h1>{t("menu.calendar")}</h1>
        <div className="actions" role="group" aria-label={t("calendar.view")}>
          <button
            type="button"
            className={view === "days" ? "primary" : "secondary"}
            aria-pressed={view === "days"}
            onClick={() => setView("days")}
          >
            {t("calendar.viewDays")}
          </button>
          <button
            type="button"
            className={view === "month" ? "primary" : "secondary"}
            aria-pressed={view === "month"}
            onClick={() => setView("month")}
          >
            {t("calendar.viewMonth")}
          </button>
        </div>
      </div>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {done && (
        <p className="notice" role="status">
          {done}
        </p>
      )}
      {days === null && !failed && <p role="status">{t("shell.loading")}</p>}
      <div className="desk-cols two">
        {view === "month" ? (
          monthGrid()
        ) : (
          <ol className="days" aria-label={t("calendar.days")}>
            {days?.map((d) => (
              <li key={d.business_date}>
                <button
                  type="button"
                  className={[
                    "conversation",
                    d.business_date === day ? "current" : "",
                    d.closure === "closed" ? "day-blocked" : d.bookings > 0 ? "day-busy" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-pressed={d.business_date === day}
                  onClick={() => pick(d.business_date)}
                >
                  <span>{dayLabel(d.business_date)}</span>
                  <span className="small day-count">{dayCount(d)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        {day && (
          <div className="desk-card day-side">
            <h2>{dayLabel(day)}</h2>
            <p className="small muted">{past ? t("calendar.pastDay") : t("calendar.holds")}</p>
            <div className="actions">
              {canBook && !past && current?.closure !== "closed" && (
                <button type="button" className="primary" onClick={() => setAdding(true)}>
                  {t("calendar.new")}
                </button>
              )}
              {canBlock && !past && current?.closure !== "closed" && (
                <button type="button" className="secondary" onClick={() => setBlocking(true)}>
                  {t("calendar.block")}
                </button>
              )}
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {blocking && !past && (
              <div className="sheet" role="dialog" aria-label={t("calendar.block")}>
                <h2>{t("calendar.blockTitle", { date: dayLabel(day) })}</h2>
                <p>{t("calendar.affects", { count: bookings?.length ?? 0 })}</p>
                <ul className="bookings-list">
                  {bookings?.map((b) => (
                    <li key={b.id} className="small">
                      {t("phone.row", {
                        time: time(b.starts_at, timeZone),
                        name: b.guest_name,
                        party: b.party_size,
                        room: b.room_name,
                        hours: hoursOf(b),
                        deposit: money(b.deposit_cents as never),
                      })}
                    </li>
                  ))}
                </ul>
                <div className="actions">
                  {(bookings?.length ?? 0) > 0 && (
                    <button type="button" className="primary" onClick={() => void block(true)}>
                      {t("calendar.cancelRefundAll")}
                    </button>
                  )}
                  <button
                    type="button"
                    className={(bookings?.length ?? 0) > 0 ? "secondary" : "primary"}
                    onClick={() => void block()}
                  >
                    {t("calendar.blockIt")}
                  </button>
                  <button type="button" onClick={() => setBlocking(false)}>
                    {t("checkIn.cancel")}
                  </button>
                </div>
              </div>
            )}
            {adding && !past && (
              <form className="sheet" aria-label={t("calendar.new")} onSubmit={(e) => void book(e)}>
                <h2>{t("calendar.new")}</h2>
                <label>
                  {t("waitlist.name")}
                  <input
                    value={name}
                    maxLength={80}
                    required
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  {t("waitlist.mobile")}
                  <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </label>
                <label>
                  {t("checkIn.party")}
                  <input
                    type="number"
                    min={1}
                    value={party}
                    required
                    onChange={(e) => setParty(e.target.value)}
                  />
                </label>
                <label>
                  {t("calendar.time")}
                  <input type="time" value={at} required onChange={(e) => setAt(e.target.value)} />
                </label>
                <label>
                  {t("calendar.hours")}
                  <select value={hours} onChange={(e) => setHours(e.target.value)}>
                    {["1", "1.5", "2", "2.5", "3", "4"].map((h) => (
                      <option key={h} value={h}>
                        {t("calendar.hoursOption", { hours: h })}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("calendar.room")}
                  <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                    <option value="">{t("calendar.anyRoom")}</option>
                    {free.map((r) => (
                      <option key={r.room_id} value={r.room_id}>
                        {r.all_night || !r.until
                          ? t("move.freeAllNight", { room: r.name })
                          : t("move.freeUntil", { room: r.name, time: time(r.until, timeZone) })}
                      </option>
                    ))}
                    {/* A room not free then can still be chosen: the API refuses the overlap. */}
                  </select>
                </label>
                <div className="actions">
                  <button
                    type="submit"
                    className="primary"
                    disabled={!name.trim() || !party || !at}
                  >
                    {t("calendar.book")}
                  </button>
                  <button type="button" onClick={() => setAdding(false)}>
                    {t("checkIn.cancel")}
                  </button>
                </div>
              </form>
            )}
            {bookings === null ? (
              <p role="status">{t("shell.loading")}</p>
            ) : bookings.length === 0 ? (
              <p className="empty">{t("calendar.none")}</p>
            ) : (
              <ol className="bookings-list" aria-label={t("calendar.dayBookings")}>
                {bookings.map((b) => (
                  <li key={b.id} aria-label={b.guest_name}>
                    {t("phone.row", {
                      time: time(b.starts_at, timeZone),
                      name: b.guest_name,
                      party: b.party_size,
                      room: b.room_name,
                      hours: hoursOf(b),
                      deposit: money(b.deposit_cents as never),
                    })}
                    {canBook && b.status === "pending" && (
                      <button type="button" className="secondary" onClick={() => void sendLink(b)}>
                        {t("calendar.sendLink")}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

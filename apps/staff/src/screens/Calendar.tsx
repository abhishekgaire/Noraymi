import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Temporal } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useEvents } from "../events.js";
import "./desk.css";
import { useT } from "../i18n.js";
import { Dialog } from "../layout/Dialog.js";
import { useSession } from "../session.js";
import { useClock } from "../clock.js";
import { useConnection } from "../connection.js";
import { usE164 } from "./CheckInSheet.js";
import { nextHalfHour } from "./booking-time.js";
import { LengthChips, PartyChips, RoomChips, type RoomChoice } from "./sheet-chips.js";

/**
 * DeskCalendar and the phone's Calendar (M2-33; screens DeskCalendar and
 * Calendar): the days ahead from "Tonight" on the venue's clock, each day's
 * bookings, a new staff booking that shows the room and how long it's free and
 * refuses overlapping or past slots, and blocking a date with the bookings it
 * affects. New booking (U-13, D133) books like checking in: the check-in sheet's party and
 * length chips, its phone check, the time defaulting to the next half hour, and only the rooms
 * the server says fit the party and are free for the whole booking.
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
/** `GET /rooms/free`: the rooms that fit the party and are free for the booking, smallest first. */
interface FreeRooms {
  readonly past_close: boolean;
  readonly rooms: readonly {
    readonly room_id: string;
    readonly name: string;
    readonly capacity_min: number;
    readonly capacity_max: number;
  }[];
}
type RoomsState =
  | { readonly kind: "idle" | "loading" | "failed" }
  | { readonly kind: "ready"; readonly pastClose: boolean; readonly rooms: readonly RoomChoice[] };

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
  // U-13: the check-in sheet's chips; no party until one is tapped, 2 hours, the next half hour.
  const [party, setParty] = useState<number | null>(null);
  const [moreParty, setMoreParty] = useState(false);
  const [at, setAt] = useState("");
  const [minutes, setMinutes] = useState(120);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [free, setFree] = useState<RoomsState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const { now } = useClock();
  const { connected } = useEvents();
  const connection = useConnection();
  const offline = !connected || connection.kind === "offline";
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

  // The time starts at the next half hour on the venue's clock (U-13).
  useEffect(() => {
    if (adding && !at && now) setAt(nextHalfHour(now, timeZone));
  }, [adding, at, now, timeZone]);
  const startAt = adding && /^\d{2}:\d{2}$/.test(at) && day ? instantOf(day, at) : null;
  const startPast = startAt !== null && now !== null && Temporal.Instant.compare(startAt, now) < 0;

  // U-13: the rooms that fit the party and are free from the start for the whole length, from
  // the server (the rule that assigns a booking its room), smallest first.
  const startIso = startAt?.toString() ?? "";
  useEffect(() => {
    if (!startIso || party === null || startPast) {
      setFree({ kind: "idle" });
      return;
    }
    let live = true;
    setFree({ kind: "loading" });
    const q = new URLSearchParams({
      party: String(party),
      from: startIso,
      minutes: String(minutes),
    });
    api<FreeRooms>("GET", `/v1/venues/${venueId}/rooms/free?${q.toString()}`)
      .then((r) => {
        if (live)
          setFree({
            kind: "ready",
            pastClose: r.past_close,
            rooms: r.rooms.map((x) => ({ ...x, ok: true, why: null, until: null })),
          });
      })
      .catch(() => {
        if (live) setFree({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, [startIso, party, minutes, startPast, venueId]);
  const fitting = free.kind === "ready" ? free.rooms : [];
  // The room staff tapped, or the first that fits: the one the server would give the booking.
  const chosenRoom =
    fitting.find((r) => r.room_id === roomId)?.room_id ?? fitting[0]?.room_id ?? null;

  const dayLabel = (d: string) => {
    const date = Temporal.PlainDate.from(d);
    const words = date.toLocaleString(locale, { weekday: "short", month: "short", day: "numeric" });
    return d === tonight ? t("calendar.tonightDay", { date: words }) : words;
  };
  const hoursOf = (b: Booking) =>
    Math.round(((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 3_600_000) * 10) / 10;

  const closeForm = () => {
    setAdding(false);
    setError(null);
    setName("");
    setPhone("");
    setParty(null);
    setMoreParty(false);
    setAt("");
    setMinutes(120);
    setRoomId(null);
  };
  const book = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // The check-in sheet's phone check (U-13): a phone that isn't one says so, never dropped.
    const e164 = phone.trim() ? usE164(phone) : null;
    if (phone.trim() && !e164) {
      setError(t("checkIn.phoneInvalid"));
      return;
    }
    if (party === null || chosenRoom === null) return;
    setBusy(true);
    try {
      await api("POST", `/v1/venues/${venueId}/bookings`, {
        guest: { name: name.trim(), ...(e164 ? { phone_e164: e164 } : {}) },
        party_size: party,
        business_date: day,
        time: at,
        hours: minutes / 60,
        room_id: chosenRoom,
      });
      const who = name.trim();
      closeForm();
      setDone(t("calendar.booked", { name: who }));
      await Promise.all([loadDays(), loadDay(), loadMonth()]);
    } catch (err) {
      const reason = err instanceof ApiCallError ? err.details["reason"] : undefined;
      setError(
        reason === "past"
          ? t("calendar.past")
          : reason === "past_close"
            ? t("calendar.pastClose")
            : reason === "off_grid"
              ? t("calendar.offGrid")
              : err instanceof ApiCallError && err.code === "room_not_free"
                ? t("calendar.notFree")
                : t("calendar.failed"),
      );
    } finally {
      setBusy(false);
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
    if (isPast(d)) closeForm();
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
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    setDone(null);
                    setAdding(true);
                  }}
                >
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
              <Dialog onClose={() => setBlocking(false)} label={t("calendar.block")}>
                <div className="sheet">
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
              </Dialog>
            )}
            {adding && !past && (
              <form
                className="sheet checkin-sheet calendar-booking"
                aria-label={t("calendar.new")}
                onSubmit={(e) => void book(e)}
              >
                <h2>{t("calendar.new")}</h2>
                {offline && (
                  <p className="error" role="status">
                    {t("calendar.offline")}
                  </p>
                )}
                {/* U-13: the time, the check-in sheet's party and length chips, then the rooms that fit. */}
                <label>
                  {t("calendar.time")}
                  <input
                    type="time"
                    step={1800}
                    value={at}
                    required
                    onChange={(e) => setAt(e.target.value)}
                  />
                </label>
                {startPast && (
                  <span className="small error" role="status">
                    {t("calendar.past")}
                  </span>
                )}
                <fieldset className="checkin-field">
                  <legend>{t("checkIn.party")}</legend>
                  <PartyChips
                    party={party}
                    more={moreParty}
                    onParty={(n, typed) => {
                      if (!typed) setMoreParty(false);
                      setParty(n);
                    }}
                    onMore={() => {
                      setMoreParty(true);
                      setParty((p) => p ?? 11);
                    }}
                  />
                </fieldset>
                <fieldset className="checkin-field">
                  <legend>{t("calendar.hours")}</legend>
                  <LengthChips minutes={minutes} onMinutes={setMinutes} />
                </fieldset>
                <fieldset className="checkin-field">
                  <legend>{t("calendar.room")}</legend>
                  {party === null ? (
                    <span className="small muted">{t("calendar.pickParty")}</span>
                  ) : free.kind === "loading" ? (
                    <span className="small" role="status">
                      {t("shell.loading")}
                    </span>
                  ) : free.kind === "failed" ? (
                    <span className="small error" role="alert">
                      {t("shell.error.cantReach")}
                    </span>
                  ) : free.kind === "ready" && free.pastClose ? (
                    <span className="small error" role="status">
                      {t("calendar.pastClose")}
                    </span>
                  ) : free.kind === "ready" && fitting.length === 0 ? (
                    <span className="small error" role="status">
                      {t("calendar.noRoomFits", { party })}
                    </span>
                  ) : (
                    <RoomChips
                      rooms={fitting}
                      selected={chosenRoom}
                      timeZone={timeZone}
                      onPick={setRoomId}
                    />
                  )}
                </fieldset>
                <label>
                  {t("checkIn.guestName")}
                  <input
                    value={name}
                    maxLength={80}
                    required
                    autoComplete="off"
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  {t("checkIn.guestPhone")}
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="off"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>
                <div className="actions">
                  <button
                    type="submit"
                    className="primary"
                    disabled={
                      busy ||
                      offline ||
                      !name.trim() ||
                      party === null ||
                      startAt === null ||
                      startPast ||
                      chosenRoom === null
                    }
                  >
                    {t("calendar.book")}
                  </button>
                  <button type="button" className="secondary" onClick={closeForm}>
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

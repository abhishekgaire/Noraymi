import { useCallback, useEffect, useState } from "react";
import { Temporal } from "@west4/shared";
import { api } from "../api.js";
import { useClock } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import { CheckInSheet, type SheetTarget } from "./CheckInSheet.js";
import { Link } from "react-router";

/**
 * The staff phone's Tonight (M2-32; screens Staff): tonight's bookings in time
 * order, each opening a Details sheet whose actions follow its status; the
 * room-by-room view, walk-ins included; and the counts.
 */
interface Booking {
  readonly id: string;
  readonly guest_name: string;
  readonly party_size: number;
  readonly room_name: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly deposit_cents: number;
  readonly status: string;
  readonly no_show_from: string;
  readonly running_late_until: string | null;
}
interface BoardRoom {
  readonly room_id: string;
  readonly name: string;
  readonly words: { readonly kind: string };
  readonly session: {
    readonly id: string;
    readonly guest_name: string | null;
    readonly party_size: number;
    readonly booked_end_at: string | null;
  } | null;
  readonly next: { readonly name: string } | null;
}
interface Board {
  readonly rooms: readonly BoardRoom[];
  readonly counts: {
    readonly in_use: number;
    readonly open: number;
    readonly cleaning: number;
    readonly out_of_service: number;
  };
}

export function PhoneTonight() {
  const { t, money, time } = useT();
  const { state } = useSession();
  const { now } = useClock();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const permissions = signedIn?.membership.permissions ?? [];
  const [bookings, setBookings] = useState<readonly Booking[] | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [open, setOpen] = useState<Booking | null>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [b, r] = await Promise.all([
        api<{ bookings: Booking[] }>("GET", `/v1/venues/${venueId}/bookings`),
        api<Board>("GET", `/v1/venues/${venueId}/board`),
      ]);
      setBookings(b.bookings.filter((x) => x.status !== "cancelled"));
      setBoard(r);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    if (!venueId) return;
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [venueId, load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some((e) => ["room.updated", "booking.updated"].includes(e.type))
        )
          void load();
      }),
    [subscribe, load],
  );

  const hours = (b: Booking) =>
    Math.round(
      ((Temporal.Instant.from(b.ends_at).epochMilliseconds -
        Temporal.Instant.from(b.starts_at).epochMilliseconds) /
        3_600_000) *
        10,
    ) / 10;
  const roomOf = (b: Booking) => board?.rooms.find((r) => r.name === b.room_name);
  const status = (b: Booking): string => {
    if (b.status === "checked_in" || b.status === "completed") return t("phone.status.seated");
    if (b.status === "no_show") return t("phone.status.noShow");
    if (b.running_late_until)
      return t("phone.status.late", { time: time(b.running_late_until, timeZone) });
    return t("phone.status.booked");
  };
  const act = async (path: string, body: unknown, line: string) => {
    try {
      await api("POST", `/v1/venues/${venueId}${path}`, body);
      setOpen(null);
      setDone(line);
      await load();
    } catch {
      setFailed(true);
    }
  };

  return (
    <section className="screen">
      <h1>{t("menu.tonight")}</h1>
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
      {board && (
        <p aria-label={t("board.countsLabel")}>
          {t("phone.counts", {
            inUse: board.counts.in_use,
            open: board.counts.open,
            cleaning: board.counts.cleaning,
            oos: board.counts.out_of_service,
          })}
        </p>
      )}
      {sheet && (
        <CheckInSheet
          venueId={venueId}
          timeZone={timeZone}
          target={sheet}
          freeRooms={[]}
          onClose={() => setSheet(null)}
          onDone={(line) => {
            setSheet(null);
            setDone(line);
            void load();
          }}
        />
      )}
      {open && (
        <div className="sheet" role="dialog" aria-label={open.guest_name}>
          <h2>{open.guest_name}</h2>
          <p>
            {t("phone.booking", {
              time: time(open.starts_at, timeZone),
              party: open.party_size,
              room: open.room_name,
            })}
          </p>
          <p className="small">{status(open)}</p>
          <div className="actions">
            {(open.status === "pending" || open.status === "confirmed") &&
              permissions.includes("guests.checkin") && (
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    setSheet({ kind: "booking", bookingId: open.id, name: open.guest_name });
                    setOpen(null);
                  }}
                >
                  {t("checkIn.button")}
                </button>
              )}
            {(open.status === "pending" || open.status === "confirmed") &&
              now !== null &&
              now.epochMilliseconds >=
                Temporal.Instant.from(open.no_show_from).epochMilliseconds && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void act(
                      `/bookings/${open.id}/no-show`,
                      {},
                      t("phone.noShowDone", { name: open.guest_name }),
                    )
                  }
                >
                  {t("checkIn.noShow")}
                </button>
              )}
            {(open.status === "pending" || open.status === "confirmed") &&
              permissions.includes("texts.send") && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void act(
                      `/bookings/${open.id}/room-ready-text`,
                      undefined,
                      t("phone.roomReadySent", { name: open.guest_name }),
                    )
                  }
                >
                  {t("phone.roomReady")}
                </button>
              )}
            {/* "Tab & close out →" opens the room tab (Staff note 4): never a one-tap Done. */}
            {open.status === "checked_in" && roomOf(open)?.session && (
              <Link className="button primary" to={`/room/${roomOf(open)!.room_id}`}>
                {t("room.open")}
              </Link>
            )}
            {open.status === "checked_in" && roomOf(open)?.session && !roomOf(open)?.next && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  const s = roomOf(open)!.session!;
                  const from =
                    s.booked_end_at && now
                      ? Math.max(Date.parse(s.booked_end_at), now.epochMilliseconds)
                      : (now?.epochMilliseconds ?? Date.parse(open.ends_at));
                  void api("PATCH", `/v1/venues/${venueId}/sessions/${s.id}`, {
                    booked_end_at: Temporal.Instant.fromEpochMilliseconds(
                      from + 3_600_000,
                    ).toString(),
                  })
                    .then(() => {
                      setOpen(null);
                      setDone(t("phone.stayDone", { name: open.guest_name }));
                      void load();
                    })
                    .catch(() => setFailed(true));
                }}
              >
                {t("phone.letStay")}
              </button>
            )}
            <button type="button" onClick={() => setOpen(null)}>
              {t("checkIn.cancel")}
            </button>
          </div>
        </div>
      )}
      <h2>{t("phone.bookings")}</h2>
      {bookings === null && !failed && <p role="status">{t("shell.loading")}</p>}
      {bookings?.length === 0 && <p className="empty">{t("checkIn.noneArriving")}</p>}
      <ol className="bookings-list" aria-label={t("phone.bookings")}>
        {bookings?.map((b) => (
          <li key={b.id} aria-label={b.guest_name}>
            <button type="button" className="conversation" onClick={() => setOpen(b)}>
              <span>
                {t("phone.row", {
                  time: time(b.starts_at, timeZone),
                  name: b.guest_name,
                  party: b.party_size,
                  room: b.room_name,
                  hours: hours(b),
                  deposit: money(b.deposit_cents as never),
                })}
              </span>
              <span className="small">{status(b)}</span>
            </button>
          </li>
        ))}
      </ol>
      <h2>{t("phone.byRoom")}</h2>
      <ul className="bookings-list" aria-label={t("phone.byRoom")}>
        {board?.rooms.map((r) => (
          <li key={r.room_id} aria-label={r.name} className="small">
            <strong>{r.name}</strong>{" "}
            {r.session
              ? r.session.guest_name
                ? t("board.party", { name: r.session.guest_name, party: r.session.party_size })
                : t("phone.walkIn", { party: r.session.party_size })
              : t(
                  `phone.kind.${r.words.kind === "cleaning" || r.words.kind === "out_of_service" ? r.words.kind : "open"}`,
                )}
          </li>
        ))}
      </ul>
    </section>
  );
}

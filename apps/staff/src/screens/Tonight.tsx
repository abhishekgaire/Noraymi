import { useCallback, useEffect, useState } from "react";
import { Temporal } from "@west4/shared";
import { api } from "../api.js";
import { useClock } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import { CheckInSheet, type SheetTarget } from "./CheckInSheet.js";
import { FaultSheet, type FaultTarget } from "./FaultSheet.js";
import { ScanId } from "./ScanId.js";

/**
 * Tonight (M2-07): the rooms in use with their live clock. Each tile ticks on
 * the offset the screen measured from the server's time, never the device's
 * own clock, and takes the room time so far from the server every minute and
 * on every room event. The full board (states, alerts, the waitlist) lands
 * in M2-29 on top of this.
 */
interface Tile {
  readonly kind: "in_room" | "staying" | "needed_now" | "walk_in";
}

interface Fault {
  readonly id: string;
  readonly text: string;
  readonly out_of_service: boolean;
}

interface RoomInfo {
  readonly room_id: string;
  readonly name: string;
  readonly free_now: boolean;
  readonly state: string;
  readonly faults: readonly Fault[];
}

interface Session {
  readonly id: string;
  readonly room_id: string;
  readonly segments: readonly { readonly paused: boolean }[];
  readonly room_name: string;
  readonly party_size: number;
  readonly ids_checked: number;
  readonly started_at: string;
  readonly booked_end_at: string | null;
  readonly room_time_cents: number;
  readonly tile: Tile;
  readonly stay_on_offer: boolean;
  readonly wrap_up: boolean;
  readonly close: string | null;
}

const REFETCH_MS = 60_000;

interface Arrival {
  readonly id: string;
  readonly guest_name: string;
  readonly party_size: number;
  readonly room_name: string;
  readonly starts_at: string;
  readonly status: string;
  readonly no_show_from: string;
}

export function Tonight() {
  const { t, money, time } = useT();
  const { state } = useSession();
  const { now } = useClock();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [arriving, setArriving] = useState<Arrival[]>([]);
  const [free, setFree] = useState<{ room_id: string; name: string }[]>([]);
  const [rooms, setRooms] = useState<readonly RoomInfo[]>([]);
  const [faultSheet, setFaultSheet] = useState<FaultTarget | null>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [answer, bookings, rooms] = await Promise.all([
        api<{ sessions: Session[] }>("GET", `/v1/venues/${venueId}/sessions`),
        api<{ bookings: Arrival[] }>("GET", `/v1/venues/${venueId}/bookings`).catch(() => ({
          bookings: [],
        })),
        api<{ rooms: RoomInfo[] }>("GET", `/v1/venues/${venueId}/rooms/availability`).catch(() => ({
          rooms: [],
        })),
      ]);
      setSessions(answer.sessions);
      setArriving(
        bookings.bookings.filter((b) => b.status === "confirmed" || b.status === "pending"),
      );
      setFree(
        rooms.rooms.filter((r) => r.free_now).map((r) => ({ room_id: r.room_id, name: r.name })),
      );
      setRooms(rooms.rooms);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);

  useEffect(() => {
    if (!venueId) return;
    void load();
    const timer = setInterval(() => void load(), REFETCH_MS);
    return () => clearInterval(timer);
  }, [venueId, load]);

  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "room.updated")) void load();
      }),
    [subscribe, load],
  );

  // Scanning hides with Safety & ID records off; the count stays (M2-12).
  const safetyOn = signedIn?.membership.modules.safety !== "off";
  const idChip = (s: Session): string => {
    const missing = Math.max(0, s.party_size - s.ids_checked);
    const params = { checked: s.ids_checked, party: s.party_size };
    if (missing === 0) return t("ids.chip", params);
    return missing === 1 ? t("ids.runnerOne", params) : t("ids.runnerMany", { ...params, missing });
  };

  const faultsOf = (roomId: string) => rooms.find((r) => r.room_id === roomId)?.faults ?? [];
  const fixFault = async (id: string) => {
    try {
      await api("PATCH", `/v1/venues/${venueId}/faults/${id}`, { fixed: true });
      await load();
    } catch {
      setFailed(true);
    }
  };
  const unpause = async (sessionId: string) => {
    try {
      await api("POST", `/v1/venues/${venueId}/sessions/${sessionId}/unpause`);
      await load();
    } catch {
      setFailed(true);
    }
  };
  const faultList = (roomId: string) => (
    <ul className="faults">
      {faultsOf(roomId).map((f) => (
        <li key={f.id} className="small">
          <div>{f.text}</div>
          <button type="button" className="link" onClick={() => void fixFault(f.id)}>
            {t("fault.fixed")}
          </button>
        </li>
      ))}
    </ul>
  );
  const reportButton = (target: FaultTarget) => (
    <button type="button" className="secondary" onClick={() => setFaultSheet(target)}>
      {t("fault.report")}
    </button>
  );

  const closeWords = (iso: string | null): string => {
    if (!iso) return "";
    const z = Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone);
    const hour = z.hour % 12 === 0 ? 12 : z.hour % 12;
    const suffix = z.hour < 12 ? "AM" : "PM";
    return z.minute === 0
      ? `${hour} ${suffix}`
      : `${hour}:${String(z.minute).padStart(2, "0")} ${suffix}`;
  };

  const minutesSince = (iso: string) =>
    now
      ? Math.max(
          0,
          Math.floor(
            (now.epochMilliseconds - Temporal.Instant.from(iso).epochMilliseconds) / 60_000,
          ),
        )
      : null;

  const tileWords = (s: Session): string => {
    if (!s.booked_end_at || s.tile.kind === "walk_in") return t("session.walkIn");
    const end = Temporal.Instant.from(s.booked_end_at).epochMilliseconds;
    const at = now?.epochMilliseconds ?? end;
    if (at < end) return t("session.inRoom", { min: Math.ceil((end - at) / 60_000) });
    const past = Math.floor((at - end) / 60_000);
    return s.tile.kind === "needed_now"
      ? t("session.neededNow", { min: past })
      : t("session.staying", { min: past });
  };

  return (
    <section className="screen">
      <h1>{t("menu.tonight")}</h1>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {sessions === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          {done && (
            <p className="notice" role="status">
              {done}
            </p>
          )}
          {sheet && (
            <CheckInSheet
              venueId={venueId}
              timeZone={timeZone}
              target={sheet}
              freeRooms={free}
              onClose={() => setSheet(null)}
              onDone={(line) => {
                setSheet(null);
                setDone(line);
                void load();
              }}
            />
          )}
          {faultSheet && (
            <FaultSheet
              venueId={venueId}
              target={faultSheet}
              onClose={() => setFaultSheet(null)}
              onLogged={(line) => {
                setFaultSheet(null);
                setDone(line);
                void load();
              }}
            />
          )}
          <h2>{t("checkIn.arriving")}</h2>
          {arriving.length === 0 ? (
            <p className="empty">{t("checkIn.noneArriving")}</p>
          ) : (
            <ul className="room-clocks">
              {arriving.map((b) => {
                const noShowOk =
                  now !== null &&
                  now.epochMilliseconds >= Temporal.Instant.from(b.no_show_from).epochMilliseconds;
                return (
                  <li key={b.id} className="room-clock" aria-label={b.guest_name}>
                    <div className="room-clock-head">
                      <span className="tile-name">{b.guest_name}</span>
                      <span>{t("checkIn.guests", { party: b.party_size })}</span>
                    </div>
                    <div className="small">
                      {t("checkIn.at", { time: time(b.starts_at, timeZone), room: b.room_name })}
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="primary"
                        onClick={() =>
                          setSheet({ kind: "booking", bookingId: b.id, name: b.guest_name })
                        }
                      >
                        {t("checkIn.button")}
                      </button>
                      {noShowOk ? (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            void api("POST", `/v1/venues/${venueId}/bookings/${b.id}/no-show`, {})
                              .then(() => load())
                              .catch(() => setFailed(true))
                          }
                        >
                          {t("checkIn.noShow")}
                        </button>
                      ) : (
                        <span className="small muted">
                          {t("checkIn.noShowFrom", { time: time(b.no_show_from, timeZone) })}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <h2>{t("checkIn.freeRooms")}</h2>
          <ul className="room-clocks">
            {free.map((r) => (
              <li key={r.room_id} className="room-clock" aria-label={r.name}>
                <span className="tile-name">{r.name}</span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setSheet({ kind: "walk_in", roomId: r.room_id, roomName: r.name })}
                >
                  {t("checkIn.walkIn")}
                </button>
                {faultList(r.room_id)}
                {reportButton({ roomId: r.room_id, roomName: r.name, hasSession: false })}
              </li>
            ))}
          </ul>
          <h2>{t("session.roomsInUse")}</h2>
          <ul className="room-clocks">
            {sessions.map((s) => {
              const minutes = minutesSince(s.started_at);
              return (
                <li
                  key={s.id}
                  className={s.wrap_up ? "room-clock wrap" : "room-clock"}
                  aria-label={s.room_name}
                >
                  <div className="room-clock-head">
                    <span className="tile-name">{s.room_name}</span>
                    {minutes !== null && (
                      <span className="room-clock-min">
                        {t("session.minutes", { min: minutes })}
                      </span>
                    )}
                  </div>
                  <div className="small">{tileWords(s)}</div>
                  <div className="small muted">
                    {t("session.timeSoFar", { amount: money(s.room_time_cents as never) })}
                  </div>
                  <div className="small">{idChip(s)}</div>
                  {safetyOn && (
                    <ScanId venueId={venueId} sessionId={s.id} onScanned={() => void load()} />
                  )}
                  {s.wrap_up && <div className="small error">{t("session.wrapUp")}</div>}
                  {s.stay_on_offer && (
                    <div className="small">
                      {t("session.stayOn", { time: closeWords(s.close) })}
                    </div>
                  )}
                  {s.segments.at(-1)?.paused && (
                    <div className="small">
                      {t("session.paused")}{" "}
                      <button type="button" className="link" onClick={() => void unpause(s.id)}>
                        {t("session.unpause")}
                      </button>
                    </div>
                  )}
                  {faultList(s.room_id)}
                  {reportButton({ roomId: s.room_id, roomName: s.room_name, hasSession: true })}
                </li>
              );
            })}
          </ul>
          <h2>{t("fault.outOfServiceRooms")}</h2>
          <ul className="room-clocks">
            {rooms
              .filter((r) => r.state === "out_of_service")
              .map((r) => (
                <li key={r.room_id} className="room-clock off" aria-label={r.name}>
                  <span className="tile-name">{r.name}</span>
                  <div className="small">{t("fault.outOfService")}</div>
                  {faultList(r.room_id)}
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}

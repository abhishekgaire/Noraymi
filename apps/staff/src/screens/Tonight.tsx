import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Temporal } from "@west4/shared";
import { api } from "../api.js";
import { useClock } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import { CheckInSheet, type SheetTarget } from "./CheckInSheet.js";
import { FaultSheet, type FaultTarget } from "./FaultSheet.js";
import { Alerts, type Alert } from "./Alerts.js";
import { DamageSheet } from "./DamageSheet.js";
import { CutOffRoom } from "./CutOff.js";
import { Headcount } from "./Headcount.js";
import { LostAndFound } from "./LostAndFound.js";
import { MoveSheet } from "./MoveSheet.js";
import { WaitlistList, useWaitlistCount } from "./Waitlist.js";
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
  readonly cleaning: {
    readonly left_at: string;
    readonly minutes: number;
    readonly flagged: boolean;
  } | null;
  readonly notes: readonly { readonly id: string; readonly text: string }[];
}

type Words =
  | { readonly kind: "in_room" | "wrap_up"; readonly minutes_left: number }
  | { readonly kind: "staying" | "needed_now"; readonly minutes_past: number }
  | { readonly kind: "walk_in" | "free_all_night" | "open" | "out_of_service" }
  | {
      readonly kind: "cleaning";
      readonly left_at: string;
      readonly minutes: number;
      readonly flagged: boolean;
    }
  | { readonly kind: "held"; readonly name: string; readonly until: string }
  | { readonly kind: "next"; readonly at: string };

interface BoardRoom {
  readonly room_id: string;
  readonly name: string;
  readonly state: string;
  readonly words: Words;
  readonly tone: "amber" | "red" | null;
  readonly free_now: boolean;
  readonly faults: readonly Fault[];
  readonly notes: readonly { readonly id: string; readonly text: string }[];
  readonly session: {
    readonly guest_name: string | null;
    readonly party_size: number;
    readonly tab_so_far_cents: number;
    readonly deposit_cents: number;
  } | null;
}

interface Board {
  readonly rooms: readonly BoardRoom[];
  readonly alerts: readonly Alert[];
  readonly counts: {
    readonly in_use: number;
    readonly open: number;
    readonly cleaning: number;
    readonly out_of_service: number;
  };
}

interface Session {
  readonly id: string;
  readonly guest_name: string | null;
  readonly alcohol_cut_off_at?: string | null;
  readonly alcohol_cut_off_by_name?: string | null;
  readonly room_id: string;
  readonly check_id: string | null;
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
  readonly running_late_until: string | null;
}

export function Tonight() {
  const navigate = useNavigate();
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
  const [boardRooms, setBoardRooms] = useState<readonly BoardRoom[]>([]);
  const [counts, setCounts] = useState<Board["counts"] | null>(null);
  const [alerts, setAlerts] = useState<readonly Alert[]>([]);
  const [faultSheet, setFaultSheet] = useState<FaultTarget | null>(null);
  const [moving, setMoving] = useState<{ sessionId: string; roomName: string } | null>(null);
  const [damage, setDamage] = useState<{ checkId: string; roomName: string } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const waitlistOn = signedIn?.membership.modules.waitlist !== "off";
  const waitlist = useWaitlistCount(venueId, waitlistOn);
  const waiting = waitlist.count;
  const [rates, setRates] = useState<Record<string, { hourly_cents: number; min_guests: number }>>(
    {},
  );
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
        api<Board>("GET", `/v1/venues/${venueId}/board`).catch(() => null),
      ]);
      setSessions(answer.sessions);
      setArriving(
        bookings.bookings.filter((b) => b.status === "confirmed" || b.status === "pending"),
      );
      const tiles = rooms?.rooms ?? [];
      setFree(tiles.filter((r) => r.free_now).map((r) => ({ room_id: r.room_id, name: r.name })));
      setRooms(
        tiles.map((r) => ({
          room_id: r.room_id,
          name: r.name,
          free_now: r.free_now,
          state: r.state,
          faults: r.faults,
          notes: r.notes,
          cleaning:
            r.words.kind === "cleaning"
              ? { left_at: r.words.left_at, minutes: r.words.minutes, flagged: r.words.flagged }
              : null,
        })),
      );
      setBoardRooms(tiles);
      setCounts(rooms?.counts ?? null);
      setAlerts(rooms?.alerts ?? []);
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
        if (
          events.length === 0 ||
          events.some((e) =>
            [
              "room.updated",
              "booking.updated",
              "room.call",
              "waitlist.updated",
              "message.received",
              "print_job.failed",
              "print_job.queued",
              "order.escalated",
              "bar.connected",
              "clear_out.due",
              "clear_out.done",
              "bar.disconnected",
              "order.accepted",
              "order.cancelled",
            ].includes(e.type),
          )
        )
          void load();
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
  const changeParty = async (s: Session, partySize: number) => {
    if (partySize < 1) return;
    try {
      const r = await api<{
        hourly_cents: number;
        min_guests: number;
        status?: string;
        waiting_for?: { name: string };
      }>("POST", `/v1/venues/${venueId}/sessions/${s.id}/party-size`, { party_size: partySize });
      // Fewer guests after the gratuity applies waits for a manager (M4-23): nothing changes yet.
      if (r.status === "approval_pending" && r.waiting_for)
        setDone(t("approvals.waitingFor", { name: r.waiting_for.name.split(" ")[0] ?? "" }));
      else setRates((all) => ({ ...all, [s.id]: r }));
      await load();
    } catch {
      setDone(t("party.failed"));
    }
  };
  const markClean = async (roomId: string) => {
    try {
      await api("POST", `/v1/venues/${venueId}/rooms/${roomId}/clean`);
      await load();
    } catch {
      setFailed(true);
    }
  };
  const noteList = (roomId: string) => {
    const notes = rooms.find((r) => r.room_id === roomId)?.notes ?? [];
    return notes.length === 0 ? null : (
      <ul className="faults">
        {notes.map((n) => (
          <li key={n.id} className="small muted">
            {n.text}
          </li>
        ))}
      </ul>
    );
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

  /** "10:45" without AM or PM, as the board's open tiles read. */
  const shortTime = (iso: string): string => {
    const z = Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone);
    const hour = z.hour % 12 === 0 ? 12 : z.hour % 12;
    return `${hour}:${String(z.minute).padStart(2, "0")}`;
  };
  /** Minutes left or past tick on the server-offset clock between refetches, like the room clocks. */
  const ticking = (w: Words, bookedEnd: string | null | undefined): Words => {
    if (!now || !bookedEnd) return w;
    const end = Temporal.Instant.from(bookedEnd).epochMilliseconds;
    const at = now.epochMilliseconds;
    if (w.kind === "in_room" || w.kind === "wrap_up")
      return at < end ? { ...w, minutes_left: Math.ceil((end - at) / 60_000) } : w;
    if (w.kind === "staying" || w.kind === "needed_now")
      return at >= end ? { ...w, minutes_past: Math.floor((at - end) / 60_000) } : w;
    return w;
  };
  const wordsText = (w: Words): string => {
    switch (w.kind) {
      case "in_room":
        return t("session.inRoom", { min: w.minutes_left });
      case "wrap_up":
        return t("board.wrapUp", { min: w.minutes_left });
      case "staying":
        return t("session.staying", { min: w.minutes_past });
      case "needed_now":
        return t("session.neededNow", { min: w.minutes_past });
      case "walk_in":
        return t("session.walkIn");
      case "cleaning":
        return t("cleaning.left", { time: time(w.left_at, timeZone), min: w.minutes });
      case "held":
        return t("messages.heldFor", { name: w.name, time: shortTime(w.until) });
      case "next":
        return t("board.next", { time: shortTime(w.at) });
      case "free_all_night":
        return t("board.freeAllNight");
      case "out_of_service":
        return t("fault.outOfService");
      default:
        return t("board.open");
    }
  };

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

  return (
    <section className="screen">
      <div className="screen-head">
        <h1>{t("menu.tonight")}</h1>
        {waitlistOn && (
          <button
            type="button"
            className="secondary"
            aria-expanded={drawer}
            onClick={() => setDrawer((open) => !open)}
          >
            {t("waitlist.button", { count: waiting })}
          </button>
        )}
      </div>
      {venueId && (
        <Headcount
          venueId={venueId}
          canCount={signedIn?.membership.permissions.includes("guests.checkin") ?? false}
        />
      )}
      {drawer && (
        <aside className="drawer" aria-label={t("waitlist.title")}>
          <div className="room-clock-head">
            <h2>{t("waitlist.title")}</h2>
            <button type="button" className="link" onClick={() => setDrawer(false)}>
              {t("waitlist.close")}
            </button>
          </div>
          <WaitlistList
            venueId={venueId}
            timeZone={timeZone}
            onWalkIn={
              free[0]
                ? () => {
                    setDrawer(false);
                    setSheet({
                      kind: "walk_in",
                      roomId: free[0]!.room_id,
                      roomName: free[0]!.name,
                    });
                  }
                : undefined
            }
          />
        </aside>
      )}
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
          <Alerts
            alerts={alerts}
            timeZone={timeZone}
            actions={{
              canText: signedIn?.membership.permissions.includes("texts.send") ?? false,
              wrapUp: (sessionId, name) =>
                void api("POST", `/v1/venues/${venueId}/sessions/${sessionId}/wrap-up-text`)
                  .then(() => setDone(t("wrapUp.sent", { name })))
                  .catch(() => setDone(t("wrapUp.failed"))),
              move: (sessionId, roomName) => setMoving({ sessionId, roomName }),
              reprint: (jobId) =>
                void api("POST", `/v1/venues/${venueId}/print-jobs/${jobId}/reprint`)
                  .then(() => load())
                  .catch(() => setFailed(true)),
              onIt: (callId) =>
                void api("POST", `/v1/venues/${venueId}/calls/${callId}/ack`)
                  .then(() => load())
                  .catch(() => setFailed(true)),
              offer: (entryId) =>
                void api("POST", `/v1/venues/${venueId}/waitlist/${entryId}/offer`)
                  .then(() => {
                    waitlist.reload();
                    setDrawer(true);
                    void load();
                  })
                  .catch(() => setFailed(true)),
              showOrders: () => void navigate("/bar-orders"),
              clearOut: (date) =>
                void api("POST", `/v1/venues/${venueId}/nights/${date}/clear-out`, {})
                  .then(() => load())
                  .catch(() => setFailed(true)),
              show: (roomId) =>
                document
                  .querySelector(`[data-room="${roomId}"]`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" }),
              noProblem: (conversationId) =>
                void api(
                  "POST",
                  `/v1/venues/${venueId}/conversations/${conversationId}/running-late`,
                  {},
                )
                  .then(() => load())
                  .catch(() => setFailed(true)),
              checkIn: (bookingId, name) => setSheet({ kind: "booking", bookingId, name }),
              noShow: (bookingId) =>
                void api("POST", `/v1/venues/${venueId}/bookings/${bookingId}/no-show`, {})
                  .then(() => load())
                  .catch(() => setFailed(true)),
            }}
          />
          {damage && (
            <DamageSheet
              venueId={venueId}
              checkId={damage.checkId}
              roomName={damage.roomName}
              onClose={() => {
                setDamage(null);
                void load();
              }}
            />
          )}
          {moving && (
            <MoveSheet
              venueId={venueId}
              timeZone={timeZone}
              sessionId={moving.sessionId}
              roomName={moving.roomName}
              onClose={() => setMoving(null)}
              onMoved={(line) => {
                setMoving(null);
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
                    {b.running_late_until && (
                      <div className="small">
                        {b.room_name} ·{" "}
                        {t("messages.heldFor", {
                          name: b.guest_name,
                          time: time(b.running_late_until, timeZone),
                        })}
                      </div>
                    )}
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
          <h2>{t("board.rooms")}</h2>
          {counts && (
            <p className="small" aria-label={t("board.countsLabel")}>
              {t("board.counts", {
                inUse: counts.in_use,
                open: counts.open,
                cleaning: counts.cleaning,
                oos: counts.out_of_service,
              })}
            </p>
          )}
          <ul className="room-clocks board">
            {boardRooms.map((r) => {
              const s = sessions.find((x) => x.room_id === r.room_id);
              const minutes = s ? minutesSince(s.started_at) : null;
              return (
                <li
                  key={r.room_id}
                  className={r.tone ? `room-clock ${r.tone}` : "room-clock"}
                  aria-label={r.name}
                  data-room={r.room_id}
                >
                  <div className="room-clock-head">
                    <span className="tile-name">{r.name}</span>
                    {minutes !== null && (
                      <span className="room-clock-min">
                        {t("session.minutes", { min: minutes })}
                      </span>
                    )}
                  </div>
                  {s && (
                    <Link className="small" to={`/room/${r.room_id}`}>
                      {t("room.open")}
                    </Link>
                  )}
                  <div className={r.tone === "red" ? "small error" : "small"}>
                    {wordsText(ticking(r.words, s?.booked_end_at))}
                  </div>
                  {s && r.session ? (
                    <>
                      {r.session.guest_name && (
                        <div className="small">
                          {t("board.party", {
                            name: r.session.guest_name,
                            party: r.session.party_size,
                          })}
                        </div>
                      )}
                      {r.session.deposit_cents > 0 && (
                        <div className="small muted">
                          {t("board.deposit", { amount: money(r.session.deposit_cents as never) })}
                        </div>
                      )}
                      <div className="small">
                        {t("board.tabSoFar", {
                          amount: money(r.session.tab_so_far_cents as never),
                        })}
                      </div>
                      <div className="small muted">
                        {t("session.timeSoFar", { amount: money(s.room_time_cents as never) })}
                      </div>
                      <div className="party-size">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={t("party.fewer")}
                          disabled={s.party_size <= 1}
                          onClick={() => void changeParty(s, s.party_size - 1)}
                        >
                          −
                        </button>
                        <span>{t("party.size", { n: s.party_size })}</span>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={t("party.more")}
                          onClick={() => void changeParty(s, s.party_size + 1)}
                        >
                          +
                        </button>
                      </div>
                      {rates[s.id] && (
                        <div className="small">
                          {t("party.rate", {
                            amount: money(rates[s.id]!.hourly_cents as never),
                            min: rates[s.id]!.min_guests,
                          })}
                        </div>
                      )}
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
                      {noteList(s.room_id)}
                      {faultList(s.room_id)}
                      <CutOffRoom
                        venueId={venueId}
                        sessionId={s.id}
                        roomName={s.room_name}
                        timeZone={timeZone}
                        cutOff={
                          s.alcohol_cut_off_at
                            ? { at: s.alcohol_cut_off_at, by: s.alcohol_cut_off_by_name ?? null }
                            : null
                        }
                        canCutOff={
                          signedIn?.membership.permissions.includes("cutoff.apply") ?? false
                        }
                        onDone={() => void load()}
                      />
                      <div className="actions">
                        <button
                          type="button"
                          className={s.tile.kind === "needed_now" ? "primary" : "secondary"}
                          onClick={() => setMoving({ sessionId: s.id, roomName: s.room_name })}
                        >
                          {t("move.button")}
                        </button>
                        {reportButton({
                          roomId: s.room_id,
                          roomName: s.room_name,
                          hasSession: true,
                        })}
                        {s.guest_name &&
                          (s.tile.kind === "needed_now" || s.wrap_up) &&
                          signedIn?.membership.permissions.includes("texts.send") && (
                            <button
                              type="button"
                              className="secondary"
                              onClick={() =>
                                void api(
                                  "POST",
                                  `/v1/venues/${venueId}/sessions/${s.id}/wrap-up-text`,
                                )
                                  .then(() => setDone(t("wrapUp.sent", { name: s.guest_name! })))
                                  .catch(() => setDone(t("wrapUp.failed")))
                              }
                            >
                              {t("wrapUp.text", { name: s.guest_name })}
                            </button>
                          )}
                        {s.check_id && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              setDamage({ checkId: s.check_id!, roomName: s.room_name })
                            }
                          >
                            {t("damage.button")}
                          </button>
                        )}
                      </div>
                    </>
                  ) : r.words.kind === "cleaning" ? (
                    <>
                      {r.words.flagged && (
                        <div className="small error">{t("cleaning.flagged")}</div>
                      )}
                      {noteList(r.room_id)}
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void markClean(r.room_id)}
                      >
                        {t("cleaning.markClean")}
                      </button>
                    </>
                  ) : r.words.kind === "out_of_service" ? (
                    faultList(r.room_id)
                  ) : (
                    <>
                      {r.free_now && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            setSheet({ kind: "walk_in", roomId: r.room_id, roomName: r.name })
                          }
                        >
                          {t("checkIn.walkIn")}
                        </button>
                      )}
                      {noteList(r.room_id)}
                      {faultList(r.room_id)}
                      {reportButton({ roomId: r.room_id, roomName: r.name, hasSession: false })}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <LostAndFound venueId={venueId} rooms={rooms} />
        </>
      )}
    </section>
  );
}

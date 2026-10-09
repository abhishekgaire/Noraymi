import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { SyncFooter } from "../connection.js";
import { Link, useNavigate } from "react-router";
import { Temporal } from "@west4/shared";
import { api } from "../api.js";
import { useClock } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { DrawerPanel } from "./DrawerPanel.js";
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
    /** What's left to the minimum spend (M4-27); null with none. */
    readonly min_spend_left_cents?: number | null;
    readonly deposit_cents: number;
  } | null;
}

interface Board {
  readonly rooms: readonly BoardRoom[];
  /** Open incidents (M8-08): a count only, never a room or a reason; null with Safety off. */
  readonly manager_needed?: number | null;
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
  readonly ends_at: string;
  readonly status: string;
  readonly no_show_from: string;
  readonly running_late_until: string | null;
}

/** The phone layout (V-08): below the shell's desktop breakpoint, as the bottom tabs are. */
const PHONE = "(max-width: 1023px)";
function usePhone(): boolean {
  const query = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(PHONE).matches
      : false;
  const [phone, setPhone] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(PHONE);
    const on = () => setPhone(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

type View = "timeline" | "list" | "waitlist";
const VIEW_KEY = "w4.board.view";
/** The phone's last board view, a per-viewer convenience: it may be missing or blocked. */
function savedView(): View {
  try {
    const v = sessionStorage.getItem(VIEW_KEY);
    return v === "list" || v === "waitlist" ? v : "timeline";
  } catch {
    return "timeline";
  }
}

/** The phone timeline (V-08): 4 PM to 4 AM of the business date, 65 px an hour as the canvas draws it. */
const HOUR_PX = 65;
const FIRST_HOUR = 16;
const HOURS = 12;

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
  const [booked, setBooked] = useState<Arrival[]>([]);
  // The open room (V-08): its details and controls show in the side panel, a sheet on a phone.
  const [selected, setSelected] = useState<string | null>(null);
  const phone = usePhone();
  const [view, setViewState] = useState<View>(savedView);
  const setView = (v: View) => {
    setViewState(v);
    try {
      sessionStorage.setItem(VIEW_KEY, v);
    } catch {
      /* the view just isn't remembered */
    }
  };
  const [note, setNote] = useState("");
  const timeline = useRef<HTMLDivElement>(null);
  const [free, setFree] = useState<{ room_id: string; name: string }[]>([]);
  const [rooms, setRooms] = useState<readonly RoomInfo[]>([]);
  const [boardRooms, setBoardRooms] = useState<readonly BoardRoom[]>([]);
  const [counts, setCounts] = useState<Board["counts"] | null>(null);
  const [alerts, setAlerts] = useState<readonly Alert[]>([]);
  const [managerNeeded, setManagerNeeded] = useState(0);
  const [faultSheet, setFaultSheet] = useState<FaultTarget | null>(null);
  const [moving, setMoving] = useState<{ sessionId: string; roomName: string } | null>(null);
  const [damage, setDamage] = useState<{ checkId: string; roomName: string } | null>(null);
  const [drawer, setDrawer] = useState(false);
  // The cash drawers (M7-05; screens Board note 18): both house drawers and the handover.
  const [cash, setCash] = useState(false);
  const managing = signedIn?.membership.role === "owner" || signedIn?.membership.role === "manager";
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
      setBooked(bookings.bookings.filter((b) => b.status !== "cancelled"));
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
      setManagerNeeded(rooms?.manager_needed ?? 0);
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
              "incident.count",
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

  const can = (a: string) => signedIn?.membership.permissions.includes(a as never) ?? false;
  const modules = signedIn?.membership.modules;
  const runsOn = can("runs.carry") && modules?.bar_screen !== "off";
  const tipsOn = can("pos.use") && modules?.bar_tabs !== "off";
  const sheetOpen = sheet !== null || damage !== null || moving !== null || faultSheet !== null;
  const showList = !phone || view === "list";
  const open = boardRooms.find((r) => r.room_id === selected) ?? null;

  // A sheet opened from the panel or a tile shows at the top of the board: bring it into view.
  const sheets = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sheetOpen) sheets.current?.scrollIntoView?.({ block: "nearest" });
  }, [sheetOpen]);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected && !phone) panelRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected, phone]);

  const alertActions = {
    canText: can("texts.send"),
    wrapUp: (sessionId: string, name: string) =>
      void api("POST", `/v1/venues/${venueId}/sessions/${sessionId}/wrap-up-text`)
        .then(() => setDone(t("wrapUp.sent", { name })))
        .catch(() => setDone(t("wrapUp.failed"))),
    move: (sessionId: string, roomName: string) => setMoving({ sessionId, roomName }),
    reprint: (jobId: string) =>
      void api("POST", `/v1/venues/${venueId}/print-jobs/${jobId}/reprint`)
        .then(() => load())
        .catch(() => setFailed(true)),
    onIt: (callId: string) =>
      void api("POST", `/v1/venues/${venueId}/calls/${callId}/ack`)
        .then(() => load())
        .catch(() => setFailed(true)),
    offer: (entryId: string) =>
      void api("POST", `/v1/venues/${venueId}/waitlist/${entryId}/offer`)
        .then(() => {
          waitlist.reload();
          setDrawer(true);
          void load();
        })
        .catch(() => setFailed(true)),
    showOrders: () => void navigate("/bar-orders"),
    clearOut: (date: string) =>
      void api("POST", `/v1/venues/${venueId}/nights/${date}/clear-out`, {})
        .then(() => load())
        .catch(() => setFailed(true)),
    // "Show" on a wipe alert opens that room (V-08).
    show: (roomId: string) => {
      setSelected(roomId);
      document
        .querySelector(`[data-room="${roomId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    noProblem: (conversationId: string) =>
      void api("POST", `/v1/venues/${venueId}/conversations/${conversationId}/running-late`, {})
        .then(() => load())
        .catch(() => setFailed(true)),
    checkIn: (bookingId: string, name: string) => setSheet({ kind: "booking", bookingId, name }),
    noShow: (bookingId: string) =>
      void api("POST", `/v1/venues/${venueId}/bookings/${bookingId}/no-show`, {})
        .then(() => load())
        .catch(() => setFailed(true)),
  };

  const walkIn = () => {
    if (free[0]) setSheet({ kind: "walk_in", roomId: free[0].room_id, roomName: free[0].name });
    else if (waitlistOn) setView("waitlist");
  };

  const addNote = async (e: FormEvent, roomId: string) => {
    e.preventDefault();
    if (!note.trim()) return;
    try {
      await api("POST", `/v1/venues/${venueId}/rooms/${roomId}/notes`, { text: note.trim() });
      setNote("");
      await load();
    } catch {
      setFailed(true);
    }
  };

  /** The open room's panel (V-08, the canvas's "ROOM 9" panel): every control a tile used to hold. */
  const roomPanel = (r: BoardRoom) => {
    const s = sessions?.find((x) => x.room_id === r.room_id);
    const minutes = s ? minutesSince(s.started_at) : null;
    const words = wordsText(ticking(r.words, s?.booked_end_at));
    const calls = alerts.filter((a) => a.kind === "call" && a.room_name === r.name);
    return (
      <section
        ref={panelRef}
        className={r.tone ? `room-panel ${r.tone}` : "room-panel"}
        aria-label={r.name}
        data-state={r.words.kind}
      >
        <div className="room-panel-head">
          <h2 className="room-panel-name">{r.name}</h2>
          {minutes !== null && (
            <span className="room-clock-min">{t("session.minutes", { min: minutes })}</span>
          )}
          <button type="button" className="link" onClick={() => setSelected(null)}>
            {t("waitlist.close")}
          </button>
        </div>
        {s && r.session ? (
          <>
            {r.session.guest_name && (
              <div className="room-panel-who">
                {t("board.party", { name: r.session.guest_name, party: r.session.party_size })}
              </div>
            )}
            <div className="room-panel-boxes">
              <div className={r.tone === "red" ? "error" : undefined}>
                <span className="board-label">{t("board.panel.clock")}</span>
                <b>{words}</b>
              </div>
              <div>
                <span className="board-label">{t("board.panel.tab")}</span>
                <b>{money(r.session.tab_so_far_cents as never)}</b>
              </div>
            </div>
            {calls.length > 0 && (
              <Alerts
                alerts={calls}
                timeZone={timeZone}
                actions={alertActions}
                label={t("tabs.calls")}
              />
            )}
            {s.wrap_up && <div className="small error">{t("session.wrapUp")}</div>}
            {s.stay_on_offer && (
              <div className="room-panel-note">
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
            <div className="actions room-panel-actions">
              <Link className="button primary" to={`/room/${r.room_id}`}>
                {t("room.open")}
              </Link>
              <button
                type="button"
                className={s.tile.kind === "needed_now" ? "primary" : "secondary"}
                onClick={() => setMoving({ sessionId: s.id, roomName: s.room_name })}
              >
                {t("move.button")}
              </button>
              {s.guest_name && (s.tile.kind === "needed_now" || s.wrap_up) && can("texts.send") && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void api("POST", `/v1/venues/${venueId}/sessions/${s.id}/wrap-up-text`)
                      .then(() => setDone(t("wrapUp.sent", { name: s.guest_name! })))
                      .catch(() => setDone(t("wrapUp.failed")))
                  }
                >
                  {t("wrapUp.text", { name: s.guest_name })}
                </button>
              )}
              {reportButton({ roomId: s.room_id, roomName: s.room_name, hasSession: true })}
              {s.check_id && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setDamage({ checkId: s.check_id!, roomName: s.room_name })}
                >
                  {t("damage.button")}
                </button>
              )}
            </div>
            <div className="room-panel-section">
              <h3 className="board-label">{t("room.tabSoFar")}</h3>
              <div className="small">
                {t("board.tabSoFar", { amount: money(r.session.tab_so_far_cents as never) })}
              </div>
              <div className="small muted">
                {t("session.timeSoFar", { amount: money(s.room_time_cents as never) })}
              </div>
              {r.session.deposit_cents > 0 && (
                <div className="small muted">
                  {t("board.deposit", { amount: money(r.session.deposit_cents as never) })}
                </div>
              )}
              {(r.session.min_spend_left_cents ?? 0) > 0 && (
                <div className="small">
                  {t("minSpend.left", { amount: money(r.session.min_spend_left_cents as never) })}
                </div>
              )}
            </div>
            <div className="room-panel-section">
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
                canCutOff={can("cutoff.apply")}
                onDone={() => void load()}
              />
            </div>
            {faultList(s.room_id)}
          </>
        ) : r.words.kind === "cleaning" ? (
          <>
            <div className="room-panel-note">{words}</div>
            {r.words.flagged && <div className="small error">{t("cleaning.flagged")}</div>}
            <button type="button" className="primary" onClick={() => void markClean(r.room_id)}>
              {t("cleaning.markClean")}
            </button>
          </>
        ) : r.words.kind === "out_of_service" ? (
          <>
            <div className="room-panel-note">{words}</div>
            {faultList(r.room_id)}
          </>
        ) : (
          <>
            <div className="room-panel-note">{words}</div>
            {r.free_now && (
              <button
                type="button"
                className="primary"
                onClick={() => setSheet({ kind: "walk_in", roomId: r.room_id, roomName: r.name })}
              >
                {t("checkIn.walkIn")}
              </button>
            )}
            {faultList(r.room_id)}
            {reportButton({ roomId: r.room_id, roomName: r.name, hasSession: false })}
          </>
        )}
        <div className="room-panel-section">
          <h3 className="board-label">{t("room.notes")}</h3>
          {noteList(r.room_id)}
          <form className="room-panel-form" onSubmit={(e) => void addNote(e, r.room_id)}>
            <input
              aria-label={t("room.addNote")}
              placeholder={t("room.addNote")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button type="submit" className="secondary" disabled={!note.trim()}>
              {t("room.saveNote")}
            </button>
          </form>
        </div>
      </section>
    );
  };

  /** A compact tile (V-08): name, guest and party, the words, minutes and the tab. One tap opens the panel. */
  const tile = (r: BoardRoom) => {
    const s = sessions?.find((x) => x.room_id === r.room_id);
    const minutes = s ? minutesSince(s.started_at) : null;
    return (
      <li
        key={r.room_id}
        className={r.tone ? `room-clock ${r.tone}` : "room-clock"}
        aria-label={r.name}
        data-room={r.room_id}
        data-state={r.words.kind}
      >
        <button
          type="button"
          className="tile-open"
          aria-pressed={selected === r.room_id}
          onClick={() => setSelected(r.room_id)}
        >
          <span className="tile-name">{r.name}</span>
          {r.session?.guest_name && (
            <span className="tile-who">
              {t("board.party", { name: r.session.guest_name, party: r.session.party_size })}
            </span>
          )}
          <span className={r.tone === "red" ? "tile-words error" : "tile-words"}>
            {wordsText(ticking(r.words, s?.booked_end_at))}
          </span>
          {(minutes !== null || r.session) && (
            <span className="tile-foot">
              <span>{minutes !== null ? t("session.minutes", { min: minutes }) : ""}</span>
              <span>{r.session ? money(r.session.tab_so_far_cents as never) : ""}</span>
            </span>
          )}
        </button>
      </li>
    );
  };

  // The phone's timeline (V-08): tonight from 4 PM to 4 AM, a row a room, a block a booking or stay.
  const startZ = (() => {
    if (!now) return null;
    let z = now.toZonedDateTimeISO(timeZone);
    if (z.hour < 6) z = z.subtract({ days: 1 });
    return z.with({
      hour: FIRST_HOUR,
      minute: 0,
      second: 0,
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0,
    });
  })();
  const startMs = startZ?.epochMilliseconds ?? 0;
  const x = (ms: number) =>
    Math.min(HOURS * HOUR_PX, Math.max(0, ((ms - startMs) / 3_600_000) * HOUR_PX));
  const at = (iso: string) => Temporal.Instant.from(iso).epochMilliseconds;
  const nowMs = now?.epochMilliseconds ?? 0;
  const nowX = startZ && nowMs >= startMs && nowMs <= startMs + HOURS * 3_600_000 ? x(nowMs) : null;
  const nowXRef = useRef(nowX);
  nowXRef.current = nowX;
  useEffect(() => {
    const el = timeline.current;
    if (el && nowXRef.current !== null)
      el.scrollLeft = Math.max(0, nowXRef.current - el.clientWidth / 3);
  }, [phone, view, sessions === null]);
  const blocksFor = (r: BoardRoom) => {
    const out: { key: string; from: number; to: number; label: string; kind: string }[] = [];
    const s = sessions?.find((x2) => x2.room_id === r.room_id);
    if (s)
      out.push({
        key: s.id,
        from: at(s.started_at),
        to: Math.max(s.booked_end_at ? at(s.booked_end_at) : nowMs, nowMs),
        label: s.guest_name
          ? t("board.party", { name: s.guest_name, party: s.party_size })
          : t("phone.walkIn", { party: s.party_size }),
        kind: r.words.kind === "needed_now" || r.tone === "red" ? "late" : "in",
      });
    for (const b of booked) {
      if (b.room_name !== r.name || b.status === "checked_in" || b.status === "no_show") continue;
      const waiting = b.status === "pending" || b.status === "confirmed";
      out.push({
        key: b.id,
        from: at(b.starts_at),
        to: at(b.ends_at),
        label: t("board.party", { name: b.guest_name, party: b.party_size }),
        kind:
          b.status === "completed"
            ? "done"
            : waiting && nowMs > at(b.starts_at)
              ? "late"
              : "booked",
      });
    }
    return out;
  };
  const hourLabel = (i: number) => {
    const h = (FIRST_HOUR + i) % 24;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return i === 0 || h === 0 ? `${h12} ${h < 12 ? "AM" : "PM"}` : String(h12);
  };
  const timelineTitle = startZ
    ? t("board.timeline.title", {
        from: closeWords(startZ.toInstant().toString()),
        to: closeWords(startZ.add({ hours: HOURS }).toInstant().toString()),
      })
    : "";

  return (
    <section className={phone ? "screen board-screen phone" : "screen board-screen"}>
      <div className="screen-head">
        <h1>{t("menu.tonight")}</h1>
        {counts && (
          <p className="board-counts" aria-label={t("board.countsLabel")}>
            {t("board.counts", {
              inUse: counts.in_use,
              open: counts.open,
              cleaning: counts.cleaning,
              oos: counts.out_of_service,
            })}
          </p>
        )}
        {managerNeeded > 0 &&
          (managing ? (
            <Link className="manager-needed" role="status" to="/incidents">
              {t("board.managerNeeded", { count: managerNeeded })}
            </Link>
          ) : (
            <span className="manager-needed" role="status">
              {t("board.managerNeeded", { count: managerNeeded })}
            </span>
          ))}
        {waitlistOn && (
          <button
            type="button"
            className="secondary"
            aria-expanded={drawer}
            onClick={() => setDrawer((o) => !o)}
          >
            {t("waitlist.button", { count: waiting })}
          </button>
        )}
        {can("drawer.count") && (
          <button
            type="button"
            className="secondary"
            aria-expanded={cash}
            onClick={() => setCash((o) => !o)}
          >
            {t("drawers.title")}
          </button>
        )}
      </div>
      {/* The phone's Tonight (V-08, founder-approved, after Staff.dc.html): four counts, the views,
          the timeline first. */}
      {phone && counts && (
        <div className="board-boxes">
          <div className="lime">
            <b>{counts.in_use}</b>
            <span>{t("board.box.inRoom")}</span>
          </div>
          <div>
            <b>{counts.open}</b>
            <span>{t("board.box.open")}</span>
          </div>
          <div>
            <b>{arriving.length}</b>
            <span>{t("checkIn.arriving")}</span>
          </div>
          {waitlistOn && (
            <div className="pink">
              <b>{waiting}</b>
              <span>{t("waitlist.title")}</span>
            </div>
          )}
        </div>
      )}
      {phone && (
        <nav className="board-views" aria-label={t("board.views")} data-scroll="x">
          <button
            type="button"
            aria-pressed={view === "timeline"}
            onClick={() => setView("timeline")}
          >
            {t("board.view.timeline")}
          </button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
            {t("board.view.list")}
          </button>
          {waitlistOn && (
            <button
              type="button"
              aria-pressed={view === "waitlist"}
              onClick={() => setView("waitlist")}
            >
              {t("waitlist.title")}
            </button>
          )}
          {runsOn && (
            <Link className="button" to="/runs">
              {t("menu.runs")}
            </Link>
          )}
          {tipsOn && (
            <Link className="button" to="/tips">
              {t("board.view.tips")}
            </Link>
          )}
        </nav>
      )}
      {cash && venueId && (
        <aside className="drawer" aria-label={t("drawers.title")}>
          <div className="room-clock-head">
            <span />
            <button type="button" className="link" onClick={() => setCash(false)}>
              {t("waitlist.close")}
            </button>
          </div>
          <DrawerPanel venueId={venueId} canHandOver={managing} />
        </aside>
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
      <div ref={sheets} className="board-sheets">
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
      </div>
      {sessions === null && !failed && <p role="status">{t("shell.loading")}</p>}
      {phone && view === "timeline" && sessions !== null && startZ && (
        <section className="timeline" aria-label={timelineTitle}>
          <div className="timeline-head">
            <span>{timelineTitle}</span>
            <span>{t("board.timeline.hint")}</span>
          </div>
          <div className="timeline-frame">
            <div className="timeline-names">
              <div className="timeline-corner" />
              {boardRooms.map((r) => (
                <div
                  key={r.room_id}
                  className={
                    r.words.kind === "out_of_service" ? "timeline-name closed" : "timeline-name"
                  }
                >
                  {r.name}
                </div>
              ))}
            </div>
            <div className="timeline-scroll" data-scroll="x" ref={timeline}>
              <div className="timeline-grid" style={{ width: HOURS * HOUR_PX }}>
                <div className="timeline-hours" aria-hidden="true">
                  {Array.from({ length: HOURS }, (_, i) => (
                    <span key={i}>{hourLabel(i)}</span>
                  ))}
                </div>
                {boardRooms.map((r) => (
                  <div
                    key={r.room_id}
                    className={
                      r.words.kind === "out_of_service" ? "timeline-row closed" : "timeline-row"
                    }
                    aria-label={
                      r.words.kind === "out_of_service"
                        ? `${r.name} · ${t("fault.outOfService")}`
                        : undefined
                    }
                  >
                    {blocksFor(r).map((b) => (
                      <button
                        key={b.key}
                        type="button"
                        className={`timeline-block ${b.kind}`}
                        style={{ left: x(b.from), width: Math.max(44, x(b.to) - x(b.from)) }}
                        aria-label={`${r.name} · ${b.label}`}
                        onClick={() => setSelected(r.room_id)}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                ))}
                {nowX !== null && (
                  <div className="timeline-now" style={{ left: nowX }} aria-hidden="true" />
                )}
              </div>
            </div>
          </div>
          <div className="timeline-legend">
            <span className="in">{t("board.box.inRoom")}</span>
            <span className="booked">{t("phone.status.booked")}</span>
            <span className="late">{t("board.legend.late")}</span>
            <span className="now">{t("board.legend.now")}</span>
          </div>
        </section>
      )}
      {phone && view === "waitlist" && waitlistOn && (
        <section className="board-waitlist" aria-label={t("waitlist.title")}>
          <WaitlistList
            venueId={venueId}
            timeZone={timeZone}
            onWalkIn={free[0] ? walkIn : undefined}
          />
        </section>
      )}
      {/* The canvas's layout (V-08): alerts and compact tiles on the left, the open room's panel on
          the right with the headcount, arrivals and lost and found under it; on a phone the List
          view, with the panel as a sheet. */}
      <div className="board-layout">
        {showList && (
          <div className="board-main">
            {sessions !== null && (
              <>
                <Alerts alerts={alerts} timeZone={timeZone} actions={alertActions} limit={3} />
                <h2 className="board-label board-rooms-label">{t("board.rooms")}</h2>
                <ul className="room-clocks board">{boardRooms.map(tile)}</ul>
              </>
            )}
          </div>
        )}
        <div className="board-side">
          {open && !(phone && sheetOpen) && roomPanel(open)}
          {!open && !phone && sessions !== null && <p className="board-pick">{t("board.pick")}</p>}
          {showList && venueId && (
            <div className="board-headcount">
              <Headcount venueId={venueId} canCount={can("guests.checkin")} />
            </div>
          )}
          {showList && sessions !== null && (
            <>
              <div className="board-arriving">
                <h2 className="board-label">{t("checkIn.arriving")}</h2>
                {arriving.length === 0 ? (
                  <p className="empty">{t("checkIn.noneArriving")}</p>
                ) : (
                  <ul className="room-clocks arriving">
                    {arriving.map((b) => {
                      const noShowOk =
                        now !== null &&
                        now.epochMilliseconds >=
                          Temporal.Instant.from(b.no_show_from).epochMilliseconds;
                      return (
                        <li key={b.id} className="room-clock" aria-label={b.guest_name}>
                          <div className="room-clock-head">
                            <span className="tile-name">{b.guest_name}</span>
                            <span>{t("checkIn.guests", { party: b.party_size })}</span>
                          </div>
                          <div className="small">
                            {t("checkIn.at", {
                              time: time(b.starts_at, timeZone),
                              room: b.room_name,
                            })}
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
                                  void api(
                                    "POST",
                                    `/v1/venues/${venueId}/bookings/${b.id}/no-show`,
                                    {},
                                  )
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
              </div>
              <div className="board-lost">
                <LostAndFound venueId={venueId} rooms={rooms} />
              </div>
            </>
          )}
        </div>
      </div>
      {phone && can("guests.checkin") && !(open && !sheetOpen) && !sheet && (
        <div className="walk-in-bar">
          <button type="button" className="primary" onClick={walkIn}>
            {t("checkIn.walkIn")}
          </button>
        </div>
      )}
      {/* "Online · synced 4 s ago", never "works offline" (M8-01; screens Board note 14). */}
      <SyncFooter />
    </section>
  );
}

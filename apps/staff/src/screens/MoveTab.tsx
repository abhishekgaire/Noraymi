import { useEffect, useRef, useState } from "react";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Move tab to a room (M6-13; spec 10 · Move tab to a room; Payment flows · Moving a tab into a room;
 * Rail note 7): pick a room that's in use, and every line on the tab moves to the room's check as a
 * transfer. The tab closes as "Moved to Room 9", and its hold is released once the room has a payment
 * method. Alcohol can't move onto a cut-off room: the server refuses it with the cut-off's reason.
 */
export interface RoomInUse {
  readonly room_id: string;
  readonly name: string;
  readonly session: {
    readonly id: string;
    readonly check_id: string | null;
    readonly guest_name: string | null;
    readonly cut_off: { readonly by: string | null } | null;
  } | null;
}

export const newKey = (what: string) =>
  `${what}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** What a move answers (M6-13), with whether Undo can put it back (U-12). */
export interface MoveAnswer {
  readonly room: string;
  readonly hold: "released" | "kept" | "none";
  readonly undoable: boolean;
}

/** "Moved to Room 9", with what happened to the hold. */
export function movedLine(t: ReturnType<typeof useT>["t"], r: MoveAnswer): string {
  const moved = t("moveTab.moved", { room: r.room });
  return r.hold === "released"
    ? `${moved} · ${t("moveTab.holdReleased", { room: r.room })}`
    : r.hold === "kept"
      ? `${moved} · ${t("moveTab.holdKept", { room: r.room })}`
      : moved;
}

/** A move's refusal in words (M6-13): a cut-off room with its reason, the closed window, or the server's. */
export function moveRefusal(
  t: ReturnType<typeof useT>["t"],
  e: unknown,
  room: string,
): { error: string; reason: string | null } {
  if (e instanceof ApiCallError && e.code === "cut_off") {
    const cut = e.details["cut_off"] as { reason?: string | null } | undefined;
    return { error: t("moveTab.cutOff", { room }), reason: cut?.reason ?? null };
  }
  if (e instanceof ApiCallError && e.code === "alcohol_closed")
    return { error: t("moveTab.closedWindow"), reason: null };
  return { error: e instanceof ApiCallError ? e.message : t("fix.failed"), reason: null };
}

export function MoveToRoom(props: {
  venueId: string;
  tabId: string;
  rooms: readonly RoomInUse[];
  onMoved: (message: string, roomId: string, undoable: boolean) => void;
  onClose: () => void;
  /** Move to a new room (U-12): opens the walk-in sheet; absent where the venue has no rooms. */
  onNewRoom?: (() => void) | undefined;
  /** The bar computer is offline: nothing moves. */
  offline?: boolean;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const inUse = props.rooms.filter((r) => r.session?.check_id);

  const move = async (room: RoomInUse) => {
    setBusy(true);
    setError(null);
    setReason(null);
    try {
      const r = await api<MoveAnswer>(
        "POST",
        `/v1/venues/${props.venueId}/tabs/${props.tabId}/move-to-room`,
        { session_id: room.session!.id },
        { idempotencyKey: newKey("move") },
      );
      props.onMoved(movedLine(t, r), room.room_id, r.undoable);
    } catch (e) {
      const why = moveRefusal(t, e, room.name);
      setError(why.error);
      setReason(why.reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="move-tab" aria-label={t("moveTab.button")}>
      <h3>{t("moveTab.button")}</h3>
      {/* U-12 (D133): seat the party in a free room and the tab goes with them, in one flow. */}
      {props.onNewRoom && (
        <>
          <button
            type="button"
            className="primary move-new-room"
            disabled={busy || props.offline}
            onClick={props.onNewRoom}
          >
            {t("moveTab.newRoom")}
          </button>
          <p className="small muted">{t("moveTab.newRoomHint")}</p>
        </>
      )}
      {props.offline && (
        <p className="small muted" role="status">
          {t("moveTab.offline")}
        </p>
      )}
      <p className="small muted">{t("moveTab.hint")}</p>
      {inUse.length === 0 && <p className="muted">{t("moveTab.none")}</p>}
      <ul className="rail-list">
        {inUse.map((room) => (
          <li key={room.room_id}>
            <button
              type="button"
              className="secondary move-room"
              disabled={busy || props.offline}
              onClick={() => void move(room)}
            >
              <span data-guest-text>{room.name}</span>
              {room.session?.guest_name && (
                <span className="small" data-guest-text>
                  {room.session.guest_name}
                </span>
              )}
              {room.session?.cut_off && <span className="chip warn">{t("rail.badge.cutOff")}</span>}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
          {reason && (
            <>
              {" "}
              {t("moveTab.reason")} <span data-guest-text>{reason}</span>
            </>
          )}
        </p>
      )}
      <button type="button" className="link" onClick={props.onClose}>
        {t("closeTab.back")}
      </button>
    </section>
  );
}

/** How long Undo shows after a move (U-12, D133); the server takes it a little longer for a slow network. */
export const UNDO_MOVE_MS = 10_000;

/**
 * "Moved to Room 9 · Undo" (U-12, D133): for 10 seconds after a move, Undo puts every drink back on the
 * tab (`POST /tabs/{t}/undo-move`, audited like the move). The server refuses it, with nothing changed,
 * once anything happened on the room's check, the hold is being released, or the window has passed.
 */
export function MoveUndo(props: {
  venueId: string;
  tabId: string;
  tabName: string;
  room: string;
  message: string;
  undoable: boolean;
  /** A party seated for the move stays seated: Undo says so. */
  seated: boolean;
  offline: boolean;
  onUndone: (message: string) => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(props.undoable);
  useEffect(() => {
    if (!props.undoable) return;
    const timer = window.setTimeout(() => setOpen(false), UNDO_MOVE_MS);
    return () => window.clearTimeout(timer);
  }, [props.undoable]);

  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/v1/venues/${props.venueId}/tabs/${props.tabId}/undo-move`, undefined, {
        idempotencyKey: newKey("undo-move"),
      });
      const back = t("moveTab.undone", { name: props.tabName });
      props.onUndone(
        props.seated ? `${back} · ${t("moveTab.stillSeated", { room: props.room })}` : back,
      );
    } catch (e) {
      setOpen(false);
      const reason = e instanceof ApiCallError ? e.details["reason"] : null;
      setError(
        e instanceof ApiCallError && e.code === "cut_off"
          ? t("moveTab.undoCutOff", { name: props.tabName })
          : e instanceof ApiCallError && e.code === "alcohol_closed"
            ? t("moveTab.closedWindow")
            : reason === "undo_expired"
              ? t("moveTab.undoExpired", { room: props.room })
              : reason === "room_changed" || reason === "room_paying"
                ? t("moveTab.undoRoomChanged", { room: props.room })
                : reason === "hold_released"
                  ? t("moveTab.undoHoldReleased")
                  : reason === "not_yours"
                    ? t("moveTab.undoNotYours")
                    : e instanceof ApiCallError
                      ? e.message
                      : t("fix.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="move-undo" role="status">
      <span className="small">{props.message}</span>
      {open && (
        <button
          type="button"
          className="secondary move-undo-button"
          disabled={busy || props.offline}
          onClick={() => void undo()}
        >
          {t("moveTab.undo")}
        </button>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface Reader {
  readonly id: string;
  readonly registered: boolean;
  readonly online: boolean;
  readonly station: "bar" | "front_desk";
}
interface Tap {
  readonly id: string;
  readonly state: "waiting" | "saved" | "failed" | "canceled";
  readonly card: { readonly brand: string | null; readonly last4: string } | null;
}

/**
 * A card tapped for a room (M6-13): for a walk-in with no saved card, the bar reader saves a card
 * without charging it (a SetupIntent, `process_setup_intent`), after the bartender reads out the consent
 * line. Once it's saved, the holds of bar tabs moved into the room are released.
 */
export function RoomCardTap(props: {
  venueId: string;
  checkId: string;
  room: string;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState<{ version_id: string; text: string } | null>(null);
  const [tap, setTap] = useState<Tap | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
    },
    [],
  );

  const start = async () => {
    setOpen(true);
    setProblem(null);
    try {
      setConsent(await api("GET", `/v1/venues/${props.venueId}/room-card-consent`));
    } catch {
      setProblem(t("fix.failed"));
    }
  };
  const poll = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(() => {
      api<Tap>("POST", `/v1/venues/${props.venueId}/checks/${props.checkId}/card-tap/check-status`)
        .then((x) => {
          setTap(x);
          if (x.state !== "waiting" && timer.current) {
            window.clearInterval(timer.current);
            timer.current = null;
            if (x.state === "saved") props.onSaved();
          }
        })
        .catch(() => undefined);
    }, 1000);
  };
  const read = async () => {
    if (!consent) return;
    setBusy(true);
    setProblem(null);
    try {
      const readers = await api<{ readers: Reader[] }>(
        "GET",
        `/v1/venues/${props.venueId}/readers`,
      );
      const bar = readers.readers
        .filter((r) => r.registered && r.station === "bar")
        .sort((a, b) => Number(b.online) - Number(a.online))[0];
      if (!bar) {
        setProblem(t("newTab.noReader"));
        return;
      }
      const x = await api<Tap>(
        "POST",
        `/v1/venues/${props.venueId}/checks/${props.checkId}/card-tap`,
        { reader_id: bar.id, consent_text_version: consent.version_id },
        { idempotencyKey: newKey("room-card") },
      );
      setTap(x);
      if (x.state === "waiting") poll();
      else if (x.state === "saved") props.onSaved();
    } catch (e) {
      setProblem(
        e instanceof ApiCallError && e.code === "reader_offline"
          ? t("newTab.readerOffline")
          : e instanceof ApiCallError
            ? e.message
            : t("fix.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    try {
      setTap(
        await api<Tap>(
          "POST",
          `/v1/venues/${props.venueId}/checks/${props.checkId}/card-tap/cancel`,
        ),
      );
    } catch {
      setTap(null);
    }
  };

  if (!open)
    return (
      <button type="button" className="secondary" onClick={() => void start()}>
        {t("roomCard.button", { room: props.room })}
      </button>
    );
  return (
    <section className="room-card" aria-label={t("roomCard.button", { room: props.room })}>
      {!consent && !problem && <p role="status">{t("shell.loading")}</p>}
      {consent && !tap && (
        <>
          <p className="small muted">{t("newTab.readOut")}</p>
          <blockquote className="consent" data-guest-text>
            {consent.text}
          </blockquote>
          <button type="button" className="primary" disabled={busy} onClick={() => void read()}>
            {t("newTab.read")}
          </button>
        </>
      )}
      {tap?.state === "waiting" && (
        <>
          <p role="status">{t("roomCard.waiting")}</p>
          <button type="button" className="secondary" onClick={() => void cancel()}>
            {t("pay.cancel")}
          </button>
        </>
      )}
      {tap?.state === "saved" && <p role="status">{t("roomCard.saved")}</p>}
      {(tap?.state === "failed" || tap?.state === "canceled") && (
        <>
          <p role="alert">{tap.state === "failed" ? t("roomCard.failed") : t("pay.canceled")}</p>
          <button type="button" className="secondary" onClick={() => setTap(null)}>
            {t("pay.tapAgain")}
          </button>
        </>
      )}
      {problem && <p role="alert">{problem}</p>}
    </section>
  );
}

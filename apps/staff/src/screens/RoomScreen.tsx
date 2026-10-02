import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { Temporal } from "@west4/shared";
import { api } from "../api.js";
import { useClock } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import { AddDrinks } from "./AddDrinks.js";
import { FixPanel, type PendingFix } from "./FixPanel.js";
import { PresentCheck } from "./PresentCheck.js";
import { CutOffRoom } from "./CutOff.js";
import { DamageSheet } from "./DamageSheet.js";
import { FaultSheet, type FaultTarget } from "./FaultSheet.js";
import { MoveSheet } from "./MoveSheet.js";
import { ScanId } from "./ScanId.js";

/**
 * DeskRoom on the desktop and Room on the phone (M2-31; screens DeskRoom and
 * Room): the clock with its rate, the running tab (room time so far and the
 * check's lines, before tax and gratuity), the deposit that comes off at
 * settle-up, party size, the ID chip, Move, Report a fault, the damage fee,
 * calls and notes. It never marks a room paid; paying comes in M4.
 */
interface BoardRoom {
  readonly room_id: string;
  readonly name: string;
  readonly session: {
    readonly id: string;
    readonly check_id: string | null;
    readonly guest_name: string | null;
    readonly party_size: number;
    readonly ids_checked: number;
    readonly minutes: number;
    readonly room_time_cents: number;
    readonly tab_so_far_cents: number;
    readonly deposit_cents: number;
    readonly booked_end_at: string | null;
    readonly hourly_cents: number;
    readonly stay_on_offer: boolean;
    readonly wrap_up: boolean;
    readonly close: string | null;
    readonly cut_off: { readonly at: string; readonly by: string | null } | null;
  } | null;
  readonly next: { readonly name: string; readonly party_size: number; readonly at: string } | null;
  readonly notes: readonly { readonly id: string; readonly text: string }[];
  readonly faults: readonly { readonly id: string; readonly text: string }[];
  readonly calls: readonly {
    readonly id: string;
    readonly kind: "mic" | "tv" | "check" | "other";
  }[];
}
interface Line {
  readonly id: number;
  readonly kind: string;
  readonly description: string;
  readonly qty: number;
  readonly amount_cents: number;
  readonly reverses_id?: number | null;
}

export function RoomScreen() {
  const { t, money } = useT();
  const { roomId = "" } = useParams();
  const { state } = useSession();
  const { now } = useClock();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [room, setRoom] = useState<BoardRoom | null>(null);
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [pendingFixes, setPendingFixes] = useState<readonly PendingFix[]>([]);
  const [checkStatus, setCheckStatus] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sheet, setSheet] = useState<"move" | "fault" | "damage" | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const board = await api<{ rooms: BoardRoom[] }>("GET", `/v1/venues/${venueId}/board`);
      const r = board.rooms.find((x) => x.room_id === roomId) ?? null;
      setRoom(r);
      setMissing(!r);
      if (r?.session) {
        const [session, check] = await Promise.all([
          api<{ session: { started_at: string } }>(
            "GET",
            `/v1/venues/${venueId}/sessions/${r.session.id}`,
          ),
          r.session.check_id
            ? api<{ lines: Line[]; pending_fixes: PendingFix[]; check?: { status: string } }>(
                "GET",
                `/v1/venues/${venueId}/checks/${r.session.check_id}`,
              )
            : Promise.resolve({
                lines: [] as Line[],
                pending_fixes: [] as PendingFix[],
                check: undefined as { status: string } | undefined,
              }),
        ]);
        setStartedAt(session.session.started_at);
        setLines(check.lines);
        setPendingFixes(check.pending_fixes ?? []);
        setCheckStatus(check.check?.status ?? null);
      } else {
        setLines([]);
        setStartedAt(null);
      }
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId, roomId]);

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
          events.some((e) =>
            ["room.updated", "session.updated", "check.updated", "room.call"].includes(e.type),
          )
        )
          void load();
      }),
    [subscribe, load],
  );

  const short = (iso: string) => {
    const z = Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone);
    const h = z.hour % 12 === 0 ? 12 : z.hour % 12;
    return z.minute === 0 && iso === room?.session?.close
      ? `${h} ${z.hour < 12 ? "AM" : "PM"}`
      : `${h}:${String(z.minute).padStart(2, "0")}`;
  };
  const minutes =
    startedAt && now
      ? Math.max(
          0,
          Math.floor(
            (now.epochMilliseconds - Temporal.Instant.from(startedAt).epochMilliseconds) / 60_000,
          ),
        )
      : (room?.session?.minutes ?? 0);

  const changeParty = async (partySize: number) => {
    if (!room?.session || partySize < 1) return;
    try {
      await api("POST", `/v1/venues/${venueId}/sessions/${room.session.id}/party-size`, {
        party_size: partySize,
      });
      await load();
    } catch {
      setFailed(true);
    }
  };
  const ack = async (callId: string) => {
    try {
      await api("POST", `/v1/venues/${venueId}/calls/${callId}/ack`);
      await load();
    } catch {
      setFailed(true);
    }
  };
  const addNote = async (e: FormEvent) => {
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

  if (missing)
    return (
      <section className="screen">
        <p>{t("room.notFound")}</p>
        <Link to="/tonight">{t("room.back")}</Link>
      </section>
    );
  if (!room)
    return (
      <section className="screen">
        {failed ? (
          <p className="error" role="alert">
            {t("shell.error.cantReach")}
          </p>
        ) : (
          <p role="status">{t("shell.loading")}</p>
        )}
      </section>
    );

  const s = room.session;
  const drinks = lines.filter((l) => l.kind === "item").reduce((sum, l) => sum + l.amount_cents, 0);
  const faultTarget: FaultTarget = { roomId: room.room_id, roomName: room.name, hasSession: !!s };

  return (
    <section className="screen room-screen">
      <Link className="small" to="/tonight">
        {t("room.back")}
      </Link>
      <h1>{room.name}</h1>
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
      {sheet === "move" && s && (
        <MoveSheet
          venueId={venueId}
          timeZone={timeZone}
          sessionId={s.id}
          roomName={room.name}
          onClose={() => setSheet(null)}
          onMoved={(line) => {
            setSheet(null);
            setDone(line);
          }}
        />
      )}
      {sheet === "fault" && (
        <FaultSheet
          venueId={venueId}
          target={faultTarget}
          onClose={() => setSheet(null)}
          onLogged={(line) => {
            setSheet(null);
            setDone(line);
            void load();
          }}
        />
      )}
      {sheet === "damage" && s?.check_id && (
        <DamageSheet
          venueId={venueId}
          checkId={s.check_id}
          roomName={room.name}
          onClose={() => {
            setSheet(null);
            void load();
          }}
        />
      )}
      {s ? (
        <>
          {s.guest_name && <p>{t("board.party", { name: s.guest_name, party: s.party_size })}</p>}
          <p className="big" aria-label={t("room.clock")}>
            {t("room.rate", {
              min: minutes,
              rate: money(Math.round(s.hourly_cents / 60) as never),
            })}
          </p>
          {s.stay_on_offer && s.close && (
            <p className="notice">{t("session.stayOn", { time: short(s.close) })}</p>
          )}
          {s.wrap_up && room.next && (
            <p className="notice error">
              {t("room.wrapUp", { name: room.next.name, time: short(room.next.at) })}
            </p>
          )}
          <section aria-label={t("room.tab")} className="tab">
            <h2>{t("room.tab")}</h2>
            <dl>
              <dt>{t("room.roomTime")}</dt>
              <dd>{money(s.room_time_cents as never)}</dd>
              {lines.map((l) => (
                <div key={l.id} className="tab-line">
                  <dt>{l.qty > 1 ? `${l.qty} × ${l.description}` : l.description}</dt>
                  <dd>{money(l.amount_cents as never)}</dd>
                </div>
              ))}
              <dt>{t("room.drinks")}</dt>
              <dd>{money(drinks as never)}</dd>
              <dt>
                <strong>{t("room.tabSoFar")}</strong>
              </dt>
              <dd>
                <strong>{money(s.tab_so_far_cents as never)}</strong>
              </dd>
            </dl>
            <p className="small muted">{t("room.beforeTax")}</p>
            {s.deposit_cents > 0 && (
              <p className="small">
                {t("room.deposit", { amount: money(s.deposit_cents as never) })}
              </p>
            )}
          </section>
          {s.check_id &&
            checkStatus &&
            signedIn?.membership.permissions.includes("payments.take") && (
              <PresentCheck
                venueId={venueId}
                checkId={s.check_id}
                status={checkStatus}
                canReopen={
                  signedIn.membership.role === "owner" || signedIn.membership.role === "manager"
                }
                onDone={() => void load()}
              />
            )}
          <CutOffRoom
            venueId={venueId}
            sessionId={s.id}
            roomName={room.name}
            timeZone={timeZone}
            cutOff={s.cut_off}
            canCutOff={signedIn?.membership.permissions.includes("cutoff.apply") ?? false}
            onDone={() => void load()}
            guests
          />
          {s.check_id && signedIn?.membership.permissions.includes("comps.reasonOnly") && (
            <FixPanel
              venueId={venueId}
              checkId={s.check_id}
              lines={lines}
              pending={pendingFixes}
              onDone={() => void load()}
            />
          )}
          {s.check_id && signedIn?.membership.permissions.includes("orders.accept") && (
            <AddDrinks
              venueId={venueId}
              checkId={s.check_id}
              sessionId={s.id}
              onSent={() => void load()}
            />
          )}
          <div className="party-size">
            <button
              type="button"
              className="icon-button"
              aria-label={t("party.fewer")}
              disabled={s.party_size <= 1}
              onClick={() => void changeParty(s.party_size - 1)}
            >
              −
            </button>
            <span>{t("party.size", { n: s.party_size })}</span>
            <button
              type="button"
              className="icon-button"
              aria-label={t("party.more")}
              onClick={() => void changeParty(s.party_size + 1)}
            >
              +
            </button>
          </div>
          <p className="small">{t("ids.chip", { checked: s.ids_checked, party: s.party_size })}</p>
          {signedIn?.membership.modules.safety !== "off" && (
            <ScanId venueId={venueId} sessionId={s.id} onScanned={() => void load()} />
          )}
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setSheet("move")}>
              {t("move.button")}
            </button>
            <button type="button" className="secondary" onClick={() => setSheet("fault")}>
              {t("fault.report")}
            </button>
            {s.check_id && (
              <button type="button" className="secondary" onClick={() => setSheet("damage")}>
                {t("damage.button")}
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="actions">
          <button type="button" className="secondary" onClick={() => setSheet("fault")}>
            {t("fault.report")}
          </button>
        </div>
      )}
      {room.calls.length > 0 && (
        <section aria-label={t("calls.title")}>
          <h2>{t("calls.title")}</h2>
          <ul className="faults">
            {room.calls.map((k) => (
              <li key={k.id}>
                {t(`calls.kind.${k.kind}`)}{" "}
                <button type="button" className="primary" onClick={() => void ack(k.id)}>
                  {t("calls.onIt")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {room.faults.length > 0 && (
        <ul className="faults">
          {room.faults.map((f) => (
            <li key={f.id} className="small">
              {f.text}
            </li>
          ))}
        </ul>
      )}
      <section aria-label={t("room.notes")}>
        <h2>{t("room.notes")}</h2>
        <ul className="faults">
          {room.notes.map((n) => (
            <li key={n.id} className="small">
              {n.text}
            </li>
          ))}
        </ul>
        <form className="actions" onSubmit={(e) => void addNote(e)}>
          <label className="grow">
            {t("room.addNote")}
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="submit" className="secondary" disabled={!note.trim()}>
            {t("room.saveNote")}
          </button>
        </form>
      </section>
    </section>
  );
}

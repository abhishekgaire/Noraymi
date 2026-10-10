import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { Temporal } from "@west4/shared";
import { api } from "../api.js";
import { useClock } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import { AddDrinks } from "./AddDrinks.js";
import { FoodMark, UnsentReminder, type CheckFood } from "./SendToKitchen.js";
import { FixPanel, type PendingFix } from "./FixPanel.js";
import { PresentCheck } from "./PresentCheck.js";
import { TapPayment } from "./TapPayment.js";
import { CardOnFile, type OnFile } from "./CardOnFile.js";
import { ReceiptStep } from "./ReceiptStep.js";
import { RefundSheet } from "./RefundSheet.js";
import { CashPanel, CashResult, type Taken } from "./CashPanel.js";
import { SplitPanel, type Share, type Split } from "./SplitPanel.js";
import { CutOffRoom } from "./CutOff.js";
import { DamageSheet } from "./DamageSheet.js";
import { FaultSheet, type FaultTarget } from "./FaultSheet.js";
import { MoveSheet } from "./MoveSheet.js";
import { ScanId } from "./ScanId.js";
import "./desk.css";

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
    /** What's left to the minimum spend (M4-27); null with none. */
    readonly min_spend_left_cents?: number | null;
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
/** A payment on the check, as the room tab lists it (M4-18). */
interface PaidLine {
  readonly kind: "card" | "cash" | "online" | "card_on_file" | "share" | "other";
  readonly amount_cents: number;
  readonly last4: string | null;
  readonly name: string | null;
  readonly share_no: number | null;
  readonly shares: number | null;
}
/** The presented check (M4-20): what close-out works from. */
interface Presented {
  readonly label: string;
  readonly revision: number;
  readonly subtotal_cents: number;
  readonly tax_cents: number;
  readonly gratuity_cents: number;
  readonly total_cents: number;
  readonly deposit_cents: number;
}
/** Lines finalize works out (room time, tax, gratuity): the tab shows them as totals, not as items. */
const COMPUTED = new Set(["room_time", "min_spend", "tax", "gratuity"]);
interface Line {
  readonly id: number;
  readonly kind: string;
  readonly description: string;
  readonly qty: number;
  readonly amount_cents: number;
  readonly reverses_id?: number | null;
  /** Food (K-05): Not sent, or Sent · 11:42. */
  readonly kitchen?: CheckFood;
}

export function RoomScreen() {
  const { t, money } = useT();
  const paidLabel = (p: PaidLine) => {
    const amount = money(p.amount_cents as never);
    if (p.kind === "share" && p.share_no !== null)
      return `${t("yourBill.paidBy.share", { name: p.name ?? "", n: p.share_no, of: p.shares ?? p.share_no })} ${amount}`;
    if ((p.kind === "card" || p.kind === "card_on_file") && p.last4)
      return `${t("yourBill.paidBy.card", { last4: p.last4 })} ${amount}`;
    if (p.kind === "cash") return `${t("yourBill.paidBy.cash")} ${amount}`;
    if (p.kind === "online") return `${t("yourBill.paidBy.online")} ${amount}`;
    return `${t("yourBill.paidBy.other")} ${amount}`;
  };
  const { roomId = "" } = useParams();
  const { state } = useSession();
  const { now } = useClock();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [room, setRoom] = useState<BoardRoom | null>(null);
  const [lines, setLines] = useState<readonly Line[]>([]);
  // Food not sent to the kitchen (K-05): shown with Send to kitchen before the check is presented or paid.
  const [unsentFood, setUnsentFood] = useState(0);
  const [kitchenRequest, setKitchenRequest] = useState(0);
  const [pendingFixes, setPendingFixes] = useState<readonly PendingFix[]>([]);
  const [holds, setHolds] = useState<readonly { tab_id: string; name: string; cents: number }[]>(
    [],
  );
  const [checkStatus, setCheckStatus] = useState<string | null>(null);
  const [dueCents, setDueCents] = useState(0);
  const [cashTaken, setCashTaken] = useState<Taken | null>(null);
  const [split, setSplit] = useState<Split | null>(null);
  const [onFile, setOnFile] = useState<OnFile | null>(null);
  const [paidLines, setPaidLines] = useState<readonly PaidLine[]>([]);
  const [presented, setPresented] = useState<Presented | null>(null);
  // The session's check, kept after the room is released: paid in full (on this screen or elsewhere,
  // by a guest's phone or a card on file), the room goes to cleaning before a panel hears it, so the
  // screen reads the check once when the session is gone and offers the receipt (M4-20).
  const lastCheck = useRef<string | null>(null);
  const [paidCheck, setPaidCheck] = useState<string | null>(null);
  const [refunding, setRefunding] = useState(false);
  const paidWords = useRef("");
  paidWords.current = t("pay.paid");
  const [share, setShare] = useState<Share | null>(null);
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
            ? api<{
                lines: Line[];
                pending_fixes: PendingFix[];
                holds?: { tab_id: string; name: string; cents: number }[];
                amount_due_cents?: number;
                split?: Split | null;
                on_file?: OnFile | null;
                payments?: PaidLine[];
                deposit_cents?: number;
                check?: { status: string; label?: string };
                totals?: Omit<Presented, "label" | "deposit_cents"> | null;
              }>("GET", `/v1/venues/${venueId}/checks/${r.session.check_id}`)
            : Promise.resolve({
                lines: [] as Line[],
                pending_fixes: [] as PendingFix[],
                check: undefined as { status: string; label?: string } | undefined,
                amount_due_cents: 0,
              }),
        ]);
        setStartedAt(session.session.started_at);
        setLines(check.lines);
        setPendingFixes(check.pending_fixes ?? []);
        setHolds(("holds" in check ? check.holds : null) ?? []);
        setCheckStatus(check.check?.status ?? null);
        setDueCents(check.amount_due_cents ?? 0);
        setSplit(("split" in check ? check.split : null) ?? null);
        setPaidLines(("payments" in check ? check.payments : null) ?? []);
        const status = check.check?.status;
        setPresented(
          status &&
            ["finalized", "partly_paid", "paid"].includes(status) &&
            "totals" in check &&
            check.totals
            ? {
                ...check.totals,
                label: check.check?.label ?? "",
                deposit_cents: ("deposit_cents" in check ? check.deposit_cents : 0) ?? 0,
              }
            : null,
        );
        const file = ("on_file" in check ? check.on_file : null) ?? null;
        setOnFile(file);
        lastCheck.current = r.session.check_id;
        if (check.check?.status === "paid") setPaidCheck(r.session.check_id);
      } else {
        setLines([]);
        setStartedAt(null);
        const last = lastCheck.current;
        lastCheck.current = null;
        if (last) {
          const c = await api<{ check: { status: string } }>(
            "GET",
            `/v1/venues/${venueId}/checks/${last}`,
          );
          if (c.check.status === "paid") {
            setDone(paidWords.current);
            setPaidCheck(last);
          }
        }
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
      const r = await api<{ status?: string; waiting_for?: { name: string } }>(
        "POST",
        `/v1/venues/${venueId}/sessions/${room.session.id}/party-size`,
        { party_size: partySize },
      );
      // Fewer guests after the gratuity applies waits for a manager (M4-23).
      if (r.status === "approval_pending" && r.waiting_for)
        setDone(t("approvals.waitingFor", { name: r.waiting_for.name.split(" ")[0] ?? "" }));
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
  // Drinks moved in from a bar tab are the room's items too (M6-13).
  const drinks = lines
    .filter((l) => l.kind === "item" || l.kind === "transfer_in")
    .reduce((sum, l) => sum + l.amount_cents, 0);
  const faultTarget: FaultTarget = { roomId: room.room_id, roomName: room.name, hasSession: !!s };

  return (
    <section className="screen room-screen desk">
      <div className="desk-head">
        <Link className="small desk-back" to="/tonight">
          {t("room.back")}
        </Link>
        <h1>{room.name}</h1>
        {s?.guest_name && (
          <p className="desk-sub">
            {t("board.party", { name: s.guest_name, party: s.party_size })}
          </p>
        )}
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
      {cashTaken && <CashResult venueId={venueId} taken={cashTaken} />}
      {paidCheck && <ReceiptStep venueId={venueId} checkId={paidCheck} roomName={room.name} />}
      {paidCheck && signedIn?.membership.permissions.includes("refunds.request") && (
        <button type="button" className="secondary" onClick={() => setRefunding(true)}>
          {t("refund.button")}
        </button>
      )}
      {paidCheck && refunding && (
        <RefundSheet venueId={venueId} checkId={paidCheck} onClose={() => setRefunding(false)} />
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
      <div className="desk-cols desk-room-cols">
        <div className="desk-col">
          {s && (
            <div className="desk-card desk-clock">
              <p className="desk-label">{t("room.clock")}</p>
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
              <p className="small">
                {t("ids.chip", { checked: s.ids_checked, party: s.party_size })}
              </p>
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
            </div>
          )}
          {room.calls.length > 0 && (
            <section className="desk-card alert-card" aria-label={t("calls.title")}>
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
          <section className="desk-card" aria-label={t("room.notes")}>
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
        </div>
        {s ? (
          <>
            <div className="desk-col desk-card">
              <section aria-label={t("room.tab")} className="tab">
                <h2>{t("room.tab")}</h2>
                <dl>
                  <dt>{t("room.roomTime")}</dt>
                  <dd>{money(s.room_time_cents as never)}</dd>
                  {lines
                    .filter((l) => !COMPUTED.has(l.kind))
                    .map((l) => (
                      <div key={l.id} className="tab-line">
                        <dt>
                          {l.qty > 1 ? `${l.qty} × ${l.description}` : l.description}
                          {l.kitchen && s.check_id && (
                            <FoodMark
                              venueId={venueId}
                              checkId={s.check_id}
                              lineId={l.id}
                              label={l.description}
                              food={l.kitchen}
                              timeZone={timeZone}
                              canRemove
                              onDone={() => void load()}
                            />
                          )}
                        </dt>
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
                {(s.min_spend_left_cents ?? 0) > 0 && (
                  <p className="small">
                    {t("minSpend.left", { amount: money(s.min_spend_left_cents as never) })}
                  </p>
                )}
                {s.deposit_cents > 0 && (
                  <p className="small">
                    {t("room.deposit", { amount: money(s.deposit_cents as never) })}
                  </p>
                )}
                {/* A bar tab moved in while the room has no card (M6-13): its hold, with its name. */}
                {holds.map((h) => (
                  <p key={h.tab_id} className="small">
                    {t("moveTab.roomHold", { amount: money(h.cents as never), name: h.name })}
                  </p>
                ))}
              </section>
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
                  onUnsentFood={setUnsentFood}
                  kitchenRequest={kitchenRequest}
                  onSent={() => void load()}
                />
              )}
            </div>
            <div className="desk-col desk-card desk-closeout">
              {presented && (
                <section className="presented" aria-label={presented.label}>
                  <h2>{presented.label}</h2>
                  <dl>
                    <dt>{t("receipt.subtotal")}</dt>
                    <dd>{money(presented.subtotal_cents as never)}</dd>
                    <dt>{t("closeOut.tax")}</dt>
                    <dd>{money(presented.tax_cents as never)}</dd>
                    <dt>{t("closeOut.gratuity")}</dt>
                    <dd>{money(presented.gratuity_cents as never)}</dd>
                    <dt>
                      <strong>{t("receipt.total")}</strong>
                    </dt>
                    <dd>
                      <strong>{money(presented.total_cents as never)}</strong>
                    </dd>
                    {presented.deposit_cents > 0 && (
                      <>
                        <dt>{t("receipt.deposit")}</dt>
                        <dd>−{money(presented.deposit_cents as never)}</dd>
                      </>
                    )}
                    <dt>
                      <strong>{t("receipt.due")}</strong>
                    </dt>
                    <dd>
                      <strong>{money(dueCents as never)}</strong>
                    </dd>
                  </dl>
                </section>
              )}
              {s.check_id &&
                checkStatus &&
                signedIn?.membership.permissions.includes("payments.take") && (
                  <>
                    {unsentFood > 0 && (
                      <div className="kitchen-warning">
                        <UnsentReminder count={unsentFood} />
                        <button
                          type="button"
                          className="primary"
                          onClick={() => setKitchenRequest((n) => n + 1)}
                        >
                          {t("kitchen.send.button", { n: unsentFood })}
                        </button>
                      </div>
                    )}
                    <PresentCheck
                      venueId={venueId}
                      checkId={s.check_id}
                      status={checkStatus}
                      canReopen={
                        signedIn.membership.role === "owner" ||
                        signedIn.membership.role === "manager"
                      }
                      onDone={() => void load()}
                    />
                  </>
                )}
              {paidLines.length > 0 && (
                <section className="paid-lines" aria-label={t("room.payments")}>
                  <h3>{t("room.payments")}</h3>
                  <ul>
                    {paidLines.map((p, i) => (
                      <li key={i}>{paidLabel(p)}</li>
                    ))}
                  </ul>
                </section>
              )}
              {s.check_id &&
                (checkStatus === "finalized" || checkStatus === "partly_paid") &&
                dueCents > 0 &&
                signedIn?.membership.permissions.includes("payments.take") && (
                  <SplitPanel
                    venueId={venueId}
                    checkId={s.check_id}
                    split={split}
                    picked={share?.id ?? null}
                    onPick={setShare}
                    onChanged={() => void load()}
                  />
                )}
              {/* With a split, a share is picked first; without one, the check's amount due. */}
              {s.check_id &&
                (checkStatus === "finalized" ||
                  checkStatus === "partly_paid" ||
                  checkStatus === "paid") &&
                (!split || share) &&
                signedIn?.membership.permissions.includes("payments.take") && (
                  <TapPayment
                    key={`tap-${share?.id ?? "check"}`}
                    venueId={venueId}
                    checkId={s.check_id}
                    dueCents={share ? share.amount_cents : dueCents}
                    shareId={share?.id ?? null}
                    onDone={() => {
                      // Paid stays on screen after the room goes to cleaning (the receipt step comes in M4-19).
                      setShare(null);
                      setDone(t("pay.paid"));
                      void load();
                    }}
                  />
                )}
              {s.check_id &&
                onFile &&
                (checkStatus === "finalized" ||
                  checkStatus === "partly_paid" ||
                  checkStatus === "paid") &&
                !split &&
                signedIn?.membership.permissions.includes("payments.take") && (
                  <CardOnFile
                    venueId={venueId}
                    checkId={s.check_id}
                    dueCents={dueCents}
                    card={onFile}
                    onDone={() => {
                      setDone(t("pay.paid"));
                      void load();
                    }}
                  />
                )}
              {s.check_id &&
                (checkStatus === "finalized" || checkStatus === "partly_paid") &&
                (!split || share) &&
                signedIn?.membership.permissions.includes("payments.take") && (
                  <CashPanel
                    key={`cash-${share?.id ?? "check"}`}
                    venueId={venueId}
                    checkId={s.check_id}
                    dueCents={share ? share.amount_cents : dueCents}
                    shareId={share?.id ?? null}
                    onTaken={(taken) => {
                      setShare(null);
                      setCashTaken(taken);
                      void load();
                    }}
                  />
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
      </div>
    </section>
  );
}

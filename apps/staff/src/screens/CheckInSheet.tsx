import { useCallback, useEffect, useState, type FormEvent } from "react";
import { checkNumberLabel, type MessageKey } from "@west4/shared";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { useSheetDialog } from "../layout/Dialog.js";
import { useSession } from "../session.js";
import { HeldCardTake } from "./HeldCardTake.js";
import { RoomCardTap } from "./RoomCardTap.js";
import { lengthText } from "./room-start.js";

/**
 * The check-in sheet (M2-11; screens N10): the same on the board and on a
 * phone. 1 the party size with the billable minimum; 2 IDs checked, "x of n";
 * 3 the room; 4 the clock; 5 the deposit; 6 what seating sends (the room's QR
 * slip, the code by text, the QR by email). [+ Walk-in] opens it with a free
 * room and asks how long and, optionally, the guest's name, phone and email.
 * Presets are tap targets (D128), and on a wide screen it fits without a scroll.
 * Starting a room (P-04): a note on both; a walk-in is pay as you go or a
 * prepaid block of How long, or starts with a package that has a length.
 */
interface Preview {
  readonly guest_name: string | null;
  readonly party_size: number;
  readonly min_guests: number;
  readonly min_day: "friday" | "saturday" | "weeknight";
  readonly room_id: string;
  readonly room_name: string;
  readonly room_fits: boolean;
  readonly deposit_cents: number;
  readonly booked_start: string | null;
  /** What a walk-in's step 5 takes (D112); null for a booking. */
  readonly walk_in: "deposit" | "cardOnTab" | "cardBehindBar" | "nothing" | null;
  /** The same minimum every day (D128): the party line drops the day word. */
  readonly min_every_day: boolean;
  /** What seating sends (D128): the code text (when there's a phone) and the room's QR. */
  readonly sends: { readonly text: boolean; readonly qr: boolean };
  /** A booking's guest has a phone on file; null for a walk-in. */
  readonly host_phone: boolean | null;
}

interface Room {
  readonly room_id: string;
  readonly name: string;
}

interface Seated {
  readonly check_id: string;
  readonly room_name: string;
  readonly room_code: string;
  readonly check_number: number;
  readonly training?: boolean;
  readonly text: string;
  /** The room's join QR (F-07): printed, and emailed to the host when they gave an email. */
  readonly qr?: { readonly printed: boolean; readonly emailed: string | null };
}

/** A package a room can start with (P-04): one with a length and no choices to make. */
interface StartPackage {
  readonly id: string;
  readonly name: string;
  readonly price_cents: number;
  readonly minutes: number;
}

/** The party-size chips; "More" opens the number field. */
const PARTY_CHIPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** A typed US phone as E.164 ("(347) 555-0177" to "+13475550177"), or null when it isn't one. */
export function usE164(typed: string): string | null {
  const v = typed.trim();
  if (/^\+[1-9]\d{6,14}$/.test(v)) return v;
  const digits = v.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export type SheetTarget =
  | { readonly kind: "booking"; readonly bookingId: string; readonly name: string }
  | { readonly kind: "walk_in"; readonly roomId: string; readonly roomName: string };

export function CheckInSheet({
  venueId,
  timeZone,
  target,
  freeRooms,
  onDone,
  onClose,
}: {
  venueId: string;
  timeZone: string;
  target: SheetTarget;
  freeRooms: readonly Room[];
  onDone: (line: string) => void;
  onClose: () => void;
}) {
  const { t, money, time } = useT();
  const [party, setParty] = useState<number | null>(null);
  const [ids, setIds] = useState(0);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [startBooked, setStartBooked] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [minutes, setMinutes] = useState(120);
  // Starting a room (P-04): a note, pay as you go or a prepaid block, and a package with a length.
  const [note, setNote] = useState("");
  const [prepaid, setPrepaid] = useState(false);
  const [packages, setPackages] = useState<readonly StartPackage[]>([]);
  const [packageId, setPackageId] = useState("");
  const { state: sessionState } = useSession();
  const packagesOn =
    sessionState.status === "signedIn" && sessionState.membership.modules.packages !== "off";
  // "More" opens the number field for a party bigger than the chips.
  const [moreParty, setMoreParty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Card on the tab (D112): once seated, the sheet asks for the card before it's done.
  const [cardFor, setCardFor] = useState<{ checkId: string; line: string } | null>(null);
  // Keep the card behind the bar (O-08): the name on the card and its last 4, once seated.
  const [heldFor, setHeldFor] = useState<{ checkId: string; line: string } | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (target.kind === "booking") q.set("booking", target.bookingId);
    if (roomId ?? (target.kind === "walk_in" ? target.roomId : null))
      q.set("room", (roomId ?? (target as { roomId: string }).roomId)!);
    if (party !== null) q.set("party", String(party));
    const p = await api<Preview>("GET", `/v1/venues/${venueId}/check-in/preview?${q.toString()}`);
    setPreview(p);
    if (party === null) {
      setParty(p.party_size);
      setIds(p.party_size);
      if (p.party_size > PARTY_CHIPS[PARTY_CHIPS.length - 1]!) setMoreParty(true);
    }
    if (roomId === null) setRoomId(p.room_id);
  }, [venueId, target, party, roomId]);

  useEffect(() => {
    load().catch(() => setError(t("shell.error.cantReach")));
  }, [load, t]);

  // The packages a walk-in can start with (P-04); none shows no Package field at all.
  const walkInTarget = target.kind === "walk_in";
  useEffect(() => {
    if (!walkInTarget || !packagesOn) return;
    let live = true;
    api<{ packages: StartPackage[] }>("GET", `/v1/venues/${venueId}/package-menu?at_start=1`)
      .then((r) => live && setPackages(r.packages))
      .catch(() => live && setPackages([]));
    return () => {
      live = false;
    };
  }, [venueId, walkInTarget, packagesOn]);
  const pkg = packages.find((p) => p.id === packageId) ?? null;

  const rooms: Room[] = preview
    ? [
        { room_id: preview.room_id, name: preview.room_name },
        ...freeRooms.filter((r) => r.room_id !== preview.room_id),
      ]
    : [];

  // A new party size: IDs stay "all checked" when they were, and never more than the guests.
  const changeParty = (n: number) => {
    setIds((x) => (x === party ? n : Math.min(x, n)));
    setParty(n);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!preview || party === null || roomId === null) return;
    // The phone and email are optional (D128); either one needs the guest's name to go anywhere.
    const phoneE164 = phone.trim() ? usE164(phone) : null;
    if (target.kind === "walk_in" && !name.trim() && (phone.trim() || email.trim())) {
      setError(t("checkIn.nameNeeded"));
      return;
    }
    if (target.kind === "walk_in" && phone.trim() && !phoneE164) {
      setError(t("checkIn.phoneInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const seated =
        target.kind === "booking"
          ? await api<Seated>(
              "POST",
              `/v1/venues/${venueId}/bookings/${target.bookingId}/check-in`,
              {
                party_size: party,
                ids_checked: ids,
                room_id: roomId,
                start_at: startBooked ? "booked" : "now",
                ...(note.trim() ? { note: note.trim() } : {}),
              },
            )
          : await api<Seated>("POST", `/v1/venues/${venueId}/rooms/${roomId}/sessions`, {
              party_size: party,
              ids_checked: ids,
              minutes: pkg ? pkg.minutes : minutes,
              ...(note.trim() ? { note: note.trim() } : {}),
              ...(pkg ? { package_id: pkg.id } : { time: prepaid ? "prepaid" : "pay_as_you_go" }),
              ...(name.trim()
                ? {
                    guest: {
                      name: name.trim(),
                      phone_e164: phoneE164,
                      ...(email.trim() ? { email: email.trim() } : {}),
                    },
                  }
                : {}),
            });
      const line =
        t("checkIn.done", {
          room: seated.room_name,
          code: seated.room_code,
          // A practice check (training mode, M7-03) shows as T-0012.
          number: checkNumberLabel(seated.check_number, seated.training === true),
        }) + (seated.text === "not_sent" ? ` · ${t("checkIn.textNotSent")}` : "");
      if (target.kind === "walk_in" && preview.walk_in === "cardOnTab")
        setCardFor({ checkId: seated.check_id, line });
      else if (target.kind === "walk_in" && preview.walk_in === "cardBehindBar")
        setHeldFor({ checkId: seated.check_id, line });
      else onDone(line);
    } catch (err) {
      setError(
        (err as ApiCallError)?.code === "room_not_free"
          ? t("checkIn.roomNotFree")
          : t("checkIn.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const title =
    target.kind === "booking"
      ? t("checkIn.title", { name: target.name })
      : t("checkIn.walkInTitle", { room: target.roomName });
  const dlg = useSheetDialog(title);

  if (heldFor)
    return (
      <HeldCardTake
        venueId={venueId}
        checkId={heldFor.checkId}
        roomName={target.kind === "walk_in" ? target.roomName : ""}
        seatedLine={heldFor.line}
        onDone={onDone}
      />
    );
  if (cardFor)
    return (
      <RoomCardTap
        venueId={venueId}
        checkId={cardFor.checkId}
        roomName={target.kind === "walk_in" ? target.roomName : ""}
        seatedLine={cardFor.line}
        onDone={onDone}
      />
    );

  const lengths = [60, 90, 120, 180, 240];
  const hoursLabel = (m: number) => lengthText(t, m);
  const walkIn = target.kind === "walk_in";
  // Step 6 (D128): what seating will actually send, for this venue and what's typed right now.
  const sends: string[] = [];
  if (preview) {
    const named = name.trim() !== "";
    const hasPhone = walkIn ? named && phone.trim() !== "" : preview.host_phone === true;
    const hasEmail = walkIn && named && email.trim() !== "";
    if (preview.sends.qr) sends.push(t("checkIn.sends.qr"));
    if (hasPhone)
      sends.push(preview.sends.text ? t("checkIn.sends.text") : t("checkIn.sends.textsOff"));
    if (hasEmail && preview.sends.qr) sends.push(t("checkIn.sends.email"));
    if (!preview.sends.qr && !(hasPhone && preview.sends.text)) sends.push(t("checkIn.sends.none"));
  }

  return (
    <form
      className="sheet checkin-sheet"
      data-kind={target.kind}
      {...dlg.root}
      onSubmit={(e) => void submit(e)}
    >
      <h2 {...dlg.title}>{title}</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!preview || party === null ? (
        <>
          {!error && <p role="status">{t("shell.loading")}</p>}
          <div className="row">
            <button type="button" className="secondary" onClick={onClose}>
              {t("checkIn.cancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="checkin-cols">
            <div className="checkin-col">
              <fieldset className="checkin-field">
                <legend>{t("checkIn.step", { n: 1, label: t("checkIn.party") })}</legend>
                <div className="chips">
                  {PARTY_CHIPS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className="chip"
                      aria-pressed={!moreParty && party === n}
                      onClick={() => {
                        setMoreParty(false);
                        changeParty(n);
                      }}
                    >
                      {n}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={moreParty}
                    onClick={() => setMoreParty(true)}
                  >
                    {t("checkIn.partyMore")}
                  </button>
                  {moreParty && (
                    <input
                      type="number"
                      className="chip-input"
                      min={1}
                      aria-label={t("checkIn.partyCount")}
                      value={party}
                      onChange={(e) => changeParty(Math.max(1, Number(e.target.value) || 1))}
                    />
                  )}
                </div>
                <span className="small">
                  {t(
                    (preview.min_every_day
                      ? "checkIn.partyLine.everyDay"
                      : `checkIn.partyLine.${preview.min_day}`) as MessageKey,
                    { party, min: preview.min_guests },
                  )}
                </span>
              </fieldset>
              <fieldset className="checkin-field">
                <legend>{t("checkIn.step", { n: 2, label: t("checkIn.ids") })}</legend>
                <div className="chips">
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={ids === party}
                    onClick={() => setIds(party)}
                  >
                    {t("checkIn.idsAll")}
                  </button>
                  <button
                    type="button"
                    className="chip"
                    aria-label={t("checkIn.idsFewer")}
                    disabled={ids <= 0}
                    onClick={() => setIds((x) => Math.max(0, x - 1))}
                  >
                    −
                  </button>
                  <output className="ids-count" aria-live="polite">
                    {t("checkIn.idsLine", { checked: ids, party })}
                  </output>
                  <button
                    type="button"
                    className="chip"
                    aria-label={t("checkIn.idsMore")}
                    disabled={ids >= party}
                    onClick={() => setIds((x) => Math.min(party, x + 1))}
                  >
                    +
                  </button>
                </div>
                {ids < party && <span className="small">{t("checkIn.runnerChecks")}</span>}
              </fieldset>
              <label>
                <span>{t("checkIn.step", { n: 3, label: t("checkIn.room") })}</span>
                <select value={roomId ?? ""} onChange={(e) => setRoomId(e.target.value)}>
                  {rooms.map((r) => (
                    <option key={r.room_id} value={r.room_id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                {!preview.room_fits && (
                  <span className="small error">{t("checkIn.roomTooSmall")}</span>
                )}
              </label>
              <label>
                <span>{t("checkIn.note")}</span>
                <input
                  value={note}
                  maxLength={200}
                  autoComplete="off"
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
            </div>
            <div className="checkin-col">
              {walkIn && (
                <fieldset className="checkin-field">
                  <legend>{t("checkIn.step", { n: 4, label: t("checkIn.length") })}</legend>
                  <div className="chips">
                    {lengths.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className="chip"
                        disabled={pkg !== null}
                        aria-pressed={(pkg ? pkg.minutes : minutes) === m}
                        onClick={() => setMinutes(m)}
                      >
                        {hoursLabel(m)}
                      </button>
                    ))}
                  </div>
                  {/* P-04: pay as you go (the default) or a prepaid block of How long. */}
                  <div className="chips" role="group" aria-label={t("checkIn.time")}>
                    <button
                      type="button"
                      className="chip"
                      disabled={pkg !== null}
                      aria-pressed={!pkg && !prepaid}
                      onClick={() => setPrepaid(false)}
                    >
                      {t("checkIn.time.payAsYouGo")}
                    </button>
                    <button
                      type="button"
                      className="chip"
                      disabled={pkg !== null}
                      aria-pressed={pkg !== null || prepaid}
                      onClick={() => setPrepaid(true)}
                    >
                      {t("checkIn.time.prepaid")}
                    </button>
                  </div>
                </fieldset>
              )}
              {walkIn && packages.length > 0 && (
                <label>
                  <span>{t("checkIn.package")}</span>
                  <select value={packageId} onChange={(e) => setPackageId(e.target.value)}>
                    <option value="">{t("checkIn.package.none")}</option>
                    {packages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {t("checkIn.package.option", {
                          name: p.name,
                          length: hoursLabel(p.minutes),
                          price: money(p.price_cents as never),
                        })}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {target.kind === "booking" ? (
                <fieldset className="sheet-clock">
                  <legend>{t("checkIn.step", { n: 4, label: t("checkIn.clock") })}</legend>
                  <label className="switch-line">
                    <input
                      type="radio"
                      name="start"
                      checked={!startBooked}
                      onChange={() => setStartBooked(false)}
                    />
                    <span>{t("checkIn.startNow")}</span>
                  </label>
                  {preview.booked_start && (
                    <label className="switch-line">
                      <input
                        type="radio"
                        name="start"
                        checked={startBooked}
                        onChange={() => setStartBooked(true)}
                      />
                      <span>
                        {t("checkIn.startBooked", { time: time(preview.booked_start, timeZone) })}
                      </span>
                    </label>
                  )}
                </fieldset>
              ) : (
                <>
                  <label>
                    <span>{t("checkIn.guestName")}</span>
                    <input
                      value={name}
                      maxLength={80}
                      autoComplete="off"
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>{t("checkIn.guestPhone")}</span>
                    <input
                      type="tel"
                      inputMode="tel"
                      autoComplete="off"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>{t("walkIn.email")}</span>
                    <input
                      type="email"
                      autoComplete="off"
                      maxLength={254}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          </div>
          <p className="small checkin-next">
            <span>
              {t("checkIn.step", {
                n: 5,
                label:
                  preview.deposit_cents > 0
                    ? t("checkIn.deposit", { amount: `−${money(preview.deposit_cents as never)}` })
                    : preview.walk_in === "cardOnTab"
                      ? t("checkIn.walkInTakes.cardOnTab")
                      : preview.walk_in === "cardBehindBar"
                        ? t("checkIn.walkInTakes.cardBehindBar")
                        : preview.walk_in === "nothing"
                          ? t("checkIn.walkInTakes.nothing")
                          : t("checkIn.noDeposit"),
              })}
            </span>
            <span className="muted">{t("checkIn.step", { n: 6, label: sends.join(" · ") })}</span>
          </p>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !preview.room_fits}>
              {target.kind === "booking" ? t("checkIn.confirm") : t("checkIn.confirmWalkIn")}
            </button>
            <button type="button" className="secondary" onClick={onClose}>
              {t("checkIn.cancel")}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

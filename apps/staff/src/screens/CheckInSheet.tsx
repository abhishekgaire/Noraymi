import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { MessageKey } from "@west4/shared";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * The check-in sheet (M2-11; screens N10): the same on the board and on a
 * phone. 1 the party size with the billable minimum; 2 IDs checked, "x of n";
 * 3 the room; 4 the clock; 5 the deposit; 6 the room code, texted to the host.
 * [+ Walk-in] opens it with a free room and asks for the guest and how long.
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
}

interface Room {
  readonly room_id: string;
  readonly name: string;
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
  const [minutes, setMinutes] = useState(120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    }
    if (roomId === null) setRoomId(p.room_id);
  }, [venueId, target, party, roomId]);

  useEffect(() => {
    load().catch(() => setError(t("shell.error.cantReach")));
  }, [load, t]);

  const rooms: Room[] = preview
    ? [
        { room_id: preview.room_id, name: preview.room_name },
        ...freeRooms.filter((r) => r.room_id !== preview.room_id),
      ]
    : [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!preview || party === null || roomId === null) return;
    setBusy(true);
    setError(null);
    try {
      const seated =
        target.kind === "booking"
          ? await api<{ room_name: string; room_code: string; check_number: number; text: string }>(
              "POST",
              `/v1/venues/${venueId}/bookings/${target.bookingId}/check-in`,
              {
                party_size: party,
                ids_checked: ids,
                room_id: roomId,
                start_at: startBooked ? "booked" : "now",
              },
            )
          : await api<{ room_name: string; room_code: string; check_number: number; text: string }>(
              "POST",
              `/v1/venues/${venueId}/rooms/${roomId}/sessions`,
              {
                party_size: party,
                ids_checked: ids,
                minutes,
                ...(name.trim()
                  ? { guest: { name: name.trim(), phone_e164: phone.trim() || null } }
                  : {}),
              },
            );
      onDone(
        t("checkIn.done", {
          room: seated.room_name,
          code: seated.room_code,
          number: String(seated.check_number),
        }) + (seated.text === "not_sent" ? ` · ${t("checkIn.textNotSent")}` : ""),
      );
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

  return (
    <form className="sheet" role="dialog" aria-label={title} onSubmit={(e) => void submit(e)}>
      <h2>{title}</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!preview || party === null ? (
        <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          <label>
            <span>{t("checkIn.step", { n: 1, label: t("checkIn.party") })}</span>
            <input
              type="number"
              min={1}
              value={party}
              onChange={(e) => {
                const n = Math.max(1, Number(e.target.value) || 1);
                setParty(n);
                setIds((x) => Math.min(x, n));
              }}
            />
            <span className="small">
              {t(`checkIn.partyLine.${preview.min_day}` as MessageKey, {
                party,
                min: preview.min_guests,
              })}
            </span>
          </label>
          <label>
            <span>{t("checkIn.step", { n: 2, label: t("checkIn.ids") })}</span>
            <input
              type="number"
              min={0}
              max={party}
              value={ids}
              onChange={(e) => setIds(Math.min(party, Math.max(0, Number(e.target.value) || 0)))}
            />
            <span className="small">
              {t("checkIn.idsLine", { checked: ids, party })}
              {ids < party ? ` · ${t("checkIn.runnerChecks")}` : ""}
            </span>
          </label>
          <label>
            <span>{t("checkIn.step", { n: 3, label: t("checkIn.room") })}</span>
            <select value={roomId ?? ""} onChange={(e) => setRoomId(e.target.value)}>
              {rooms.map((r) => (
                <option key={r.room_id} value={r.room_id}>
                  {r.name}
                </option>
              ))}
            </select>
            {!preview.room_fits && <span className="small error">{t("checkIn.roomTooSmall")}</span>}
          </label>
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
                <span>{t("checkIn.step", { n: 4, label: t("checkIn.length") })}</span>
                <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                  {[60, 90, 120, 180, 240].map((m) => (
                    <option key={m} value={m}>
                      {t("checkIn.hours", { hours: m / 60 })}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("checkIn.guestName")}</span>
                <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                <span>{t("checkIn.guestPhone")}</span>
                <input
                  type="tel"
                  value={phone}

                  onChange={(e) => setPhone(e.target.value)}
                />
              </label>
            </>
          )}
          <p className="small">
            {t("checkIn.step", {
              n: 5,
              label:
                preview.deposit_cents > 0
                  ? t("checkIn.deposit", { amount: `−${money(preview.deposit_cents as never)}` })
                  : t("checkIn.noDeposit"),
            })}
          </p>
          <p className="small muted">{t("checkIn.step", { n: 6, label: t("checkIn.code") })}</p>
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

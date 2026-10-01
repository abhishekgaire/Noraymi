import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Temporal } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useClock } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * N11 Waitlist drawer and the staff phone's Waitlist tab (M2-25): each party
 * with its size, joined time, quote and wait, and Text and Remove; adding a
 * party with its name, mobile, size and quote; "+ Add a walk-in" opens
 * check-in in a free room. Offer a room comes with M2-26.
 */
interface Entry {
  readonly id: string;
  readonly name: string;
  readonly party_size: number;
  readonly bills_as: number;
  readonly joined_at: string;
  readonly quoted_min: number | null;
  readonly waited_min: number;
  readonly status: string;
  readonly phone_e164: string | null;
  readonly offered_room_name: string | null;
  readonly offer_expires_at: string | null;
  readonly offer_message_id: string | null;
  readonly offer_text_status: string | null;
}

export interface Suggestion {
  readonly entry_id: string;
  readonly name: string;
  readonly party_size: number;
  readonly room_name: string;
}

/** An offer holds the room 10 minutes (M2-26). */
const OFFER_HOLD_SEC = 600;

/** "(347) 555-0177" for a US number. */
export function usPhone(e164: string | null): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 ?? "");
}

export function useWaitlistCount(
  venueId: string,
  on: boolean,
): { count: number; suggestion: Suggestion | null; reload: () => void } {
  const { subscribe } = useEvents();
  const [count, setCount] = useState(0);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const load = useCallback(async () => {
    if (!on || !venueId) return;
    try {
      const r = await api<{ entries: Entry[]; suggestion: Suggestion | null }>(
        "GET",
        `/v1/venues/${venueId}/waitlist`,
      );
      setCount(r.entries.length);
      setSuggestion(r.suggestion);
    } catch {
      // The count is a convenience; the board keeps working without it.
    }
  }, [venueId, on]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some((e) => e.type === "waitlist.updated" || e.type === "room.updated")
        )
          void load();
      }),
    [subscribe, load],
  );
  return { count, suggestion, reload: () => void load() };
}

export function WaitlistList({
  venueId,
  timeZone,
  onWalkIn,
}: {
  venueId: string;
  timeZone: string;
  onWalkIn?: (() => void) | undefined;
}) {
  const { t, time } = useT();
  const { now } = useClock();
  const navigate = useNavigate();
  const [seating, setSeating] = useState<string | null>(null);
  const [ids, setIds] = useState("0");
  const [minutes, setMinutes] = useState("60");
  const { subscribe } = useEvents();
  const [entries, setEntries] = useState<readonly Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [party, setParty] = useState("");
  const [quote, setQuote] = useState("");

  const load = useCallback(async () => {
    try {
      setEntries(
        (await api<{ entries: Entry[] }>("GET", `/v1/venues/${venueId}/waitlist`)).entries,
      );
      setError(null);
    } catch {
      setError(t("waitlist.failed"));
    }
  }, [venueId, t]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "waitlist.updated")) void load();
      }),
    [subscribe, load],
  );

  const offer = async (id: string) => {
    try {
      await api("POST", `/v1/venues/${venueId}/waitlist/${id}/offer`);
      await load();
    } catch (e) {
      setError(
        e instanceof ApiCallError && e.code === "room_not_free"
          ? t("waitlist.noRoom")
          : t("waitlist.failed"),
      );
    }
  };
  const seat = async (e: FormEvent, id: string) => {
    e.preventDefault();
    try {
      await api("POST", `/v1/venues/${venueId}/waitlist/${id}/seat`, {
        ids_checked: Number(ids),
        minutes: Number(minutes),
      });
      setSeating(null);
      await load();
    } catch {
      setError(t("waitlist.failed"));
    }
  };
  const left = (expires: string | null) => {
    if (!expires || !now) return "";
    // Never above the hold itself: the screen's clock can sit a second off the server's.
    const s = Math.min(
      OFFER_HOLD_SEC,
      Math.max(
        0,
        Math.ceil(
          (Temporal.Instant.from(expires).epochMilliseconds - now.epochMilliseconds) / 1000,
        ),
      ),
    );
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const remove = async (id: string) => {
    try {
      await api("POST", `/v1/venues/${venueId}/waitlist/${id}/remove`);
      await load();
    } catch {
      setError(t("waitlist.failed"));
    }
  };
  const text = async (id: string) => {
    try {
      const r = await api<{ conversation_id: string }>(
        "POST",
        `/v1/venues/${venueId}/waitlist/${id}/text`,
      );
      void navigate(`/messages?c=${r.conversation_id}`);
    } catch {
      setError(t("waitlist.failed"));
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const digits = phone.replace(/\D/g, "");
    const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : phone;
    try {
      await api("POST", `/v1/venues/${venueId}/waitlist`, {
        name: name.trim(),
        phone: e164,
        party_size: Number(party),
        ...(quote ? { quoted_min: Number(quote) } : {}),
      });
      setAdding(false);
      setName("");
      setPhone("");
      setParty("");
      setQuote("");
      await load();
    } catch {
      setError(t("waitlist.failed"));
    }
  };

  return (
    <div className="waitlist">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {entries === null && !error && <p role="status">{t("shell.loading")}</p>}
      {entries?.length === 0 && <p className="empty">{t("waitlist.none")}</p>}
      <ol className="room-clocks">
        {entries?.map((w) => (
          <li key={w.id} className="room-clock" aria-label={w.name}>
            <div className="room-clock-head">
              <span className="tile-name">{w.name}</span>
              <span>
                {w.bills_as > w.party_size
                  ? t("waitlist.partyBills", { party: w.party_size, bills: w.bills_as })
                  : t("checkIn.guests", { party: w.party_size })}
              </span>
            </div>
            <div className="small">
              {t("waitlist.joined", { time: time(w.joined_at, timeZone), min: w.waited_min })}
            </div>
            <div className="small muted">
              {w.quoted_min === null
                ? t("waitlist.noQuote")
                : t("waitlist.quoted", { min: w.quoted_min })}
            </div>
            {w.status === "offered" && (
              <div className="small" role="timer">
                {t("waitlist.offered", {
                  room: w.offered_room_name ?? "",
                  time: left(w.offer_expires_at),
                })}
              </div>
            )}
            {w.status === "offered" &&
              (w.offer_message_id === null || w.offer_text_status === "failed") && (
                <div className="small error">
                  {t("waitlist.notDelivered")}{" "}
                  <a href={`tel:${w.phone_e164 ?? ""}`}>{usPhone(w.phone_e164)}</a>
                </div>
              )}
            {seating === w.id && (
              <form className="actions" onSubmit={(e) => void seat(e, w.id)}>
                <label>
                  {t("waitlist.idsChecked")}
                  <input
                    type="number"
                    min={0}
                    max={w.party_size}
                    value={ids}
                    onChange={(e) => setIds(e.target.value)}
                  />
                </label>
                <label>
                  {t("waitlist.minutes")}
                  <input
                    type="number"
                    min={15}
                    step={15}
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                  />
                </label>
                <button type="submit" className="primary">
                  {t("checkIn.button")}
                </button>
              </form>
            )}
            <div className="actions">
              {w.status === "waiting" && (
                <button type="button" className="primary" onClick={() => void offer(w.id)}>
                  {t("waitlist.offer")}
                </button>
              )}
              {w.status === "offered" && seating !== w.id && (
                <button type="button" className="primary" onClick={() => setSeating(w.id)}>
                  {t("waitlist.seat")}
                </button>
              )}
              <button type="button" className="secondary" onClick={() => void text(w.id)}>
                {t("waitlist.text")}
              </button>
              <button type="button" className="secondary" onClick={() => void remove(w.id)}>
                {t("waitlist.remove")}
              </button>
            </div>
          </li>
        ))}
      </ol>
      {adding ? (
        <form className="sheet" aria-label={t("waitlist.add")} onSubmit={(e) => void add(e)}>
          <label>
            {t("waitlist.name")}
            <input value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {t("waitlist.mobile")}
            <input type="tel" value={phone} required onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label>
            {t("checkIn.party")}
            <input
              type="number"
              min={1}
              value={party}
              required
              onChange={(e) => setParty(e.target.value)}
            />
          </label>
          <label>
            {t("waitlist.quote")}
            <input type="number" min={0} value={quote} onChange={(e) => setQuote(e.target.value)} />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={!name.trim() || !phone || !party}>
              {t("waitlist.addIt")}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              {t("checkIn.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button type="button" className="secondary" onClick={() => setAdding(true)}>
            {t("waitlist.add")}
          </button>
          {onWalkIn && (
            <button type="button" className="secondary" onClick={onWalkIn}>
              {t("waitlist.walkIn")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The staff phone's Waitlist tab. */
export function Waitlist() {
  const { t } = useT();
  const { state } = useSession();
  const signedIn = state.status === "signedIn" ? state : null;
  if (!signedIn) return null;
  return (
    <section className="screen">
      <h1>{t("waitlist.title")}</h1>
      <WaitlistList
        venueId={signedIn.membership.venue_id}
        timeZone={signedIn.membership.venue.time_zone}
      />
    </section>
  );
}

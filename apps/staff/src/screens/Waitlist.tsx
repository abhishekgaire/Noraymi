import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.js";
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
}

export function useWaitlistCount(venueId: string, on: boolean): number {
  const { subscribe } = useEvents();
  const [count, setCount] = useState(0);
  const load = useCallback(async () => {
    if (!on || !venueId) return;
    try {
      setCount(
        (await api<{ entries: Entry[] }>("GET", `/v1/venues/${venueId}/waitlist`)).entries.length,
      );
    } catch {
      // The count is a convenience; the board keeps working without it.
    }
  }, [venueId, on]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "waitlist.updated")) void load();
      }),
    [subscribe, load],
  );
  return count;
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
  const navigate = useNavigate();
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
            <div className="actions">
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

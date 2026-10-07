import { useCallback, useEffect, useState } from "react";
import { Temporal, type MessageKey } from "@west4/shared";
import { api } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * N20 Help alert and incident log (M8-08; D58): managers' and owners' phones
 * only. The guest's private alert shows its room, time and kind with
 * [I'm on it]; notes go to the log and are never edited; Close keeps the
 * incident 3 years. A manager can also log one by hand. Admin → Safety shows
 * the same log.
 */
type Kind = "unsafe" | "someone_needs_help" | "other";
const KINDS: readonly Kind[] = ["unsafe", "someone_needs_help", "other"];
interface Incident {
  readonly id: string;
  readonly kind: Kind;
  readonly room_name: string | null;
  readonly reported_via: "room_page" | "staff_phone";
  readonly reported_by_name: string | null;
  readonly at: string;
  readonly status: "open" | "acknowledged" | "closed";
  readonly acknowledged_by_name: string | null;
  readonly closed_by_name: string | null;
  readonly closed_at: string | null;
  readonly keep_until: string | null;
  readonly notes: readonly {
    readonly id: string;
    readonly text: string;
    readonly added_by_name: string | null;
    readonly added_at: string;
  }[];
}

function IncidentCard({
  incident: i,
  timeZone,
  venueId,
  onChange,
  onFail,
}: {
  incident: Incident;
  timeZone: string;
  venueId: string;
  onChange: () => Promise<void>;
  onFail: () => void;
}) {
  const { t, time, locale } = useT();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const line = t("incidents.line", {
    room: i.room_name ?? t("incidents.noRoom"),
    kind: t(`incidents.kind.${i.kind}` as MessageKey),
  });
  const act = async (path: string, body?: object) => {
    setBusy(true);
    try {
      await api("POST", `/v1/venues/${venueId}/incidents/${i.id}/${path}`, body);
      await onChange();
      return true;
    } catch {
      onFail();
      return false;
    } finally {
      setBusy(false);
    }
  };
  const keptUntil = i.keep_until
    ? Temporal.Instant.from(i.keep_until).toZonedDateTimeISO(timeZone).toPlainDate()
    : null;
  return (
    <li
      className={i.status === "closed" ? "room-clock" : "room-clock alert-pink"}
      aria-label={line}
      data-status={i.status}
    >
      <div>
        <strong>{line}</strong>
      </div>
      <div className="small muted">
        {i.reported_via === "room_page"
          ? t("incidents.from.room_page", { time: time(i.at, timeZone) })
          : t("incidents.from.staff_phone", {
              name: i.reported_by_name ?? "",
              time: time(i.at, timeZone),
            })}
      </div>
      <div className="small">
        {i.status === "open" && t("incidents.status.open")}
        {i.status === "acknowledged" &&
          t("incidents.status.acknowledged", { name: i.acknowledged_by_name ?? "" })}
        {i.status === "closed" &&
          t("incidents.status.closed", {
            name: i.closed_by_name ?? "",
            time: time(i.closed_at ?? i.at, timeZone),
          })}
      </div>
      {keptUntil && (
        <div className="small muted">
          {t("incidents.keptUntil", {
            // With the year: a closed incident is kept for years (the shared date format leaves it out).
            date: keptUntil.toLocaleString(locale, {
              year: "numeric",
              month: "short",
              day: "numeric",
            }),
          })}
        </div>
      )}
      {i.notes.length > 0 && (
        <ul className="incident-notes">
          {i.notes.map((n) => (
            <li key={n.id}>
              <div>{n.text}</div>
              <div className="small muted">
                {t("incidents.note.by", {
                  name: n.added_by_name ?? "",
                  time: time(n.added_at, timeZone),
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="incident-note"
        onSubmit={(e) => {
          e.preventDefault();
          if (!note.trim()) return;
          void act("notes", { text: note.trim() }).then((ok) => ok && setNote(""));
        }}
      >
        <label>
          <span className="small">{t("incidents.note")}</span>
          <textarea
            value={note}
            rows={2}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <div className="actions">
          <button type="submit" className="secondary" disabled={busy || !note.trim()}>
            {t("incidents.note.add")}
          </button>
          {i.status === "open" && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void act("ack")}
            >
              {t("incidents.onIt")}
            </button>
          )}
          {i.status !== "closed" && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void act("close")}
            >
              {t("incidents.close")}
            </button>
          )}
        </div>
      </form>
    </li>
  );
}

function LogOne({
  venueId,
  onLogged,
  onFail,
}: {
  venueId: string;
  onLogged: () => Promise<void>;
  onFail: () => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [rooms, setRooms] = useState<readonly { room_id: string; name: string }[]>([]);
  const [roomId, setRoomId] = useState("");
  const [kind, setKind] = useState<Kind>("other");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!open) return;
    api<{ rooms: { room_id: string; name: string }[] }>("GET", `/v1/venues/${venueId}/board`)
      .then((b) => setRooms(b.rooms))
      .catch(() => setRooms([]));
  }, [open, venueId]);
  if (!open)
    return (
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        {t("incidents.new")}
      </button>
    );
  return (
    <form
      className="invite-fields"
      aria-label={t("incidents.new")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!note.trim()) return;
        api("POST", `/v1/venues/${venueId}/incidents`, {
          kind,
          room_id: roomId || null,
          note: note.trim(),
        })
          .then(async () => {
            setOpen(false);
            setNote("");
            setRoomId("");
            await onLogged();
          })
          .catch(onFail);
      }}
    >
      <label>
        <span>{t("incidents.new.room")}</span>
        <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          <option value="">{t("incidents.noRoom")}</option>
          {rooms.map((r) => (
            <option key={r.room_id} value={r.room_id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("incidents.new.kind")}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`incidents.kind.${k}` as MessageKey)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("incidents.note")}</span>
        <textarea
          value={note}
          rows={3}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="actions">
        <button type="submit" className="primary" disabled={!note.trim()}>
          {t("incidents.new.save")}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          {t("checkIn.cancel")}
        </button>
      </div>
    </form>
  );
}

export function IncidentLog({ venueId, timeZone }: { venueId: string; timeZone: string }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const [incidents, setIncidents] = useState<readonly Incident[] | null>(null);
  const [keptYears, setKeptYears] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const answer = await api<{ incidents: Incident[]; kept_years: number }>(
        "GET",
        `/v1/venues/${venueId}/incidents`,
      );
      setIncidents(answer.incidents);
      setKeptYears(answer.kept_years);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [venueId]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type.startsWith("incident."))) void load();
      }),
    [subscribe, load],
  );

  const open = incidents?.filter((i) => i.status !== "closed") ?? [];
  const closed = incidents?.filter((i) => i.status === "closed") ?? [];
  const card = (i: Incident) => (
    <IncidentCard
      key={i.id}
      incident={i}
      timeZone={timeZone}
      venueId={venueId}
      onChange={async () => {
        setFailed(false);
        await load();
      }}
      onFail={() => setFailed(true)}
    />
  );
  return (
    <>
      {loadFailed && (
        <p role="alert" className="error">
          {t("incidents.loadFailed")}
        </p>
      )}
      {failed && (
        <p role="alert" className="error">
          {t("incidents.failed")}
        </p>
      )}
      {incidents === null && !loadFailed && <p role="status">{t("shell.loading")}</p>}
      {incidents !== null && (
        <>
          <section aria-labelledby="incidents-open">
            <h2 id="incidents-open">{t("incidents.openNow")}</h2>
            {open.length === 0 && <p className="empty">{t("incidents.none")}</p>}
            <ul className="room-clocks">{open.map(card)}</ul>
          </section>
          <LogOne venueId={venueId} onLogged={load} onFail={() => setFailed(true)} />
          <section aria-labelledby="incidents-log">
            <h2 id="incidents-log">{t("incidents.log")}</h2>
            {keptYears !== null && (
              <p className="small muted">{t("safety.log.kept", { years: keptYears })}</p>
            )}
            {closed.length === 0 && <p className="empty">{t("incidents.logEmpty")}</p>}
            <ul className="room-clocks">{closed.map(card)}</ul>
          </section>
        </>
      )}
    </>
  );
}

export function Incidents() {
  const { t } = useT();
  const { state } = useSession();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  return (
    <section className="screen">
      <h1>{t("incidents.title")}</h1>
      {venueId && <IncidentLog venueId={venueId} timeZone={timeZone} />}
    </section>
  );
}

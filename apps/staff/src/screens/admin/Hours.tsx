import { useCallback, useEffect, useState, type FormEvent } from "react";
import { type Hours as HoursValue, type MessageKey } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api, type ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Hours & prices, the M1 part (M1-33; spec 03 · `hours`): each day's
 * opening and close (a close after midnight, such as 4:00 AM, is the next
 * morning), the house last call, and special and closed dates. Hours and the
 * last call go through Save and publish, where the rule pack refuses a last
 * call after its last sale with the reason. Special dates are `closures`
 * rows and save at once. Google shows as not connected until M5. Rates,
 * bands, minimums, the VIP rate, booking limits and the damage fee join in
 * M2, and minimum spend in M4.
 */
interface Closure {
  readonly id: string;
  readonly date: string;
  readonly kind: "closed" | "special";
  readonly opens: string | null;
  readonly closes: string | null;
  readonly note: string | null;
}

/** Monday first, the way the week reads on the board; JS numbering (Sunday 0). */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

export function Hours() {
  const { t, locale } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [saved, setSaved] = useState<HoursValue | null>(null);
  const [closures, setClosures] = useState<Closure[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [hours, list] = await Promise.all([
      api<{ value: HoursValue }>("GET", `/v1/venues/${venueId}/settings/hours`),
      api<{ items: Closure[] }>("GET", `/v1/venues/${venueId}/closures`),
    ]);
    setSaved(hours.value);
    setClosures(list.items);
  }, [venueId]);

  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setError(t("shell.error.cantReach")));
  }, [venueId, load, t, draft.version]);

  const clock = (hhmm: string): string =>
    new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(`2026-01-01T${hhmm}:00`));

  const current = (draft.values["hours"] as HoursValue | undefined) ?? saved;
  const rowFor = (day: number) => current?.weekly.find((w) => w.day === day);
  const setDay = (day: number, field: "opens" | "closes", value: string) => {
    if (!current || !/^\d{2}:\d{2}$/.test(value)) return;
    const weekly = current.weekly.some((w) => w.day === day)
      ? current.weekly.map((w) => (w.day === day ? { ...w, [field]: value } : w))
      : [...current.weekly, { day, opens: "16:00", closes: "04:00", [field]: value }];
    draft.set("hours", { ...current, weekly });
  };
  const setLastCall = (value: string) => {
    if (!current) return;
    draft.set("hours", { ...current, lastCall: value === "" ? null : value });
  };

  return (
    <section className="hours">
      <h2>{t("admin.section.hours")}</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {current === null ? (
        <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          <h3>{t("hours.weekly")}</h3>
          <p className="small muted">{t("hours.afterMidnight")}</p>
          <table className="hours-table">
            <thead>
              <tr>
                <th>{t("hours.day")}</th>
                <th>{t("hours.opens")}</th>
                <th>{t("hours.closes")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {WEEK.map((day) => {
                const row = rowFor(day);
                const name = t(`day.${day}` as MessageKey);
                return (
                  <tr key={day}>
                    <th scope="row">{name}</th>
                    <td>
                      <input
                        type="time"
                        aria-label={`${name} · ${t("hours.opens")}`}
                        value={row?.opens ?? ""}
                        onChange={(e) => setDay(day, "opens", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="time"
                        aria-label={`${name} · ${t("hours.closes")}`}
                        value={row?.closes ?? ""}
                        onChange={(e) => setDay(day, "closes", e.target.value)}
                      />
                    </td>
                    <td className="muted">
                      {row
                        ? t("hours.range", { opens: clock(row.opens), closes: clock(row.closes) })
                        : t("hours.kind.closed")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h3>{t("hours.lastCall")}</h3>
          <p className="small muted">{t("hours.lastCall.hint")}</p>
          <div className="field-line">
            <input
              type="time"
              aria-label={t("hours.lastCall")}
              value={current.lastCall ?? ""}
              onChange={(e) => setLastCall(e.target.value)}
            />
            <span className="muted">
              {current.lastCall ? clock(current.lastCall) : t("hours.lastCall.none")}
            </span>
          </div>

          <p className="small muted">
            {t("hours.google")} · {t("hours.google.hint")}
          </p>

          <h3>{t("hours.special.title")}</h3>
          {closures === null ? (
            <p role="status">{t("shell.loading")}</p>
          ) : closures.length === 0 ? (
            <p className="empty">{t("hours.special.none")}</p>
          ) : (
            <table className="hours-table">
              <thead>
                <tr>
                  <th>{t("hours.special.date")}</th>
                  <th>{t("hours.special.kind")}</th>
                  <th>{t("hours.opens")}</th>
                  <th>{t("hours.closes")}</th>
                  <th>{t("hours.special.note")}</th>
                </tr>
              </thead>
              <tbody>
                {closures.map((c) => (
                  <tr key={c.id}>
                    <td>{c.date}</td>
                    <td>{t(`hours.kind.${c.kind}` as MessageKey)}</td>
                    <td>{c.opens ? clock(c.opens) : "—"}</td>
                    <td>{c.closes ? clock(c.closes) : "—"}</td>
                    <td>{c.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <SpecialDateForm venueId={venueId} clock={clock} onAdded={load} />
        </>
      )}
    </section>
  );
}

function SpecialDateForm({
  venueId,
  clock,
  onAdded,
}: {
  venueId: string;
  clock: (hhmm: string) => string;
  onAdded: () => Promise<void>;
}) {
  const { t } = useT();
  const [date, setDate] = useState("");
  const [kind, setKind] = useState<"closed" | "special">("special");
  const [opens, setOpens] = useState("");
  const [closes, setCloses] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setMessage(null);
    try {
      await api("POST", `/v1/venues/${venueId}/closures`, {
        date,
        kind,
        opens: kind === "special" && opens !== "" ? opens : null,
        closes: kind === "special" && closes !== "" ? closes : null,
        note: note.trim() === "" ? null : note.trim(),
      });
      const day = await api<{ closed: boolean; opens: string | null; closes: string | null }>(
        "GET",
        `/v1/venues/${venueId}/hours?business_date=${date}`,
      );
      const reads = day.closed
        ? t("hours.special.closedAllDay")
        : t("hours.range", {
            opens: day.opens ? clock(day.opens.slice(11, 16)) : "—",
            closes: day.closes ? clock(day.closes.slice(11, 16)) : "—",
          });
      setMessage({ kind: "ok", text: t("hours.special.added", { date, hours: reads }) });
      setDate("");
      setOpens("");
      setCloses("");
      setNote("");
      await onAdded();
    } catch (err) {
      setMessage({
        kind: "error",
        text: (err as ApiCallError)?.message ?? t("hours.special.failed"),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="invite-form" onSubmit={(e) => void submit(e)}>
      <div className="invite-fields">
        <label>
          <span>{t("hours.special.date")}</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          <span>{t("hours.special.kind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as "closed" | "special")}>
            <option value="special">{t("hours.kind.special")}</option>
            <option value="closed">{t("hours.kind.closed")}</option>
          </select>
        </label>
        {kind === "special" && (
          <>
            <label>
              <span>{t("hours.opens")}</span>
              <input type="time" value={opens} onChange={(e) => setOpens(e.target.value)} />
            </label>
            <label>
              <span>{t("hours.closes")}</span>
              <input type="time" value={closes} onChange={(e) => setCloses(e.target.value)} />
            </label>
          </>
        )}
        <label>
          <span>{t("hours.special.note")}</span>
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <button type="submit" className="primary" disabled={sending}>
        {t("hours.special.add")}
      </button>
      {message && (
        <p className={message.kind === "error" ? "error" : "small"} role="status">
          {message.text}
        </p>
      )}
    </form>
  );
}

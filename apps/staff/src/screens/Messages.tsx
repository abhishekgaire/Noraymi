import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { Temporal } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useClock, useVenueTime } from "../clock.js";
import { useEvents } from "../events.js";
import "./desk.css";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * Messages on the desktop and the phone (M2-22; screens Messages and
 * DeskMessages): the threads, unread first; a thread with its texts; a reply
 * in the staff member's own words (never a link or a promotion); Reply "no
 * problem" on a booking's thread; and the 14 automatic texts in Admin's order.
 */
interface Conversation {
  readonly id: string;
  readonly guest_name: string | null;
  readonly phone_e164: string;
  readonly context_kind: "booking" | "waitlist" | "session" | "enquiry" | null;
  readonly unread: number;
  readonly last_body: string | null;
  readonly opted_out: boolean;
}
interface Message {
  readonly id: string;
  readonly direction: "outbound" | "inbound";
  readonly automatic: boolean;
  readonly body: string;
  readonly sent_by_name: string | null;
  readonly at: string | null;
}
interface Text {
  readonly key: string;
  readonly position: number;
  readonly on: boolean;
}

function Thread({
  venueId,
  venueName,
  timeZone,
  conversationId,
  onBack,
}: {
  venueId: string;
  venueName: string;
  timeZone: string;
  conversationId: string;
  onBack: () => void;
}) {
  const { t, time, date } = useT();
  const { subscribe } = useEvents();
  const { state } = useSession();
  const cutover = state.status === "signedIn" ? state.membership.venue.day_cutover : "06:00";
  const venueTime = useVenueTime(timeZone, cutover);
  const [data, setData] = useState<{
    conversation: Conversation;
    messages: Message[];
    /** A party enquiry from the website (M5-04). */
    enquiry?: { party_size: number; date: string } | null;
  } | null>(null);
  const [reply, setReply] = useState("");
  const [holdUntil, setHoldUntil] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api(`GET`, `/v1/venues/${venueId}/conversations/${conversationId}`));
    } catch {
      setError(t("messages.failed"));
    }
  }, [venueId, conversationId, t]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type.startsWith("message."))) void load();
      }),
    [subscribe, load],
  );

  const refused = (e: unknown) => {
    const reason = e instanceof ApiCallError ? e.details["reason"] : undefined;
    return reason === "link" ||
      reason === "promotion" ||
      reason === "not_open" ||
      reason === "opted_out"
      ? t(`messages.refused.${reason}`)
      : t("messages.failed");
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!reply.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/conversations/${conversationId}/messages`, {
        body: reply.trim(),
      });
      setReply("");
      await load();
    } catch (err) {
      setError(refused(err));
    } finally {
      setBusy(false);
    }
  };

  const markOptOut = async (messageId: string) => {
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/messages/${messageId}/opt-out`);
      await load();
    } catch {
      setError(t("messages.failed"));
    }
  };

  const noProblem = async () => {
    setBusy(true);
    setError(null);
    try {
      let until: string | undefined;
      if (holdUntil && venueTime) {
        const [h, m] = holdUntil.split(":").map(Number) as [number, number];
        let date = venueTime.businessDate;
        if (h * 60 + m < Number(cutover.slice(0, 2)) * 60) date = date.add({ days: 1 });
        until = Temporal.ZonedDateTime.from({
          timeZone,
          year: date.year,
          month: date.month,
          day: date.day,
          hour: h,
          minute: m,
        })
          .toInstant()
          .toString();
      }
      await api(
        "POST",
        `/v1/venues/${venueId}/conversations/${conversationId}/running-late`,
        until ? { until } : {},
      );
      await load();
    } catch (err) {
      setError(refused(err));
    } finally {
      setBusy(false);
    }
  };

  if (!data)
    return error ? (
      <p role="alert" className="error">
        {error}
      </p>
    ) : (
      <p role="status">{t("shell.loading")}</p>
    );
  const name = data.conversation.guest_name ?? data.conversation.phone_e164;
  return (
    <section className="thread" aria-label={name}>
      <button type="button" className="link phone-only" onClick={onBack}>
        {t("messages.back")}
      </button>
      <h2>{name}</h2>
      {data.enquiry && (
        <p className="notice">
          {t("messages.enquiry", { n: data.enquiry.party_size, date: date(data.enquiry.date) })}
        </p>
      )}
      <ol className="texts">
        {data.messages.map((m) => (
          <li
            key={m.id}
            className={
              m.direction === "inbound" ? "text in" : m.automatic ? "text out auto" : "text out"
            }
          >
            <div className="small muted">
              {m.direction === "inbound"
                ? name
                : m.automatic
                  ? t("messages.automatic")
                  : (m.sent_by_name ?? t("messages.westFour", { venue: venueName }))}
              {m.at ? ` · ${time(m.at, timeZone)}` : ""}
            </div>
            <div>{m.body}</div>
            {m.direction === "inbound" && !data.conversation.opted_out && (
              <button type="button" className="link" onClick={() => void markOptOut(m.id)}>
                {t("messages.optOut")}
              </button>
            )}
          </li>
        ))}
      </ol>
      {data.conversation.opted_out && (
        <p className="notice" role="status">
          {t("messages.optedOut")}
        </p>
      )}
      {data.conversation.context_kind === "booking" && !data.conversation.opted_out && (
        <div className="actions">
          <label>
            {t("messages.holdUntil")}
            <input type="time" value={holdUntil} onChange={(e) => setHoldUntil(e.target.value)} />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void noProblem()}
          >
            {t("messages.noProblem")}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <form className="actions" onSubmit={(e) => void send(e)}>
        <label className="grow">
          {t("messages.reply")}
          <textarea value={reply} maxLength={640} onChange={(e) => setReply(e.target.value)} />
        </label>
        <button
          type="submit"
          className="primary"
          disabled={busy || !reply.trim() || data.conversation.opted_out}
        >
          {t("messages.send")}
        </button>
      </form>
    </section>
  );
}

export function Messages() {
  const { t } = useT();
  const { state } = useSession();
  const { subscribe } = useEvents();
  useClock();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const venueName = signedIn?.membership.venue.name ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const [list, setList] = useState<readonly Conversation[] | null>(null);
  const [texts, setTexts] = useState<readonly Text[]>([]);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const [c, x] = await Promise.all([
        api<{ conversations: Conversation[] }>("GET", `/v1/venues/${venueId}/conversations`),
        api<{ texts: Text[] }>("GET", `/v1/venues/${venueId}/texts`),
      ]);
      setList(c.conversations);
      setTexts(x.texts);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type.startsWith("message."))) void load();
      }),
    [subscribe, load],
  );

  return (
    <section className={selected ? "screen messages desk with-thread" : "screen messages desk"}>
      <div className="desk-head">
        <h1>{t("menu.messages")}</h1>
      </div>
      {failed && (
        <p role="alert" className="error">
          {t("shell.error.cantReach")}
        </p>
      )}
      {list === null && !failed && <p role="status">{t("shell.loading")}</p>}
      <div className="messages-layout">
        <div className="threads desk-card">
          {list?.length === 0 && <p className="empty">{t("messages.none")}</p>}
          <ul className="conversation-list">
            {list?.map((c) => {
              const name = c.guest_name ?? c.phone_e164;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className={c.id === selected ? "conversation current" : "conversation"}
                    aria-label={name}
                    onClick={() => setParams({ c: c.id })}
                  >
                    <span className="tile-name">{name}</span>
                    {c.unread > 0 && (
                      <span className="badge">{t("messages.unread", { count: c.unread })}</span>
                    )}
                    {c.context_kind && (
                      <span className="small muted">{t(`messages.context.${c.context_kind}`)}</span>
                    )}
                    {c.last_body && <span className="small">{c.last_body}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="thread-pane desk-card">
          {selected ? (
            <Thread
              key={selected}
              venueId={venueId}
              venueName={venueName}
              timeZone={timeZone}
              conversationId={selected}
              onBack={() => setParams({})}
            />
          ) : (
            <p className="muted desktop-only">{t("messages.pick")}</p>
          )}
        </div>
        <aside className="auto-texts desk-card">
          <h2>{t("messages.texts")}</h2>
          <ol className="texts-list">
            {texts.map((x) => (
              <li key={x.key} aria-label={t(`texts.name.${x.key}` as never)}>
                <span>{t(`texts.name.${x.key}` as never)}</span>{" "}
                <span className="small muted">{x.on ? t("texts.on") : t("texts.off")}</span>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type ApiCallError } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";

/**
 * No more alcohol (M3-21; screens N16): for the whole room, or one guest's
 * phone or the room's tablet. Each takes a reason, and once done every screen
 * reads "Cut off by Andy at 10:41 PM". There's no lifting it (the spec has
 * none). Only people who may cut off see the buttons; a runner sees the line.
 */
export interface CutOffState {
  readonly at: string;
  readonly by: string | null;
}
interface Guest {
  readonly id: string;
  readonly name: string | null;
  readonly is_host: boolean;
  readonly joined_at: string;
  readonly cut_off_at: string | null;
  readonly cut_off_by: string | null;
}

export function useCutOffWords(timeZone: string) {
  const { t } = useT();
  return (c: { at: string; by: string | null }) =>
    t("cutOff.by", {
      name: c.by ?? "",
      time: new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(c.at)),
    });
}

export function CutOffRoom(props: {
  venueId: string;
  sessionId: string;
  roomName: string;
  timeZone: string;
  cutOff: CutOffState | null;
  canCutOff: boolean;
  onDone: () => void;
  /** The board's tile panel shows the room's control only; DeskRoom and the Room phone list the guests too. */
  guests?: boolean;
}) {
  const { t } = useT();
  const words = useCutOffWords(props.timeZone);
  const { subscribe } = useEvents();
  const [asking, setAsking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [list, setList] = useState<readonly Guest[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!props.guests) return;
    try {
      setList(
        (
          await api<{ guests: Guest[] }>(
            "GET",
            `/v1/venues/${props.venueId}/sessions/${props.sessionId}/guests`,
          )
        ).guests,
      );
    } catch {
      setList([]);
    }
  }, [props.venueId, props.sessionId, props.guests]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.some((e) => e.type === "session.updated" || e.type === "room.guest_joined"))
          void load();
      }),
    [subscribe, load],
  );

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!asking) return;
    setError(null);
    try {
      await api(
        "POST",
        asking === "room"
          ? `/v1/venues/${props.venueId}/sessions/${props.sessionId}/cut-off`
          : `/v1/venues/${props.venueId}/sessions/${props.sessionId}/guests/${asking}/cut-off`,
        { reason: reason.trim() },
      );
      setAsking(null);
      setReason("");
      await load();
      props.onDone();
    } catch (err) {
      setError((err as ApiCallError)?.message ?? t("cutOff.failed"));
    }
  };
  const guestName = (g: Guest, i: number) =>
    g.name ?? (g.is_host ? t("cutOff.host") : t("cutOff.guest", { n: i + 1 }));

  return (
    <div className="cut-off">
      {props.cutOff ? (
        <p className="notice" role="status">
          {words(props.cutOff)}
        </p>
      ) : (
        props.canCutOff && (
          <button type="button" className="secondary danger" onClick={() => setAsking("room")}>
            {t("cutOff.room")}
          </button>
        )
      )}
      {props.guests && !props.cutOff && list.length > 0 && (
        <ul className="faults">
          {list.map((g, i) => (
            <li key={g.id} className="small">
              <span>{guestName(g, i)}</span>{" "}
              {g.cut_off_at ? (
                <span className="muted">{words({ at: g.cut_off_at, by: g.cut_off_by })}</span>
              ) : (
                props.canCutOff && (
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`${t("cutOff.guestButton")} · ${guestName(g, i)}`}
                    onClick={() => setAsking(g.id)}
                  >
                    {t("cutOff.guestButton")}
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      {asking && (
        <div
          className="sheet floating"
          role="dialog"
          aria-label={asking === "room" ? t("cutOff.room") : t("cutOff.guestButton")}
        >
          <form className="invite-fields" onSubmit={(e) => void send(e)}>
            <label>
              <span>
                {asking === "room"
                  ? t("cutOff.why.room", { room: props.roomName })
                  : t("cutOff.why.guest")}
              </span>
              <input
                value={reason}
                required
                maxLength={300}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button type="submit" className="primary danger" disabled={!reason.trim()}>
              {t("cutOff.confirm")}
            </button>
            <button type="button" className="secondary" onClick={() => setAsking(null)}>
              {t("team.badge.cancel")}
            </button>
          </form>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * No more alcohol on a bar tab (M6-14; screens N16): a reason, then every screen for the tab reads
 * "Cut off by Andy at 10:30 PM" and its alcohol greys out. Only people who may cut off see the
 * button (a runner can't, and the server refuses them too).
 */
export function CutOffTab(props: {
  venueId: string;
  tabId: string;
  timeZone: string;
  cutOff: CutOffState | null;
  canCutOff: boolean;
  onDone: () => void;
}) {
  const { t } = useT();
  const words = useCutOffWords(props.timeZone);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("POST", `/v1/venues/${props.venueId}/tabs/${props.tabId}/cut-off`, {
        reason: reason.trim(),
      });
      setAsking(false);
      setReason("");
      props.onDone();
    } catch (err) {
      setError((err as ApiCallError)?.message ?? t("cutOff.failed"));
    }
  };

  if (props.cutOff)
    return (
      <p className="notice cut-off-line" role="status">
        {words(props.cutOff)}
      </p>
    );
  if (!props.canCutOff) return null;
  return (
    <div className="cut-off">
      {!asking && (
        <button type="button" className="secondary danger" onClick={() => setAsking(true)}>
          {t("cutOff.tab")}
        </button>
      )}
      {asking && (
        <form className="invite-fields" aria-label={t("cutOff.tab")} onSubmit={(e) => void send(e)}>
          <label>
            <span>{t("cutOff.why.tab")}</span>
            <input
              value={reason}
              required
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button type="submit" className="primary danger" disabled={!reason.trim()}>
            {t("cutOff.confirm")}
          </button>
          <button type="button" className="secondary" onClick={() => setAsking(false)}>
            {t("team.badge.cancel")}
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

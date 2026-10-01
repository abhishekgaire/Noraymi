import { useCallback, useEffect, useState } from "react";
import { Temporal } from "@west4/shared";
import { api } from "../api.js";
import { useClock } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * N19 Calls list (M2-20): room calls such as "Another mic, please", each with
 * On it, on the board and every staff phone. On it clears it everywhere; a
 * TV or song call can be logged as a fault in one tap.
 */
type Kind = "mic" | "tv" | "check" | "other";
interface Call {
  readonly id: string;
  readonly room_name: string;
  readonly kind: Kind;
  readonly created_at: string;
}

export function CallsList({ venueId, compact }: { venueId: string; compact?: boolean }) {
  const { t } = useT();
  const { now } = useClock();
  const { subscribe } = useEvents();
  const [calls, setCalls] = useState<readonly Call[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setCalls((await api<{ calls: Call[] }>("GET", `/v1/venues/${venueId}/calls`)).calls);
      setError(false);
    } catch {
      setError(true);
    }
  }, [venueId]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "room.call")) void load();
      }),
    [subscribe, load],
  );

  const act = async (id: string, what: "ack" | "fault") => {
    try {
      await api("POST", `/v1/venues/${venueId}/calls/${id}/${what}`);
      await load();
    } catch {
      setError(true);
    }
  };
  const ago = (iso: string) =>
    now
      ? Math.max(
          0,
          Math.floor(
            (now.epochMilliseconds - Temporal.Instant.from(iso).epochMilliseconds) / 60_000,
          ),
        )
      : 0;

  if (compact && (calls?.length ?? 0) === 0 && !error) return null;
  return (
    <section aria-labelledby="calls-title" className={compact ? "alerts" : undefined}>
      {compact ? (
        <h2 id="calls-title">{t("calls.title")}</h2>
      ) : (
        <h1 id="calls-title">{t("calls.title")}</h1>
      )}
      {error && (
        <p role="alert" className="error">
          {t("calls.failed")}
        </p>
      )}
      {calls === null && !error && <p role="status">{t("shell.loading")}</p>}
      {calls?.length === 0 && <p className="empty">{t("calls.none")}</p>}
      <ul className="room-clocks">
        {calls?.map((c) => (
          <li
            key={c.id}
            className="room-clock alert-pink"
            aria-label={t("calls.line", { room: c.room_name, call: t(`calls.kind.${c.kind}`) })}
          >
            <div>{t("calls.line", { room: c.room_name, call: t(`calls.kind.${c.kind}`) })}</div>
            <div className="small muted">{t("calls.ago", { min: ago(c.created_at) })}</div>
            <div className="actions">
              <button type="button" className="primary" onClick={() => void act(c.id, "ack")}>
                {t("calls.onIt")}
              </button>
              {c.kind === "tv" && (
                <button type="button" className="secondary" onClick={() => void act(c.id, "fault")}>
                  {t("calls.toFault")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Calls() {
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  return <section className="screen">{venueId && <CallsList venueId={venueId} />}</section>;
}

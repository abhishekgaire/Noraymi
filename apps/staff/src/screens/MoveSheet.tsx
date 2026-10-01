import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * N12 Move sheet (M2-18): the rooms that fit the party and are free for the
 * time needed, each with its free-until time; the rest greyed out with the
 * reason. Choosing one moves the party there with a new room code.
 */
type Why =
  "too_small" | "out_of_service" | "in_use" | "cleaning" | "held" | "booked_next" | "past_close";

interface Option {
  readonly room_id: string;
  readonly name: string;
  readonly ok: boolean;
  readonly until: string | null;
  readonly all_night: boolean;
  readonly why: Why | null;
}

export function MoveSheet({
  venueId,
  timeZone,
  sessionId,
  roomName,
  onClose,
  onMoved,
}: {
  venueId: string;
  timeZone: string;
  sessionId: string;
  roomName: string;
  onClose: () => void;
  onMoved: (line: string) => void;
}) {
  const { t, time } = useT();
  const [options, setOptions] = useState<readonly Option[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api<{ rooms: Option[] }>("GET", `/v1/venues/${venueId}/sessions/${sessionId}/move-options`)
      .then((r) => live && setOptions(r.rooms))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [venueId, sessionId]);

  const move = async (o: Option) => {
    setBusy(true);
    setError(false);
    try {
      const r = await api<{ room_code: string; to_room: { name: string } }>(
        "POST",
        `/v1/venues/${venueId}/sessions/${sessionId}/move`,
        { room_id: o.room_id },
      );
      onMoved(t("move.done", { room: r.to_room.name, code: r.room_code }));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const title = t("move.title", { room: roomName });
  const ok = options?.filter((o) => o.ok) ?? [];
  const no = options?.filter((o) => !o.ok) ?? [];
  return (
    <div className="sheet" role="dialog" aria-label={title}>
      <h2>{title}</h2>
      {options === null && !error && <p role="status">{t("shell.loading")}</p>}
      {options !== null && ok.length === 0 && <p className="empty">{t("move.none")}</p>}
      <ul className="move-options">
        {ok.map((o) => (
          <li key={o.room_id}>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void move(o)}
            >
              {o.all_night || !o.until
                ? t("move.freeAllNight", { room: o.name })
                : t("move.freeUntil", { room: o.name, time: time(o.until, timeZone) })}
            </button>
          </li>
        ))}
        {no.map((o) => (
          <li key={o.room_id} className="muted" aria-disabled="true">
            {t("move.cant", { room: o.name, why: t(`move.why.${o.why ?? "in_use"}`) })}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="error">
          {t("move.failed")}
        </p>
      )}
      <div className="actions">
        <button type="button" onClick={onClose}>
          {t("checkIn.cancel")}
        </button>
      </div>
    </div>
  );
}

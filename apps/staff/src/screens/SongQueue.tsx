import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { MessageKey } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { hiddenScreens } from "../navigation.js";
import { useSession } from "../session.js";
import { NotFound } from "./NotFound.js";
import "./bar.css";

/**
 * The KJ's song queue (M6-22; screens N27; Song systems and texts · Screens): who's singing now, who's
 * up next in order, the round, each singer's credits and flags, Started, Skip, move up or down with a
 * reason, and + Singer for someone at the bar. It follows `song_queue.updated`. Names only: the API
 * never sends a singer's phone number.
 */
interface QueueSong {
  readonly id: string;
  readonly singer_id: string;
  readonly singer: string;
  readonly title: string;
  readonly artist: string | null;
  readonly round: number;
  readonly place: number;
  readonly flag: "needs_drink_credit" | null;
  readonly credits: number;
  readonly started_at: string | null;
}
interface Queue {
  readonly round: number;
  readonly songs_sung: number;
  readonly count: number;
  readonly singing: QueueSong | null;
  readonly up_next: readonly QueueSong[];
}

const songLine = (s: { title: string; artist: string | null }) =>
  s.artist ? `${s.title} · ${s.artist}` : s.title;

/** "Song queue · 6" on the bar POS and the bar orders screen: opens the song queue in bar mode. */
export function SongQueueLink({ venueId }: { venueId: string }) {
  const { t } = useT();
  const { state } = useSession();
  const { subscribe } = useEvents();
  const barModeOn = state.status === "signedIn" && state.membership.modules.bar_mode !== "off";
  const [count, setCount] = useState<number | null>(null);
  const load = useCallback(async () => {
    if (!barModeOn) return setCount(null);
    try {
      setCount((await api<{ count: number }>("GET", `/v1/venues/${venueId}/song-queue`)).count);
    } catch {
      setCount(null);
    }
  }, [venueId, barModeOn]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "song_queue.updated")) void load();
      }),
    [subscribe, load],
  );
  if (count === null) return null;
  return (
    <Link to="/song-queue" className="song-count">
      {t("rail.songQueue", { n: count })}
    </Link>
  );
}

const startProblem = (e: unknown): MessageKey => {
  if (!(e instanceof ApiCallError)) return "songQueue.failed";
  if (e.code === "payment_unknown") return "pay.unknown";
  const reason = e.details["reason"];
  if (reason === "needs_drink_credit") return "songQueue.needsCredit";
  if (reason === "needs_tab") return "songQueue.needsTab";
  if (reason === "hold_declined") return "songQueue.holdDeclined";
  if (reason === "song_not_queued" || e.code === "not_found") return "songQueue.gone";
  if (reason === "at_end") return "songQueue.atEnd";
  return "songQueue.failed";
};

export function SongQueue() {
  const { t, time } = useT();
  const { state } = useSession();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [queue, setQueue] = useState<Queue | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** A problem with one song, shown under it. */
  const [problem, setProblem] = useState<{ id: string; key: MessageKey } | null>(null);
  /** A start whose hold is still being checked: never tapped again. */
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [moving, setMoving] = useState<{ id: string; direction: "up" | "down" } | null>(null);
  const [reason, setReason] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      setQueue(await api<Queue>("GET", `/v1/venues/${venueId}/song-queue`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "song_queue.updated")) void load();
      }),
    [subscribe, load],
  );

  if (signedIn && hiddenScreens(signedIn.membership.modules).has("songQueue")) return <NotFound />;

  const act = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setProblem(null);
    try {
      await work();
      return true;
    } catch (e) {
      const key = startProblem(e);
      if (key === "pay.unknown") setChecking((s) => new Set(s).add(id));
      setProblem({ id, key });
      return false;
    } finally {
      setBusy(null);
      await load();
    }
  };
  const start = (id: string) =>
    act(id, () =>
      api("POST", `/v1/venues/${venueId}/song-queue/${id}/start`, undefined, {
        idempotencyKey: `song-start-${id}-${crypto.randomUUID()}`,
      }),
    );
  const skip = (id: string) =>
    act(id, () => api("POST", `/v1/venues/${venueId}/song-queue/${id}/skip`));
  const move = async (e: FormEvent) => {
    e.preventDefault();
    if (!moving || !reason.trim()) return;
    const { id, direction } = moving;
    if (
      await act(id, () =>
        api("POST", `/v1/venues/${venueId}/song-queue/${id}/move`, {
          direction,
          reason: reason.trim(),
        }),
      )
    ) {
      setMoving(null);
      setReason("");
    }
  };

  const songs = queue?.up_next ?? [];
  return (
    <section className="screen song-queue">
      <header className="song-queue-head">
        <h1>{t("menu.songQueue")}</h1>
        {queue && (
          <p className="small muted">
            {t("songQueue.round", { round: queue.round, sung: queue.songs_sung })}
          </p>
        )}
        <button type="button" className="primary" onClick={() => setAdding((a) => !a)}>
          {t("songQueue.addSinger")}
        </button>
      </header>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {adding && venueId && (
        <AddSinger
          venueId={venueId}
          onDone={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
      {!queue && !failed && <p role="status">{t("shell.loading")}</p>}
      {queue && (
        <>
          <section aria-labelledby="sq-now" className="sq-now">
            <h2 id="sq-now">{t("songQueue.nowSinging")}</h2>
            {queue.singing ? (
              <p>
                <strong data-guest-text>{queue.singing.singer}</strong>{" "}
                <span data-guest-text>{songLine(queue.singing)}</span>
                {queue.singing.started_at && (
                  <span className="small muted">
                    {" "}
                    {t("songQueue.startedAt", {
                      time: time(queue.singing.started_at, timeZone),
                    })}
                  </span>
                )}
              </p>
            ) : (
              <p className="empty">{t("songQueue.nobody")}</p>
            )}
          </section>
          <section aria-labelledby="sq-next">
            <h2 id="sq-next">{t("songQueue.upNext")}</h2>
            {songs.length === 0 && <p className="empty">{t("songQueue.empty")}</p>}
            <ol className="sq-list">
              {songs.map((s, i) => (
                <li key={s.id} className="sq-song" aria-label={s.singer}>
                  <div className="sq-who">
                    <span className="sq-place">{s.place}</span>
                    <div>
                      <strong data-guest-text>{s.singer}</strong>
                      <div className="small" data-guest-text>
                        {songLine(s)}
                      </div>
                      <div className="small muted">
                        {t("songQueue.songRound", { round: s.round })} ·{" "}
                        {t("songQueue.credits", { count: s.credits })}
                      </div>
                      {s.flag === "needs_drink_credit" && (
                        <span className="pill alert-pink">{t("songQueue.needsCredit")}</span>
                      )}
                    </div>
                  </div>
                  <div className="actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy !== null || checking.has(s.id)}
                      onClick={() => void start(s.id)}
                    >
                      {t("songQueue.started")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy !== null || checking.has(s.id)}
                      onClick={() => void skip(s.id)}
                    >
                      {t("songQueue.skip")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy !== null || i === 0}
                      onClick={() => setMoving({ id: s.id, direction: "up" })}
                    >
                      {t("songQueue.moveUp")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy !== null || i === songs.length - 1}
                      onClick={() => setMoving({ id: s.id, direction: "down" })}
                    >
                      {t("songQueue.moveDown")}
                    </button>
                  </div>
                  {moving?.id === s.id && (
                    <form className="sq-move" onSubmit={(e) => void move(e)}>
                      <label>
                        <span>{t("songQueue.moveReason")}</span>
                        <input
                          value={reason}
                          required
                          maxLength={300}
                          autoFocus
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </label>
                      <button type="submit" className="primary" disabled={!reason.trim()}>
                        {t(moving.direction === "up" ? "songQueue.moveUp" : "songQueue.moveDown")}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setMoving(null);
                          setReason("");
                        }}
                      >
                        {t("songQueue.cancel")}
                      </button>
                    </form>
                  )}
                  {problem?.id === s.id && (
                    <p className="error" role="alert">
                      {t(problem.key)}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </section>
  );
}

/** A US number becomes +1…, as on the queue page. */
const toE164 = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : phone;
};

/** + Singer: a name and a number confirmed by a texted code (none if it's already confirmed), then a song. */
function AddSinger({ venueId, onDone }: { venueId: string; onDone: () => void }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [singer, setSinger] = useState<{ id: string; confirmed: boolean } | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>, onError: (e: unknown) => MessageKey) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(onError(e));
    } finally {
      setBusy(false);
    }
  };
  const sendCode = (e: FormEvent) => {
    e.preventDefault();
    void run(
      async () => {
        setSinger(
          await api<{ id: string; confirmed: boolean }>("POST", `/v1/venues/${venueId}/singers`, {
            display_name: name.trim(),
            phone_e164: toE164(phone),
          }),
        );
      },
      (err) =>
        err instanceof ApiCallError && err.details["reason"] === "phone_taken"
          ? "songQueue.singer.taken"
          : err instanceof ApiCallError && err.code === "invalid_request"
            ? "songQueue.singer.badPhone"
            : "songQueue.failed",
    );
  };
  const confirm = (e: FormEvent) => {
    e.preventDefault();
    if (!singer) return;
    void run(
      async () => {
        await api("POST", `/v1/venues/${venueId}/singers/${singer.id}/verify`, {
          code: code.trim(),
        });
        setSinger({ ...singer, confirmed: true });
      },
      (err) =>
        err instanceof ApiCallError && err.code === "invalid_request"
          ? "songQueue.singer.wrongCode"
          : "songQueue.failed",
    );
  };
  const addSong = (e: FormEvent) => {
    e.preventDefault();
    if (!singer) return;
    void run(
      async () => {
        await api("POST", `/v1/venues/${venueId}/song-queue`, {
          singer_id: singer.id,
          title: title.trim(),
          artist: artist.trim() || null,
        });
        onDone();
      },
      () => "songQueue.failed",
    );
  };

  return (
    <section className="sq-add" aria-labelledby="sq-add-title">
      <h2 id="sq-add-title">{t("songQueue.singer.title")}</h2>
      {!singer && (
        <form onSubmit={sendCode}>
          <label>
            <span>{t("songQueue.singer.name")}</span>
            <input value={name} required maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>{t("songQueue.singer.phone")}</span>
            <input
              value={phone}
              required
              type="tel"
              autoComplete="off"
              onChange={(e) => setPhone(e.target.value)}
            />
            <span className="small muted">{t("songQueue.singer.phoneHint")}</span>
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {t("songQueue.singer.sendCode")}
          </button>
        </form>
      )}
      {singer && !singer.confirmed && (
        <form onSubmit={confirm}>
          <label>
            <span>{t("songQueue.singer.code")}</span>
            <input
              value={code}
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {t("songQueue.singer.confirm")}
          </button>
        </form>
      )}
      {singer?.confirmed && (
        <form onSubmit={addSong}>
          <h3>{t("songQueue.song.for", { name: name.trim() })}</h3>
          <label>
            <span>{t("songQueue.song.title")}</span>
            <input
              value={title}
              required
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            <span>{t("songQueue.song.artist")}</span>
            <input value={artist} maxLength={120} onChange={(e) => setArtist(e.target.value)} />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {t("songQueue.song.add")}
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
    </section>
  );
}

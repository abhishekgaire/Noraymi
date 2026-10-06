"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { EventClient, t } from "@west4/shared";
import { eventsOrigin } from "../../../live";

interface SingerSong {
  readonly id: string;
  readonly title: string;
  readonly artist: string | null;
  readonly status: "singing" | "queued";
  readonly flag: "needs_drink_credit" | null;
}

interface QueuePage {
  readonly venue_id: string;
  readonly venue_name: string;
  readonly open: boolean;
  readonly song_price_cents: number | null;
  readonly singing: {
    readonly singer: string;
    readonly title: string;
    readonly artist: string | null;
  } | null;
  readonly up_next: readonly { readonly place: number; readonly singer: string }[];
  readonly me: {
    readonly display_name: string;
    readonly credits: number;
    readonly singers_before: number | null;
    readonly singing_now: boolean;
    readonly songs: readonly SingerSong[];
  } | null;
}

/** The page refreshes on this timer too, so a phone whose live channel dropped still catches up. */
const REFRESH_MS = 15_000;

const songLine = (title: string, artist: string | null) =>
  artist ? t("en", "guestSing.songLine", { title, artist }) : title;

/** A US number becomes +1…, as on the waitlist page. */
const toE164 = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : phone;
};

/**
 * The singer's queue page (M6-20): who's singing and the next names; joining with a name and a number
 * confirmed by a code; then the singer's place, credits and songs, following `song_queue.updated`.
 */
export function SingQueue({ slug }: { slug: string }) {
  const api = `/v1/public/venues/${encodeURIComponent(slug)}`;
  const [page, setPage] = useState<QueuePage | null>(null);
  const [off, setOff] = useState(false);
  const [failed, setFailed] = useState(false);
  const [catalog, setCatalog] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`${api}/queue`, { cache: "no-store" }).catch(() => null);
    if (!r) {
      setFailed(true);
      return null;
    }
    if (r.status === 404) {
      setOff(true);
      return null;
    }
    if (!r.ok) {
      setFailed(true);
      return null;
    }
    const p = (await r.json()) as QueuePage;
    setFailed(false);
    setOff(false);
    setPage(p);
    return p;
  }, [api]);

  useEffect(() => {
    let client: EventClient | undefined;
    void load().then((p) => {
      if (!p) return;
      client = new EventClient({
        url: `${eventsOrigin()}/v1/venues/${p.venue_id}/events`,
        connect: (url) => new WebSocket(url) as never,
        onRefetch: () => void load(),
        onFullRefetch: () => void load(),
        maxBackoffMs: 60_000,
      });
      client.start();
    });
    void fetch(`${api}/songs?q=`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { catalog: boolean }) : null))
      .then((s) => setCatalog(!!s?.catalog))
      .catch(() => undefined);
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearInterval(timer);
      client?.stop();
    };
  }, [api, load]);

  if (off)
    return (
      <main className="guest">
        <h1>{t("en", "guestSing.title")}</h1>
        <p role="status">{t("en", "guestSing.off")}</p>
      </main>
    );
  if (!page)
    return (
      <main className="guest">
        <h1>{t("en", "guestSing.title")}</h1>
        <p role="status">{failed ? t("en", "guestSing.failed") : "…"}</p>
      </main>
    );

  return (
    <main className="guest sing-page">
      <p className="venue">{page.venue_name}</p>
      <h1>{t("en", "guestSing.title")}</h1>
      {failed && (
        <p className="notice" role="status">
          {t("en", "guestSing.failed")}
        </p>
      )}
      {page.me && <Mine me={page.me} songPriceCents={page.song_price_cents} />}
      {page.me && page.open && <AddSong api={api} catalog={catalog} onAdded={() => void load()} />}
      {!page.me && page.open && <Join api={api} onJoined={() => void load()} />}
      {!page.open && <p role="status">{t("en", "guestSing.off")}</p>}
      <section aria-labelledby="queue-h">
        <h2 id="queue-h">{t("en", "guestSing.nowSinging")}</h2>
        {page.singing ? (
          <p>
            <strong>{page.singing.singer}</strong> ·{" "}
            {songLine(page.singing.title, page.singing.artist)}
          </p>
        ) : (
          <p>{t("en", "guestSing.nobody")}</p>
        )}
        {page.up_next.length > 0 && (
          <>
            <h3>{t("en", "guestSing.upNext")}</h3>
            <ol className="up-next">
              {page.up_next.map((s) => (
                <li key={s.place}>{s.singer}</li>
              ))}
            </ol>
          </>
        )}
      </section>
    </main>
  );
}

/** The singer's own place, credits and songs. */
function Mine({
  me,
  songPriceCents,
}: {
  me: NonNullable<QueuePage["me"]>;
  songPriceCents: number | null;
}) {
  const place = me.singing_now
    ? t("en", "guestSing.singingNow")
    : me.singers_before === null
      ? t("en", "guestSing.noSong")
      : me.singers_before === 0
        ? t("en", "guestSing.upNextAlert")
        : me.singers_before === 1
          ? t("en", "guestSing.before.one")
          : t("en", "guestSing.before.many", { count: me.singers_before });
  const flagged = me.songs.some((s) => s.flag === "needs_drink_credit");
  return (
    <section aria-labelledby="me-h">
      <h2 id="me-h">{me.display_name}</h2>
      <p className="big" role="status">
        {place}
      </p>
      <dl className="credits">
        <dt>{t("en", "guestSing.credits")}</dt>
        <dd>{me.credits}</dd>
      </dl>
      {me.credits === 0 && songPriceCents === null && !flagged && (
        <p>{t("en", "guestSing.needsCredit")}</p>
      )}
      <p className="hint">{t("en", "guestSing.creditsLead")}</p>
      {me.songs.length > 0 && (
        <>
          <h3>{t("en", "guestSing.mySongs")}</h3>
          <ul className="my-songs">
            {me.songs.map((s) => (
              <li key={s.id}>
                {songLine(s.title, s.artist)}
                {s.flag === "needs_drink_credit" && (
                  <span className="flag">{t("en", "guestSing.needsCredit")}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** A display name and a number, then the code texted to it. */
function Join({ api, onJoined }: { api: string; onJoined: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    // M2-27: the CAPTCHA's answer joins this request once a provider is chosen.
    const r = await fetch(`${api}/singers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: name.trim(), phone_e164: toE164(phone) }),
    }).catch(() => null);
    setBusy(false);
    if (!r?.ok) {
      setError(t("en", "guestSing.sendFailed"));
      return;
    }
    setSent(true);
    setCode("");
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch(`${api}/singers/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone_e164: toE164(phone), code: code.trim() }),
    }).catch(() => null);
    setBusy(false);
    if (r?.ok) {
      onJoined();
      return;
    }
    const body = r
      ? ((await r.json().catch(() => ({}))) as { error?: { details?: { reason?: string } } })
      : {};
    setError(
      body.error?.details?.reason === "code_expired"
        ? t("en", "guestSing.codeExpired")
        : body.error?.details?.reason === "wrong_code"
          ? t("en", "guestSing.wrongCode")
          : t("en", "guestSing.failed"),
    );
  };

  return (
    <section aria-labelledby="join-h">
      <h2 id="join-h">{t("en", "guestSing.join")}</h2>
      <p>{t("en", "guestSing.joinLead")}</p>
      {!sent ? (
        <form onSubmit={(e) => void ask(e)}>
          <label>
            {t("en", "guestSing.name")}
            <input
              value={name}
              maxLength={40}
              autoComplete="nickname"
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            {t("en", "guestSing.mobile")}
            <input
              type="tel"
              value={phone}
              autoComplete="tel"
              required
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy || !name.trim() || !phone}>
            {busy ? t("en", "guestSing.sending") : t("en", "guestSing.sendCode")}
          </button>
        </form>
      ) : (
        <form onSubmit={(e) => void confirm(e)}>
          <label>
            {t("en", "guestSing.code")}
            <input
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy || code.length !== 6}>
            {busy ? t("en", "guestSing.confirming") : t("en", "guestSing.confirm")}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void ask()}>
            {t("en", "guestSing.newCode")}
          </button>
        </form>
      )}
    </section>
  );
}

/** A song typed by hand, or searched once a songbook is loaded (M6-23). */
function AddSong({
  api,
  catalog,
  onAdded,
}: {
  api: string;
  catalog: boolean;
  onAdded: () => void;
}) {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<readonly { title: string; artist: string | null }[]>([]);

  const search = async (text: string) => {
    setQ(text);
    if (text.trim().length < 2) {
      setFound([]);
      return;
    }
    const r = await fetch(`${api}/songs?q=${encodeURIComponent(text.trim())}`, {
      cache: "no-store",
    }).catch(() => null);
    if (r?.ok) setFound(((await r.json()) as { songs: typeof found }).songs);
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch(`${api}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title.trim(), artist: artist.trim() || null }),
    }).catch(() => null);
    setBusy(false);
    if (!r?.ok) {
      setError(t("en", "guestSing.addFailed"));
      return;
    }
    setTitle("");
    setArtist("");
    onAdded();
  };

  return (
    <section aria-labelledby="add-h">
      <h2 id="add-h">{t("en", "guestSing.addSong")}</h2>
      <form onSubmit={(e) => void add(e)}>
        {catalog && (
          <>
            <label>
              {t("en", "guestSing.search")}
              <input type="search" value={q} onChange={(e) => void search(e.target.value)} />
            </label>
            {found.length > 0 && (
              <ul className="found">
                {found.map((s) => (
                  <li key={`${s.title}|${s.artist ?? ""}`}>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setTitle(s.title);
                        setArtist(s.artist ?? "");
                      }}
                    >
                      {songLine(s.title, s.artist)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <label>
          {t("en", "guestSing.songTitle")}
          <input
            value={title}
            maxLength={120}
            required
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          {t("en", "guestSing.artist")}
          <input value={artist} maxLength={120} onChange={(e) => setArtist(e.target.value)} />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy || !title.trim()}>
          {busy ? t("en", "guestSing.adding") : t("en", "guestSing.add")}
        </button>
      </form>
    </section>
  );
}

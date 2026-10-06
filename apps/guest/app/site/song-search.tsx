"use client";
import { useRef, useState } from "react";
import { t } from "@west4/shared";

/**
 * The website's songbook search (M6-23; screens Main note 5): shown once the venue has a songbook,
 * reading the same `GET /v1/public/venues/{slug}/songs?q=` as the singer's queue page.
 */
export function SongSearch({ slug }: { slug: string }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<
    readonly { id: string; title: string; artist: string | null }[] | null
  >(null);
  const asked = useRef(0);

  const search = async (text: string) => {
    setQ(text);
    const n = ++asked.current;
    if (text.trim().length < 2) {
      setFound(null);
      return;
    }
    const r = await fetch(
      `/v1/public/venues/${encodeURIComponent(slug)}/songs?q=${encodeURIComponent(text.trim())}`,
      { cache: "no-store" },
    ).catch(() => null);
    if (n !== asked.current || !r?.ok) return;
    setFound(((await r.json()) as { songs: NonNullable<typeof found> }).songs);
  };

  return (
    <div className="song-search">
      <label>
        {t("en", "site.songbook.search")}
        <input type="search" value={q} onChange={(e) => void search(e.target.value)} />
      </label>
      {found?.length === 0 && <p className="muted">{t("en", "site.songbook.noMatch")}</p>}
      {found && found.length > 0 && (
        <ul className="found" aria-live="polite">
          {found.map((s) => (
            <li key={s.id}>
              {s.artist
                ? t("en", "guestSing.songLine", { title: s.title, artist: s.artist })
                : s.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

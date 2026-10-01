"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { t } from "@west4/shared";

/**
 * Join a room (M3-08; screens N3): the room's name, then its 5-character
 * code, traded once for a token in a cookie. A wrong code says so; a room
 * with no party in it says it's closed.
 */
export function JoinRoom({ slug, roomId }: { slug: string; roomId: string }) {
  const router = useRouter();
  const [room, setRoom] = useState<{ room_name: string; open: boolean } | null>(null);
  const [missing, setMissing] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/v1/public/venues/${encodeURIComponent(slug)}/rooms/${encodeURIComponent(roomId)}`;

  useEffect(() => {
    void fetch(base, { cache: "no-store" })
      .then(async (r) =>
        r.ok ? setRoom((await r.json()) as { room_name: string; open: boolean }) : setMissing(true),
      )
      .catch(() => setMissing(true));
  }, [base]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${base}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (r.ok) {
        router.replace("/room");
        return;
      }
      const body = (await r.json().catch(() => ({}))) as {
        error?: { details?: { reason?: string } };
      };
      const reason = body.error?.details?.reason;
      if (reason === "closed") setRoom((x) => (x ? { ...x, open: false } : x));
      else
        setError(
          reason === "wrong_code"
            ? t("en", "guestRoom.join.wrong")
            : t("en", "guestRoom.join.failed"),
        );
    } catch {
      setError(t("en", "guestRoom.join.failed"));
    } finally {
      setBusy(false);
    }
  };

  if (missing)
    return (
      <main className="guest">
        <p role="alert">{t("en", "guestRoom.join.failed")}</p>
      </main>
    );
  if (!room) return <main className="guest" aria-busy="true" />;
  if (!room.open)
    return (
      <main className="guest">
        <h1>{room.room_name}</h1>
        <p role="status">{t("en", "guestRoom.join.closed", { room: room.room_name })}</p>
      </main>
    );
  return (
    <main className="guest">
      <h1>{t("en", "guestRoom.join.title", { room: room.room_name })}</h1>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          {t("en", "guestRoom.join.code")}
          <input
            className="code"
            value={code}
            maxLength={5}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            aria-describedby="code-hint"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        </label>
        <p id="code-hint" className="hint">
          {t("en", "guestRoom.join.hint")}
        </p>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy || code.trim().length !== 5}>
          {busy ? t("en", "guestRoom.join.joining") : t("en", "guestRoom.join.submit")}
        </button>
      </form>
    </main>
  );
}

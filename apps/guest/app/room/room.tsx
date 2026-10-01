"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@west4/shared";

interface RoomSession {
  readonly venue: { readonly name: string; readonly slug: string };
  readonly room: { readonly id: string; readonly name: string };
  readonly code: string | null;
  readonly is_host: boolean;
  readonly moved: { readonly from: string; readonly to: string } | null;
  readonly rotated: boolean;
}

const REFRESH_MS = 10_000;

/**
 * The joined phone's room (M3-08): the room and its code in the header, host
 * or friend, and after a rotation the new code, with "You've moved to Room 11
 * · new code …" after a move. It asks the API every 10 seconds; each answer
 * may carry a fresh token in the cookie.
 */
export function RoomPage() {
  const [room, setRoom] = useState<RoomSession | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [gone, setGone] = useState<"ended" | "out" | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/v1/public/room-session", { cache: "no-store" }).catch(() => null);
    if (!r) return;
    if (!r.ok) {
      setGone(r.status === 404 ? "ended" : "out");
      return;
    }
    const s = (await r.json()) as RoomSession;
    setRoom(s);
    if (s.moved) setNotice(t("en", "guestRoom.moved", { room: s.moved.to, code: s.code ?? "" }));
    else if (s.rotated)
      setNotice(t("en", "guestRoom.newCode", { room: s.room.name, code: s.code ?? "" }));
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (gone)
    return (
      <main className="guest">
        <p role="status">
          {gone === "ended" ? t("en", "guestRoom.ended") : t("en", "guestRoom.hostLink.failed")}
        </p>
      </main>
    );
  if (!room) return <main className="guest" aria-busy="true" />;
  return (
    <main className="guest room-page">
      <header>
        <p className="venue">{room.venue.name}</p>
        <h1>
          {room.code
            ? t("en", "guestRoom.header", { room: room.room.name, code: room.code })
            : room.room.name}
        </h1>
        <p>{room.is_host ? t("en", "guestRoom.host") : t("en", "guestRoom.friend")}</p>
      </header>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
    </main>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { t } from "@west4/shared";

/** Trades the host link's token for the room cookie, then opens the room page; an old link says so. */
export function HostJoin({ token }: { token: string }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void fetch("/v1/public/room-session/host", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((r) => (r.ok ? router.replace("/room") : setFailed(true)))
      .catch(() => setFailed(true));
  }, [token, router]);

  return (
    <main className="guest">
      {failed ? (
        <p role="alert">{t("en", "guestRoom.hostLink.failed")}</p>
      ) : (
        <p role="status">{t("en", "guestRoom.join.joining")}</p>
      )}
    </main>
  );
}

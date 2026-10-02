"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { t } from "@west4/shared";
import { RoomPage } from "../room/room";
import { pairTablet, readTablet, tabletApi, type TabletDevice } from "./device";

/**
 * The room tablet (M3-12; screens N4): paired once to its room with a code
 * from Admin → Devices, then the room page in kiosk mode: the clock and the
 * running total from the server, the menu and Call staff in a session, and
 * "Room available" between sessions. No PIN pad, no help link.
 */
export function Tablet() {
  const [device, setDevice] = useState<TabletDevice | null | undefined>(undefined);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void readTablet().then(setDevice);
  }, []);
  const api = useMemo(() => (device ? tabletApi(device) : undefined), [device]);

  const pair = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await pairTablet(code);
    if (r === "wrong_kind") setError(t("en", "tablet.pair.wrongKind"));
    else if (r === "refused") setError(t("en", "tablet.pair.failed"));
    else setDevice(r);
  };

  if (device === undefined) return <main className="guest" aria-busy="true" />;
  if (device && api) return <RoomPage api={api} tablet />;
  return (
    <main className="guest">
      <h1>{t("en", "tablet.pair.title")}</h1>
      <form onSubmit={(e) => void pair(e)}>
        <label>
          {t("en", "tablet.pair.code")}
          <input
            value={code}
            autoComplete="off"
            required
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit">{t("en", "tablet.pair.submit")}</button>
      </form>
    </main>
  );
}

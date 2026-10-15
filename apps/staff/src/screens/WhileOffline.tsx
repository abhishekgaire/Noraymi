import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useConnection } from "../connection.js";
import { useT } from "../i18n.js";
import { useQueue } from "../queue.js";

/**
 * "While offline" (U-16; D133; spec 09 · Offline and queue mode): one card on the bar POS and on
 * Rooms, shown only while the screen is offline, saying in plain words what still works, what to
 * write on paper, and where the offline code is. Whether cash quick sales work offline comes from the
 * venue's switch, read from the bar POS terminal's kept answer (null terms: off).
 */
export function WhileOffline({ venueId }: { venueId: string }) {
  const { t } = useT();
  const connection = useConnection();
  const queue = useQueue();
  const offline = connection.kind === "offline";
  const [cashOn, setCashOn] = useState(false);

  useEffect(() => {
    if (!offline || !venueId) return;
    let live = true;
    // Offline, the desktop app answers this from what it kept at the last sync.
    api<{ offline_cash?: unknown }>("GET", `/v1/venues/${venueId}/pos/terminal`)
      .then((r) => {
        if (live) setCashOn(r.offline_cash !== null && r.offline_cash !== undefined);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [offline, venueId]);

  if (!offline) return null;
  const desk = queue.available;
  return (
    <section
      className="card while-offline"
      aria-labelledby="while-offline-title"
      data-testid="while-offline"
    >
      <h2 id="while-offline-title">{t("whileOffline.title")}</h2>
      <ul className="small">
        <li>{t("whileOffline.works")}</li>
        <li>{desk ? t("whileOffline.queue") : t("whileOffline.notDesk")}</li>
        <li>{desk && cashOn ? t("whileOffline.cashOn") : t("whileOffline.cashOff")}</li>
        <li>{t("whileOffline.paper")}</li>
        <li>{t("whileOffline.code")}</li>
        <li>{t("whileOffline.cards")}</li>
      </ul>
    </section>
  );
}

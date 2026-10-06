import { useEffect, useState } from "react";
import type { MessageKey } from "@west4/shared";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { QuickBooksExport } from "./QuickBooksExport.js";

/**
 * Admin → Connections (M4-01; screens AdminDesk note 21): Stripe, Twilio and
 * email, each with its status from `integrations`. No Yelp or Homebase items
 * until a partner program is chosen.
 */
interface Connection {
  readonly kind: "stripe" | "twilio" | "email";
  readonly status: string;
}

export function Connections() {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [rows, setRows] = useState<readonly Connection[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!venueId) return;
    api<{ connections: Connection[] }>("GET", `/v1/venues/${venueId}/connections`)
      .then((r) => setRows(r.connections))
      .catch(() => setFailed(true));
  }, [venueId]);

  return (
    <section className="connections">
      <h2>{t("admin.section.connections")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {rows === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.kind} aria-label={t(`connections.${r.kind}` as MessageKey)}>
              <span>{t(`connections.${r.kind}` as MessageKey)}</span>
              <span className={r.status === "connected" ? "ok" : "muted"}>
                {t(`connections.status.${r.status}` as MessageKey)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {venueId && <QuickBooksExport venueId={venueId} />}
    </section>
  );
}

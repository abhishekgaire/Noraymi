import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { Licenses } from "./Licenses.js";

/**
 * Set up your venue's step 10, licenses (O-12; spec 17 · Step details 10): Admin → Licenses' own
 * register (M8-09), with its files and renewal reminders. The liquor license is needed before
 * Ready to open; a missing music license is a warning only. With the Kitchen module allowed, the
 * health department's permit is expected too, and the Food Protection Certificate holders are
 * kept as "Other" licenses (D120: nothing in the software enforces who's on site).
 */
export function LicensesStep({ onSaved }: { onSaved: () => void }) {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [kitchen, setKitchen] = useState(false);
  useEffect(() => {
    if (!venueId) return;
    api<{ modules: { id: string; allowed: boolean }[] }>("GET", `/v1/venues/${venueId}/modules`)
      .then((r) => setKitchen(r.modules.some((m) => m.id === "kitchen" && m.allowed)))
      .catch(() => setKitchen(false));
  }, [venueId]);
  return (
    <div className="setup-card setup-form">
      <p className="muted small">{t("onboarding.licenses.intro")}</p>
      {kitchen && <p className="notice small">{t("onboarding.licenses.kitchen")}</p>}
      <Licenses embedded kitchen={kitchen} onSaved={onSaved} />
    </div>
  );
}

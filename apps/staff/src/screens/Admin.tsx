import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * Admin's stub (M1-26, Admin note 1). Admin opens only in a passkey session:
 * on a phone, or in a PIN or badge session on a shared screen, the screen
 * says so and never shows a PIN pad. The sections land with their tickets.
 */
export function Admin() {
  const { t } = useT();
  const { state } = useSession();
  const assurance = state.status === "signedIn" ? state.me.session.assurance : null;
  const phone = typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;
  return (
    <section className="screen">
      <h1>{t("menu.admin")}</h1>
      {assurance === "passkey" ? (
        <p className="empty">{t("shell.empty")}</p>
      ) : (
        <p className="notice" role="status">
          {phone ? t("admin.needsPasskeyPhone") : t("admin.needsPasskey")}
        </p>
      )}
    </section>
  );
}

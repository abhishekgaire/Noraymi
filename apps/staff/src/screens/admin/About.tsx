import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → About (P-14): the staff app's version (VITE_APP_VERSION at build, else "dev"), the
 * desktop app's when the screen runs inside it, the server's, the venue's id and our support
 * contact. An unset contact reads "Not set yet": it's never invented.
 */
interface AboutAnswer {
  readonly venue_id: string;
  readonly venue_name: string;
  readonly server_version: string;
  readonly support: { readonly email: string | null; readonly phone: string | null };
}

const staffVersion = (import.meta.env["VITE_APP_VERSION"] as string | undefined) || "dev";

export function About() {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [about, setAbout] = useState<AboutAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [desktop, setDesktop] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      setAbout(await api<AboutAnswer>("GET", `/v1/venues/${venueId}/about`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const shell = typeof window === "undefined" ? undefined : window.west4;
    if (shell)
      void shell
        .version()
        .then(setDesktop)
        .catch(() => setDesktop(null));
  }, []);

  const notSet = <span className="muted">{t("about.notSet")}</span>;
  return (
    <section className="about" aria-labelledby="about-h">
      <h2 id="about-h">{t("admin.section.about")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("about.cantLoad")}{" "}
          <button type="button" className="secondary" onClick={() => void load()}>
            {t("shell.error.retry")}
          </button>
        </p>
      )}
      {about === null && !failed && <p role="status">{t("about.loading")}</p>}
      <dl className="about-list">
        <dt>{t("about.staffApp")}</dt>
        <dd data-testid="about-staff">{staffVersion}</dd>
        <dt>{t("about.desktopApp")}</dt>
        <dd>{desktop ?? <span className="muted">{t("about.notDesktop")}</span>}</dd>
        {about && (
          <>
            <dt>{t("about.server")}</dt>
            <dd>{about.server_version}</dd>
            <dt>{t("about.venue")}</dt>
            <dd>{about.venue_name}</dd>
            <dt>{t("about.venueId")}</dt>
            <dd>
              <code className="about-id">{about.venue_id}</code>
            </dd>
            <dt>
              {t("about.support")} · {t("about.supportEmail")}
            </dt>
            <dd>
              {about.support.email ? (
                <a href={`mailto:${about.support.email}`}>{about.support.email}</a>
              ) : (
                notSet
              )}
            </dd>
            <dt>
              {t("about.support")} · {t("about.supportPhone")}
            </dt>
            <dd>
              {about.support.phone ? (
                <a href={`tel:${about.support.phone}`}>{about.support.phone}</a>
              ) : (
                notSet
              )}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

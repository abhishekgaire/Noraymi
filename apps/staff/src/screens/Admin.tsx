import { Navigate, NavLink, Outlet } from "react-router";
import { visibleSections } from "../admin/sections.js";
import { AdminDraftProvider, useAdminDraft } from "../admin/draft.js";
import { useT } from "../i18n.js";
import { useSession, type SessionState } from "../session.js";

/**
 * The AdminDesk shell (M1-31; screens.md · AdminDesk). Admin opens only in a
 * passkey session, in the desktop app or any browser: a list of sections on
 * the left with a one-line hint each, the open section on the right, and the
 * "Save and publish" bar whenever a section has unsaved settings. Managers
 * see every section except Payments, Team and Console. On a phone, or in a
 * PIN or badge session, the screen says Admin needs a passkey and never shows
 * a PIN pad.
 */
export function Admin() {
  const { t } = useT();
  const { state } = useSession();
  const assurance = state.status === "signedIn" ? state.me.session.assurance : null;
  const phone = typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;
  return (
    <section className="screen admin-screen">
      <h1>{t("menu.admin")}</h1>
      {assurance === "passkey" && state.status === "signedIn" ? (
        <AdminDraftProvider venueId={state.membership.venue_id}>
          <AdminDesk state={state} />
        </AdminDraftProvider>
      ) : (
        <p className="notice" role="status">
          {phone ? t("admin.needsPasskeyPhone") : t("admin.needsPasskey")}
        </p>
      )}
    </section>
  );
}

function AdminDesk({ state }: { state: Extract<SessionState, { status: "signedIn" }> }) {
  const { t } = useT();
  const sections = visibleSections(state.membership.permissions);
  return (
    <div className="admin">
      <nav className="admin-nav" aria-label={t("admin.sections")}>
        <ul>
          {sections.map((s) => (
            <li key={s.id}>
              <NavLink to={s.path} className="admin-link">
                <span className="admin-link-name">{t(s.labelKey)}</span>
                <span className="admin-link-hint">{t(s.hintKey)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="admin-body">
        <Outlet />
        <SaveBar />
      </div>
    </div>
  );
}

/** `/admin` opens the first section the person may see; a manager with none yet reads why. */
export function AdminIndex() {
  const { t } = useT();
  const { state } = useSession();
  if (state.status !== "signedIn") return null;
  const first = visibleSections(state.membership.permissions)[0];
  return first ? (
    <Navigate to={first.path} replace />
  ) : (
    <p className="empty">{t("admin.nothingYet")}</p>
  );
}

function SaveBar() {
  const { t, tn } = useT();
  const draft = useAdminDraft();
  const count = Object.keys(draft.values).length;
  if (!draft.dirty && draft.status === "idle") return null;
  return (
    <div className="admin-save" role="status">
      {draft.dirty ? (
        <>
          <span>{tn("admin.unsaved", count)}</span>
          <button
            type="button"
            className="primary"
            disabled={draft.saving}
            onClick={() => void draft.save()}
          >
            {t("admin.saveAndPublish")}
          </button>
          <button type="button" className="secondary" onClick={draft.discard}>
            {t("admin.discard")}
          </button>
        </>
      ) : (
        <span className={draft.status === "failed" ? "error" : ""}>
          {draft.status === "failed" ? t("admin.publishFailed") : t("admin.published")}
        </span>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Navigate, NavLink, Outlet } from "react-router";
import { visibleSections } from "../admin/sections.js";
import { AdminDraftProvider, useAdminDraft } from "../admin/draft.js";
import { api } from "../api.js";
import { useEvents } from "../events.js";
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
      <RulePackNotice venueId={state.membership.venue_id} />
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
  const failed = draft.status === "failed" && (
    <span className="error">
      {t("admin.publishFailed")}
      {draft.error ? ` · ${draft.error}` : ""}
    </span>
  );
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
          {failed}
        </>
      ) : (
        failed || <span>{t("admin.published")}</span>
      )}
    </div>
  );
}

interface RulePackAnswer {
  readonly next: {
    readonly version: string;
    readonly effective_on: string;
    readonly changes: readonly { path: string; from: unknown; to: unknown }[];
  } | null;
}

/**
 * A published rule-pack version that hasn't applied yet (M1-36; spec 12 · 11):
 * every venue on the pack reads what changes and from which business date,
 * here, before it takes effect at that date's 6:00 AM cutover.
 */
function RulePackNotice({ venueId }: { venueId: string }) {
  const { t, date } = useT();
  const { subscribe } = useEvents();
  const [next, setNext] = useState<RulePackAnswer["next"]>(null);
  const load = useCallback(async () => {
    const answer = await api<RulePackAnswer>("GET", `/v1/venues/${venueId}/rule-pack`);
    setNext(answer.next);
  }, [venueId]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "rule_pack.published"))
          load().catch(() => {});
      }),
    [subscribe, load],
  );
  if (!next) return null;
  const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  return (
    <section className="notice rule-pack-notice" role="status">
      <strong>
        {t("admin.rulePack.next", { version: next.version, date: date(next.effective_on) })}
      </strong>
      {next.changes.length === 0 ? (
        <p className="small">{t("admin.rulePack.noChanges")}</p>
      ) : (
        <ul className="small">
          {next.changes.map((c) => (
            <li key={c.path}>
              {t("admin.rulePack.change", { path: c.path, from: show(c.from), to: show(c.to) })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

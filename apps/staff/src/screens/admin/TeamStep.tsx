import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { ContactsSettings, Role } from "@west4/shared";
import { api, ApiCallError } from "../../api.js";
import { roleKey, useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { ContactsFields, contactsProblem, useContacts } from "./Contacts.js";
import { InviteForm } from "./Team.js";

/**
 * Set up your venue's step 9, team and contacts (O-11; spec 17 · Step details 9; D115). Invites
 * go through Admin → Team's own form (POST /team/invite, by phone or email); each person confirms
 * their phone and sets their own PIN on their own phone, and the list shows who has. Then the
 * venue's on-call responders and breach contact, the same form as Admin → Venue → Contacts,
 * saved by Continue. The step is done once a manager has set a PIN and both contacts are named.
 */
type Register = (save: (() => Promise<boolean>) | null) => void;
interface Person {
  readonly membership_id: string;
  readonly name: string;
  readonly role: Role;
  readonly status: "invited" | "active" | "deactivated";
  readonly has_pin: boolean;
}

export function TeamStep({
  registerSave,
  onSaved,
}: {
  registerSave: Register;
  onSaved: () => void;
}) {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const contacts = useContacts(venueId);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<ContactsSettings | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const loadTeam = useCallback(async () => {
    try {
      setPeople((await api<{ people: Person[] }>("GET", `/v1/venues/${venueId}/team`)).people);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    if (venueId) void loadTeam();
  }, [venueId, loadTeam]);

  const latest = useRef({ draft, contacts, onSaved, t });
  latest.current = { draft, contacts, onSaved, t };
  useEffect(() => {
    registerSave(async () => {
      const { draft: d, contacts: c, onSaved: saved, t: tr } = latest.current;
      if (!d) return true;
      const problem = contactsProblem(d);
      if (problem) {
        setFormError(tr(problem));
        return false;
      }
      try {
        await c.save(d);
        setDraft(null);
        setFormError(null);
        saved();
        return true;
      } catch (e) {
        setFormError(
          e instanceof ApiCallError && e.code === "invalid_request"
            ? tr("contacts.refused")
            : tr("venue.saveFailed"),
        );
        return false;
      }
    });
    return () => registerSave(null);
  }, [registerSave]);

  if (!venueId) return null;
  if (failed || contacts.failed)
    return (
      <div className="setup-card">
        <div className="error" role="alert">
          <p>{t("shell.error.cantReach")}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void loadTeam();
              void contacts.load();
            }}
          >
            {t("shell.error.retry")}
          </button>
        </div>
      </div>
    );
  const value = draft ?? contacts.saved;
  if (people === null || value === null || contacts.leads === null)
    return (
      <div className="setup-card">
        <p role="status">{t("shell.loading")}</p>
      </div>
    );
  const team = people.filter((p) => p.status !== "deactivated");
  return (
    <div className="setup-card setup-form team-step">
      <InviteForm
        venueId={venueId}
        onSent={async () => {
          await loadTeam();
          onSaved();
        }}
      />
      <section className="setup-fieldset">
        <h3>{t("onboarding.team.people")}</h3>
        {team.length === 0 ? (
          <p className="muted small">{t("onboarding.team.nobody")}</p>
        ) : (
          <ul className="team-step-list">
            {team.map((p) => (
              <li key={p.membership_id}>
                <span>
                  {p.name} · {t(roleKey[p.role])}
                </span>
                <span className={p.has_pin ? "ok small" : "muted small"}>
                  {p.has_pin
                    ? t("onboarding.team.pinSet")
                    : p.status === "invited"
                      ? t("onboarding.team.invited")
                      : t("onboarding.team.noPin")}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link to="/admin/team" className="button secondary">
          {t("onboarding.team.openTeam")}
        </Link>
      </section>
      <section className="setup-fieldset">
        <h3>{t("contacts.title")}</h3>
        <ContactsFields
          value={value}
          leads={contacts.leads}
          onChange={(next) => {
            setDraft(next);
            setFormError(null);
          }}
        />
      </section>
      {formError && (
        <p className="error" role="alert">
          {formError}
        </p>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { CONTACTS_EMPTY, type ContactsSettings, type MessageKey, type Role } from "@west4/shared";
import { api, ApiCallError } from "../../api.js";
import { roleKey, useT } from "../../i18n.js";

/**
 * The venue's own contacts (D115; spec 17 · Step details 9; O-11): the first and second on-call
 * responders our on-call calls when an incident touches this venue, with the days and hours each
 * answers (venue time), and the breach contact and backup who get our breach notice with the
 * owner. Only an active owner or manager can be picked; the server refuses anyone else, and
 * deactivating one empties their slot. The owner's alone: Admin → Venue → Contacts and the
 * wizard's team step both use this form. Our own platform rota is not here.
 */
type OnCall = NonNullable<ContactsSettings["onCall"]["first"]>;
export interface Lead {
  readonly membership_id: string;
  readonly name: string;
  readonly role: string;
}
interface TeamRow extends Lead {
  readonly status: string;
}

const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

/** What's still wrong with the form, or null: an on-call slot needs its days and both times. */
export function contactsProblem(v: ContactsSettings): MessageKey | null {
  for (const slot of [v.onCall.first, v.onCall.second])
    if (slot && (slot.days.length === 0 || !slot.from || !slot.to)) return "contacts.needHours";
  return null;
}

/** Loads the saved contacts and the active owners and managers, and saves the key whole. */
export function useContacts(venueId: string) {
  const [saved, setSaved] = useState<ContactsSettings | null>(null);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      const [contacts, team] = await Promise.all([
        api<{ value: ContactsSettings }>("GET", `/v1/venues/${venueId}/settings/contacts`),
        api<{ people: TeamRow[] }>("GET", `/v1/venues/${venueId}/team`),
      ]);
      setSaved(contacts.value ?? CONTACTS_EMPTY);
      setLeads(
        team.people.filter(
          (p) => p.status === "active" && (p.role === "owner" || p.role === "manager"),
        ),
      );
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);
  /** Saves onCall and breach onto the newest contacts (the booking inbox stays as saved). */
  const save = async (next: ContactsSettings) => {
    const fresh = await api<{ value: ContactsSettings }>(
      "GET",
      `/v1/venues/${venueId}/settings/contacts`,
    );
    const value = { ...(fresh.value ?? CONTACTS_EMPTY), onCall: next.onCall, breach: next.breach };
    await api("PUT", `/v1/venues/${venueId}/settings/contacts`, { value });
    setSaved(value);
  };
  return { saved, leads, failed, load, save };
}

export function ContactsFields({
  value,
  leads,
  onChange,
}: {
  value: ContactsSettings;
  leads: readonly Lead[];
  onChange: (next: ContactsSettings) => void;
}) {
  const { t } = useT();
  const person = (
    label: string,
    id: string | null,
    set: (id: string | null) => void,
    hint?: string,
  ) => (
    <label>
      <span>{label}</span>
      <select value={id ?? ""} aria-label={label} onChange={(e) => set(e.target.value || null)}>
        <option value="">{t("contacts.nobody")}</option>
        {leads.map((l) => (
          <option key={l.membership_id} value={l.membership_id}>
            {l.name} · {t(roleKey[l.role as Role] ?? "contacts.person")}
          </option>
        ))}
        {id && !leads.some((l) => l.membership_id === id) && (
          <option value={id}>{t("contacts.notActive")}</option>
        )}
      </select>
      {hint && <span className="small muted">{hint}</span>}
    </label>
  );
  const onCall = (which: "first" | "second") => {
    const slot = value.onCall[which];
    const label = t(which === "first" ? "contacts.onCall.first" : "contacts.onCall.second");
    const set = (next: OnCall | null) =>
      onChange({ ...value, onCall: { ...value.onCall, [which]: next } });
    return (
      <fieldset className="setup-fieldset contacts-slot">
        <legend>{label}</legend>
        {person(t("contacts.person"), slot?.membershipId ?? null, (id) =>
          set(
            id
              ? {
                  membershipId: id,
                  days: slot?.days ?? [],
                  from: slot?.from ?? "",
                  to: slot?.to ?? "",
                }
              : null,
          ),
        )}
        {slot && (
          <>
            <div
              className="setup-days"
              role="group"
              aria-label={`${label} · ${t("contacts.days")}`}
            >
              {WEEK.map((d) => (
                <label key={d} className="setup-check">
                  <input
                    type="checkbox"
                    checked={slot.days.includes(d)}
                    onChange={(e) =>
                      set({
                        ...slot,
                        days: e.target.checked
                          ? [...slot.days, d].sort()
                          : slot.days.filter((x) => x !== d),
                      })
                    }
                  />
                  {t(`day.${d}` as MessageKey)}
                </label>
              ))}
            </div>
            <label>
              <span>{t("contacts.from")}</span>
              <input
                type="time"
                aria-label={`${label} · ${t("contacts.from")}`}
                value={slot.from}
                onChange={(e) => set({ ...slot, from: e.target.value })}
              />
            </label>
            <label>
              <span>{t("contacts.to")}</span>
              <input
                type="time"
                aria-label={`${label} · ${t("contacts.to")}`}
                value={slot.to}
                onChange={(e) => set({ ...slot, to: e.target.value })}
              />
            </label>
          </>
        )}
      </fieldset>
    );
  };
  return (
    <div className="contacts-fields">
      <p className="muted small">{t("contacts.onCall.hint")}</p>
      {onCall("first")}
      {onCall("second")}
      <fieldset className="setup-fieldset">
        <legend>{t("contacts.breach")}</legend>
        <p className="muted small">{t("contacts.breach.hint")}</p>
        {person(t("contacts.breach.primary"), value.breach.primary, (id) =>
          onChange({ ...value, breach: { ...value.breach, primary: id } }),
        )}
        {person(t("contacts.breach.backup"), value.breach.backup, (id) =>
          onChange({ ...value, breach: { ...value.breach, backup: id } }),
        )}
      </fieldset>
      {leads.length === 0 && <p className="notice small">{t("contacts.noLeads")}</p>}
    </div>
  );
}

/** Admin → Venue → Contacts: the form with its own Save. */
export function VenueContacts({ venueId }: { venueId: string }) {
  const { t } = useT();
  const { saved, leads, failed, load, save } = useContacts(venueId);
  const [draft, setDraft] = useState<ContactsSettings | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const value = draft ?? saved;
  const saving = useRef(false);

  if (failed)
    return (
      <div className="error" role="alert">
        <p>{t("shell.error.cantReach")}</p>
        <button type="button" className="secondary" onClick={() => void load()}>
          {t("shell.error.retry")}
        </button>
      </div>
    );
  if (!value || !leads) return <p role="status">{t("shell.loading")}</p>;
  const submit = async () => {
    if (saving.current) return;
    const problem = contactsProblem(value);
    if (problem) return setMessage({ kind: "error", text: t(problem) });
    saving.current = true;
    setBusy(true);
    try {
      await save(value);
      setDraft(null);
      setMessage({ kind: "ok", text: t("contacts.saved") });
    } catch (e) {
      setMessage({
        kind: "error",
        text:
          e instanceof ApiCallError && e.code === "invalid_request"
            ? t("contacts.refused")
            : t("venue.saveFailed"),
      });
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="venue-contacts">
      <h3>{t("contacts.title")}</h3>
      <ContactsFields value={value} leads={leads} onChange={setDraft} />
      <button
        type="button"
        className="primary"
        disabled={busy || !draft}
        onClick={() => void submit()}
      >
        {t("contacts.save")}
      </button>
      {message && (
        <p
          className={message.kind === "error" ? "error" : "ok"}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

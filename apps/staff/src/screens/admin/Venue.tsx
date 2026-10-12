import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  CONTACTS_EMPTY,
  type ContactsSettings,
  type PhoneSettings,
  type VenueAddress,
} from "@west4/shared";
import { api, ApiCallError } from "../../api.js";
import { useConnection } from "../../connection.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import "./setup.css";

/**
 * Admin → Venue and Set up your venue's step 1 (O-03; spec 17 · Step details 1): the name guests
 * see, the legal name, the street address, the number guests call and the booking inbox (up to 3
 * addresses). The owner's alone. The address confirms New York's rules and time zone and never
 * changes them; one outside New York City is refused with "contact us". Empty is allowed for what
 * the venue hasn't decided; nothing is filled in for it. No EIN field: Stripe's and the texts
 * registration's own forms take it.
 */
interface Profile {
  readonly name: string;
  readonly legal_name: string;
  readonly address: VenueAddress | null;
}

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanPhone = (v: string) => v.replace(/[\s().-]/g, "");

interface Form {
  name: string;
  legalName: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  emails: string[];
}

/** The form; the wizard's step 1 passes `registerSave` so Continue saves it first. */
export function VenueForm({
  registerSave,
  onSaved,
}: {
  registerSave?: (save: (() => Promise<boolean>) | null) => void;
  onSaved?: () => void;
}) {
  const { t } = useT();
  const { state } = useSession();
  const connection = useConnection();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [form, setForm] = useState<Form | null>(null);
  const [base, setBase] = useState<{
    form: Form;
    phone: PhoneSettings | null;
    contacts: ContactsSettings;
  } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const [profile, phone, contacts] = await Promise.all([
      api<{ profile: Profile }>("GET", `/v1/venues/${venueId}/profile`),
      api<{ value: PhoneSettings }>("GET", `/v1/venues/${venueId}/settings/phone`).catch(
        (e: unknown) => {
          if (e instanceof ApiCallError && e.status === 404) return null;
          throw e;
        },
      ),
      api<{ value: ContactsSettings }>("GET", `/v1/venues/${venueId}/settings/contacts`),
    ]);
    const a = profile.profile.address;
    const f: Form = {
      name: profile.profile.name,
      legalName: profile.profile.legal_name,
      line1: a?.line1 ?? "",
      line2: a?.line2 ?? "",
      city: a?.city ?? "",
      state: a?.state ?? "",
      zip: a?.postal_code ?? "",
      phone: phone?.value.callNumber ?? "",
      emails: [...contacts.value.bookingEmails],
    };
    setBase({ form: f, phone: phone?.value ?? null, contacts: contacts.value ?? CONTACTS_EMPTY });
    setForm(f);
    setLoadError(false);
  }, [venueId]);

  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setLoadError(true));
  }, [venueId, load]);

  const addressParts = form ? [form.line1, form.city, form.state, form.zip] : [];
  const addressEmpty = addressParts.every((p) => p.trim() === "") && !form?.line2.trim();
  const addressPartial = !addressEmpty && addressParts.some((p) => p.trim() === "");
  const phoneOk = !form || form.phone.trim() === "" || E164.test(cleanPhone(form.phone));
  const emailsOk = !form || form.emails.every((e) => e.trim() === "" || EMAIL.test(e.trim()));
  const valid =
    !!form &&
    form.name.trim() !== "" &&
    form.legalName.trim() !== "" &&
    !addressPartial &&
    phoneOk &&
    emailsOk;

  // The latest save, for the wizard's Continue: true when saved (or nothing changed).
  const saveRef = useRef<() => Promise<boolean>>(async () => true);
  saveRef.current = async () => {
    if (!form || !base) return true;
    if (!valid) {
      setMessage({ kind: "error", text: t("venue.saveFailed") });
      return false;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api("PUT", `/v1/venues/${venueId}/profile`, {
        name: form.name.trim(),
        legal_name: form.legalName.trim(),
        address: addressEmpty
          ? null
          : {
              line1: form.line1.trim(),
              line2: form.line2.trim() || null,
              city: form.city.trim(),
              state: form.state.trim().toUpperCase(),
              postal_code: form.zip.trim(),
            },
      });
      const phone = cleanPhone(form.phone);
      if (phone !== "" && phone !== base.phone?.callNumber)
        await api("PUT", `/v1/venues/${venueId}/settings/phone`, {
          value: { callNumber: phone, textNumber: base.phone?.textNumber ?? null },
        });
      const emails = form.emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
      if (emails.join(",") !== base.contacts.bookingEmails.join(","))
        await api("PUT", `/v1/venues/${venueId}/settings/contacts`, {
          value: { ...base.contacts, bookingEmails: emails },
        });
      await load();
      setMessage({ kind: "ok", text: t("venue.saved") });
      onSaved?.();
      return true;
    } catch (e) {
      const outside =
        e instanceof ApiCallError &&
        (e.details as { reason?: string }).reason === "outside_new_york";
      setMessage({
        kind: "error",
        text: outside
          ? t("venue.outsideNewYork")
          : `${t("venue.saveFailed")} · ${e instanceof Error ? e.message : String(e)}`,
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    registerSave?.(() => saveRef.current());
    return () => registerSave?.(null);
  }, [registerSave]);

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void saveRef.current();
  };

  if (loadError)
    return (
      <div className="error" role="alert">
        <p>{t("shell.error.cantReach")}</p>
        <button
          type="button"
          className="secondary"
          onClick={() => void load().catch(() => setLoadError(true))}
        >
          {t("shell.error.retry")}
        </button>
      </div>
    );
  if (!form) return <p role="status">{t("shell.loading")}</p>;

  const text = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    extra: {
      hint?: string;
      invalid?: boolean;
      error?: string;
      type?: string;
      autoComplete?: string;
    } = {},
  ) => (
    <label>
      <span>{label}</span>
      <input
        type={extra.type ?? "text"}
        value={value}
        aria-invalid={extra.invalid || undefined}
        autoComplete={extra.autoComplete}
        placeholder={t("venue.notSet")}
        onChange={(e) => onChange(e.target.value)}
      />
      {extra.hint && <span className="small muted">{extra.hint}</span>}
      {extra.invalid && extra.error && <span className="small error">{extra.error}</span>}
    </label>
  );

  return (
    <form className="venue-form" onSubmit={submit}>
      {connection.kind === "offline" && (
        <p className="notice" role="status">
          {t("shell.offline")}
        </p>
      )}
      {text(t("venue.name"), form.name, (v) => set({ name: v }), {
        invalid: form.name.trim() === "",
        autoComplete: "organization",
      })}
      {text(t("venue.legalName"), form.legalName, (v) => set({ legalName: v }), {
        hint: t("venue.legalNameHint"),
        invalid: form.legalName.trim() === "",
      })}
      <fieldset>
        <legend>{t("venue.address")}</legend>
        {text(t("venue.line1"), form.line1, (v) => set({ line1: v }), {
          autoComplete: "address-line1",
        })}
        {text(t("venue.line2"), form.line2, (v) => set({ line2: v }), {
          autoComplete: "address-line2",
        })}
        <div className="venue-row">
          {text(t("venue.city"), form.city, (v) => set({ city: v }), {
            autoComplete: "address-level2",
          })}
          {text(t("venue.state"), form.state, (v) => set({ state: v.toUpperCase().slice(0, 2) }), {
            autoComplete: "address-level1",
          })}
          {text(t("venue.zip"), form.zip, (v) => set({ zip: v }), { autoComplete: "postal-code" })}
        </div>
        <span className="small muted">{t("venue.addressHint")}</span>
        {addressPartial && <span className="small error">{t("venue.addressPartial")}</span>}
      </fieldset>
      {text(t("venue.guestPhone"), form.phone, (v) => set({ phone: v }), {
        type: "tel",
        hint: t("venue.guestPhoneHint"),
        invalid: !phoneOk,
        error: t("phone.invalid"),
        autoComplete: "tel",
      })}
      <fieldset>
        <legend>{t("venue.bookingInbox")}</legend>
        <span className="small muted">{t("venue.bookingInboxHint")}</span>
        {form.emails.map((email, i) => (
          <div className="venue-email" key={i}>
            {text(
              t("venue.bookingEmail", { n: i + 1 }),
              email,
              (v) => set({ emails: form.emails.map((x, j) => (j === i ? v : x)) }),
              {
                type: "email",
                invalid: email.trim() !== "" && !EMAIL.test(email.trim()),
                error: t("venue.invalidEmail"),
              },
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => set({ emails: form.emails.filter((_, j) => j !== i) })}
            >
              {t("venue.removeEmail")}
            </button>
          </div>
        ))}
        {form.emails.length < 3 && (
          <button
            type="button"
            className="secondary"
            onClick={() => set({ emails: [...form.emails, ""] })}
          >
            {t("venue.addEmail")}
          </button>
        )}
      </fieldset>
      {message && (
        <p
          className={message.kind === "error" ? "error" : "ok"}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}
      {!registerSave && (
        <button type="submit" className="primary" disabled={busy || !valid}>
          {busy ? t("venue.saving") : t("venue.save")}
        </button>
      )}
    </form>
  );
}

/** Admin → Venue. */
export function Venue() {
  const { t } = useT();
  return (
    <section className="venue">
      <h2>{t("admin.section.venue")}</h2>
      <VenueForm />
    </section>
  );
}

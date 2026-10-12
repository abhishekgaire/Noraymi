import { useCallback, useEffect, useState } from "react";
import { FILE_RULES, type MessageKey } from "@west4/shared";
import { api, ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { uploadPhoto } from "../../upload.js";

/**
 * Set up your venue's step 11 (O-12; spec 17 · Step details 11), all optional. Texts: once our
 * team has made the venue's subaccount and number, the 10DLC form (the legal name and address
 * come from step 1; the EIN is typed here, sent to Twilio once and never kept) and Register for
 * texts; the status then follows the campaign check. Website: "Do you have a website and domain to
 * move?", a yes starting the move with our team. Your old system: its export files, for our team
 * to run through the importer as a dry run you sign; nothing is read on upload.
 */
interface Registration {
  state: "sending" | "submitted" | "failed";
  submitted_at: string | null;
  created_at: string;
}
interface Request {
  id: string;
  kind: "website" | "old_system" | "menu";
  answer: "yes" | "no" | null;
  note: string | null;
  state: "open" | "done";
  requested_at: string;
}
interface Answer {
  subaccount: boolean;
  number: string | null;
  campaign: "not_registered" | "pending" | "approved" | "rejected";
  legal_name: string;
  address: { line1: string; city: string; state: string; postal_code: string } | null;
  registration: Registration | null;
  requests: Request[];
}

const TYPES = [
  ["Limited Liability Corporation", "texts.reg.type.llc"],
  ["Corporation", "texts.reg.type.corporation"],
  ["Partnership", "texts.reg.type.partnership"],
  ["Sole Proprietorship", "texts.reg.type.sole"],
  ["Non-profit Corporation", "texts.reg.type.nonprofit"],
  ["Co-operative", "texts.reg.type.coop"],
] as const;
const POSITIONS = [
  ["GM", "texts.reg.position.gm"],
  ["CEO", "texts.reg.position.ceo"],
  ["CFO", "texts.reg.position.cfo"],
  ["VP", "texts.reg.position.vp"],
  ["Director", "texts.reg.position.director"],
  ["General Counsel", "texts.reg.position.counsel"],
  ["Other", "texts.reg.position.other"],
] as const;

const usE164 = (typed: string): string | null => {
  const digits = typed.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{9}$/.test(ten) ? `+1${ten}` : null;
};
const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA");

export function TextsStep({ onSaved }: { onSaved: () => void }) {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const isOwner = state.status === "signedIn" && state.membership.role === "owner";
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setAnswer(await api<Answer>("GET", `/v1/venues/${venueId}/setup/texts`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    if (venueId) void load();
  }, [venueId, load]);
  const reload = () => {
    void load();
    onSaved();
  };

  if (failed)
    return (
      <div className="setup-card">
        <div className="error" role="alert">
          <p>{t("shell.error.cantReach")}</p>
          <button type="button" className="secondary" onClick={() => void load()}>
            {t("shell.error.retry")}
          </button>
        </div>
      </div>
    );
  if (!answer)
    return (
      <div className="setup-card">
        <p role="status">{t("shell.loading")}</p>
      </div>
    );
  return (
    <div className="setup-card setup-form texts-step">
      <p className="muted small">{t("onboarding.texts.intro")}</p>
      <TextsSection venueId={venueId} answer={answer} isOwner={isOwner} onDone={reload} />
      <WebsiteSection venueId={venueId} requests={answer.requests} onDone={reload} />
      <OldSystemSection venueId={venueId} requests={answer.requests} onDone={reload} />
    </div>
  );
}

function TextsSection({
  venueId,
  answer,
  isOwner,
  onDone,
}: {
  venueId: string;
  answer: Answer;
  isOwner: boolean;
  onDone: () => void;
}) {
  const { t, date } = useT();
  const [form, setForm] = useState({
    ein: "",
    type: "",
    website: "",
    first: "",
    last: "",
    email: "",
    phone: "",
    title: "",
    position: "",
    sample1: "",
    sample2: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const reg = answer.registration;

  const submit = async () => {
    const phone = usE164(form.phone);
    const filled =
      /^\d{2}-?\d{7}$/.test(form.ein.trim()) &&
      form.type &&
      /^https?:\/\/\S+\.\S+/.test(form.website.trim()) &&
      form.first.trim() &&
      form.last.trim() &&
      form.email.includes("@") &&
      phone &&
      form.title.trim() &&
      form.position &&
      form.sample1.trim().length >= 20 &&
      form.sample2.trim().length >= 20;
    if (!filled) return setError(t("onboarding.texts.incomplete"));
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/setup/texts/register`, {
        ein: form.ein.trim(),
        business_type: form.type,
        website_url: form.website.trim(),
        rep: {
          first_name: form.first.trim(),
          last_name: form.last.trim(),
          email: form.email.trim(),
          phone_e164: phone,
          title: form.title.trim(),
          position: form.position,
        },
        samples: [form.sample1.trim(), form.sample2.trim()],
      });
      // The EIN leaves the page as soon as it's sent.
      setForm((f) => ({ ...f, ein: "" }));
      onDone();
    } catch (e) {
      setForm((f) => ({ ...f, ein: "" }));
      setError(
        e instanceof ApiCallError && e.status === 502
          ? t("onboarding.texts.twilioFailed")
          : t("onboarding.texts.failed"),
      );
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const field = (
    label: string,
    k: keyof typeof form,
    extra: { type?: string; inputMode?: "numeric" | "tel" | "email" | "url"; hint?: string } = {},
  ) => (
    <label>
      <span>{label}</span>
      <input
        type={extra.type ?? "text"}
        inputMode={extra.inputMode}
        autoComplete="off"
        aria-label={label}
        value={form[k]}
        onChange={(e) => set(k)(e.target.value)}
      />
      {extra.hint && <span className="small muted">{extra.hint}</span>}
    </label>
  );

  return (
    <section className="setup-fieldset">
      <h3>{t("onboarding.texts.title")}</h3>
      {!answer.subaccount ? (
        <p className="notice small" role="status">
          {t("onboarding.texts.settingUp")}
        </p>
      ) : reg && reg.state !== "failed" ? (
        <p className="ok small" role="status">
          {t("onboarding.texts.sent", {
            date: date(day(reg.submitted_at ?? reg.created_at)),
            status: t(`phone.campaign.${answer.campaign}` as MessageKey),
          })}
        </p>
      ) : !isOwner ? (
        <p className="muted small">{t("onboarding.texts.ownerOnly")}</p>
      ) : (
        <>
          <p className="muted small">
            {t("onboarding.texts.from", {
              name: answer.legal_name,
              address: answer.address
                ? `${answer.address.line1}, ${answer.address.city}, ${answer.address.state} ${answer.address.postal_code}`
                : t("onboarding.texts.noAddress"),
            })}
          </p>
          {reg?.state === "failed" && (
            <p className="error small" role="alert">
              {t("onboarding.texts.twilioFailed")}
            </p>
          )}
          {field(t("onboarding.texts.ein"), "ein", {
            inputMode: "numeric",
            hint: t("onboarding.texts.ein.hint"),
          })}
          <label>
            <span>{t("onboarding.texts.type")}</span>
            <select
              aria-label={t("onboarding.texts.type")}
              value={form.type}
              onChange={(e) => set("type")(e.target.value)}
            >
              <option value="">{t("onboarding.texts.choose")}</option>
              {TYPES.map(([v, k]) => (
                <option key={v} value={v}>
                  {t(k)}
                </option>
              ))}
            </select>
          </label>
          {field(t("onboarding.texts.website"), "website", { type: "url", inputMode: "url" })}
          <h4>{t("onboarding.texts.rep")}</h4>
          {field(t("onboarding.texts.rep.first"), "first")}
          {field(t("onboarding.texts.rep.last"), "last")}
          {field(t("onboarding.texts.rep.email"), "email", { type: "email", inputMode: "email" })}
          {field(t("onboarding.texts.rep.phone"), "phone", { type: "tel", inputMode: "tel" })}
          {field(t("onboarding.texts.rep.title"), "title")}
          <label>
            <span>{t("onboarding.texts.rep.position")}</span>
            <select
              aria-label={t("onboarding.texts.rep.position")}
              value={form.position}
              onChange={(e) => set("position")(e.target.value)}
            >
              <option value="">{t("onboarding.texts.choose")}</option>
              {POSITIONS.map(([v, k]) => (
                <option key={v} value={v}>
                  {t(k)}
                </option>
              ))}
            </select>
          </label>
          <h4>{t("onboarding.texts.samples")}</h4>
          <p className="muted small">{t("onboarding.texts.samples.hint")}</p>
          {(["sample1", "sample2"] as const).map((k, i) => (
            <label key={k}>
              <span>{t("onboarding.texts.sample", { n: i + 1 })}</span>
              <textarea
                rows={2}
                maxLength={1024}
                aria-label={t("onboarding.texts.sample", { n: i + 1 })}
                value={form[k]}
                onChange={(e) => set(k)(e.target.value)}
              />
            </label>
          ))}
          <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? t("onboarding.texts.sending") : t("onboarding.texts.register")}
          </button>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function WebsiteSection({
  venueId,
  requests,
  onDone,
}: {
  venueId: string;
  requests: Request[];
  onDone: () => void;
}) {
  const { t, date } = useT();
  const last = requests.find((r) => r.kind === "website");
  const [choice, setChoice] = useState<"yes" | "no" | null>(null);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/setup/website`, {
        answer: choice,
        ...(choice === "yes" && domain.trim() ? { domain: domain.trim() } : {}),
      });
      setChoice(null);
      setDomain("");
      onDone();
    } catch {
      setError(t("shell.error.cantReach"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="setup-fieldset">
      <h3>{t("onboarding.website.title")}</h3>
      <p className="muted small">{t("onboarding.website.hint")}</p>
      {last && (
        <p className="ok small" role="status">
          {last.answer === "yes"
            ? t("onboarding.website.yes", {
                date: date(day(last.requested_at)),
                domain: last.note ?? "",
              })
            : t("onboarding.website.no", { date: date(day(last.requested_at)) })}
        </p>
      )}
      <fieldset className="setup-days" aria-label={t("onboarding.website.question")}>
        <legend>{t("onboarding.website.question")}</legend>
        <label className="setup-check">
          <input
            type="radio"
            name="setupWebsite"
            checked={choice === "yes"}
            onChange={() => setChoice("yes")}
          />
          {t("onboarding.website.answerYes")}
        </label>
        <label className="setup-check">
          <input
            type="radio"
            name="setupWebsite"
            checked={choice === "no"}
            onChange={() => setChoice("no")}
          />
          {t("onboarding.website.answerNo")}
        </label>
      </fieldset>
      {choice === "yes" && (
        <label>
          <span>{t("onboarding.website.domain")}</span>
          <input
            aria-label={t("onboarding.website.domain")}
            value={domain}
            maxLength={253}
            onChange={(e) => setDomain(e.target.value)}
          />
        </label>
      )}
      <button type="button" disabled={!choice || busy} onClick={() => void save()}>
        {t("onboarding.website.save")}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function OldSystemSection({
  venueId,
  requests,
  onDone,
}: {
  venueId: string;
  requests: Request[];
  onDone: () => void;
}) {
  const { t, date } = useT();
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const sent = requests.filter((r) => r.kind === "old_system");
  const rule = FILE_RULES.import_export;
  const send = async () => {
    if (files.some((f) => !rule.types.includes(f.type) || f.size > rule.maxBytes))
      return setError(t("onboarding.oldSystem.wrongFile"));
    setBusy(true);
    setError(null);
    try {
      for (const f of files) {
        const fileId = await uploadPhoto(venueId, "import_export", f);
        await api("POST", `/v1/venues/${venueId}/setup/requests`, {
          kind: "old_system",
          file_id: fileId,
          note: [f.name, note.trim()].filter(Boolean).join(" · ").slice(0, 500),
        });
      }
      setFiles([]);
      setNote("");
      setInputKey((k) => k + 1);
      onDone();
    } catch {
      setError(t("shell.error.cantReach"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="setup-fieldset">
      <h3>{t("onboarding.oldSystem.title")}</h3>
      <p className="muted small">{t("onboarding.oldSystem.hint")}</p>
      <label>
        <span>{t("onboarding.oldSystem.files")}</span>
        <input
          key={inputKey}
          type="file"
          multiple
          accept=".csv,.json,.xls,.xlsx,.zip,.pdf"
          aria-label={t("onboarding.oldSystem.files")}
          onChange={(e) => setFiles([...(e.target.files ?? [])])}
        />
      </label>
      <label>
        <span>{t("onboarding.oldSystem.note")}</span>
        <textarea
          rows={2}
          maxLength={400}
          aria-label={t("onboarding.oldSystem.note")}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button type="button" disabled={files.length === 0 || busy} onClick={() => void send()}>
        {busy ? t("onboarding.menu.send.sending") : t("onboarding.oldSystem.send")}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {sent.length > 0 && (
        <ul className="menu-requests">
          {sent.map((r) => (
            <li key={r.id}>
              {t(r.state === "open" ? "onboarding.oldSystem.open" : "onboarding.oldSystem.done", {
                date: date(day(r.requested_at)),
              })}
              {r.note && <span className="muted small"> · {r.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

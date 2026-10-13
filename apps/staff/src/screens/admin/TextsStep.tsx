import { useCallback, useEffect, useState } from "react";
import { FILE_RULES } from "@west4/shared";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { uploadPhoto } from "../../upload.js";
import { TwilioConnect } from "./TwilioConnect.js";

/**
 * Set up your venue's step 11 (O-12, T-02; spec 17 · Step details 11), all optional. Texts: the
 * venue's own Twilio account, connected with the same panel as Admin → Phone & texts (D123); the
 * brand and campaign are registered in Twilio's own console, so nothing here asks for an EIN. Website: "Do you have a website and domain to
 * move?", a yes starting the move with our team. Your old system: its export files, for our team
 * to run through the importer as a dry run you sign; nothing is read on upload.
 */
interface Request {
  id: string;
  kind: "website" | "old_system" | "menu";
  answer: "yes" | "no" | null;
  note: string | null;
  state: "open" | "done";
  requested_at: string;
}
interface Answer {
  requests: Request[];
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA");

export function TextsStep({ onSaved }: { onSaved: () => void }) {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
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
      <TwilioConnect venueId={venueId} onChange={onSaved} />
      <WebsiteSection venueId={venueId} requests={answer.requests} onDone={reload} />
      <OldSystemSection venueId={venueId} requests={answer.requests} onDone={reload} />
    </div>
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

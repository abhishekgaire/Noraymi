import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { cents, FILE_RULES, type KitchenSettings, type MessageKey } from "@west4/shared";
import { AdminDraftProvider, useAdminDraft } from "../../admin/draft.js";
import { api, ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { uploadPhoto } from "../../upload.js";
import { AllergyNotice } from "./Kitchen.js";

/**
 * Set up your venue's step 8, the menu (O-10; spec 17 · Step details 8). Three ways in, all
 * through the menu API: typing items in Admin → Menu's own editor (linked, not copied); a
 * spreadsheet in the importer's menu format, checked as a dry run the owner reads before
 * "Looks right" saves it; or a PDF or photo for our team to type in (a request in our Console;
 * nothing is read from it automatically). The open points the file couldn't settle are listed
 * for the owner to answer on the item, and the allergy notice (Admin → Kitchen's own field) shows
 * when the Kitchen module is allowed. The step is done once one item has a price.
 */
type Register = (save: (() => Promise<boolean>) | null) => void;

interface OpenPoint {
  kind: "extra_price" | "included_choice" | "draft" | "pour";
  item: string;
  group: string | null;
}
interface SheetReport {
  mode: "dry_run" | "live";
  menu_lines: number;
  new_lines: number;
  already: number;
  changed: number;
  choices: number;
  packages: number;
  cents_in_files: number;
  open_points: OpenPoint[];
  not_on_grid: string[];
  layout_skipped: string | null;
}
interface SetupRequest {
  id: string;
  state: "open" | "done";
  note: string | null;
  requested_at: string;
}
interface Loaded {
  openPoints: OpenPoint[];
  requests: SetupRequest[];
  kitchen: KitchenSettings | null;
}

const problemsOf = (e: unknown): string[] | null => {
  const details = (e as ApiCallError)?.details as { problems?: unknown } | undefined;
  return Array.isArray(details?.problems) ? (details.problems as string[]) : null;
};

export function MenuStep({
  registerSave,
  onSaved,
}: {
  registerSave: Register;
  onSaved: () => void;
}) {
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  if (!venueId) return null;
  return (
    <AdminDraftProvider venueId={venueId}>
      <MenuStepBody venueId={venueId} registerSave={registerSave} onSaved={onSaved} />
    </AdminDraftProvider>
  );
}

function MenuStepBody({
  venueId,
  registerSave,
  onSaved,
}: {
  venueId: string;
  registerSave: Register;
  onSaved: () => void;
}) {
  const { t } = useT();
  const draft = useAdminDraft();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(onSaved);
  saved.current = onSaved;

  const load = useCallback(async () => {
    try {
      const [step, modules, kitchen] = await Promise.all([
        api<{ open_points: OpenPoint[]; requests: SetupRequest[] }>(
          "GET",
          `/v1/venues/${venueId}/setup/menu`,
        ),
        api<{ modules: { id: string; allowed: boolean }[] }>(
          "GET",
          `/v1/venues/${venueId}/modules`,
        ),
        api<{ value: KitchenSettings }>("GET", `/v1/venues/${venueId}/settings/kitchen`),
      ]);
      const kitchenAllowed = modules.modules.some((m) => m.id === "kitchen" && m.allowed);
      setLoaded({
        openPoints: step.open_points,
        requests: step.requests,
        kitchen: kitchenAllowed ? kitchen.value : null,
      });
      setError(null);
    } catch {
      setError(t("shell.error.cantReach"));
    }
  }, [venueId, t]);
  useEffect(() => {
    void load();
  }, [load, draft.version]);

  // Continue saves the allergy notice when it was typed; the menu itself saves as it goes.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    registerSave(async () => {
      if (!draftRef.current.dirty) return true;
      const ok = await draftRef.current.save();
      if (ok) saved.current();
      return ok;
    });
    return () => registerSave(null);
  }, [registerSave]);

  if (error && loaded === null)
    return (
      <div className="setup-card">
        <div className="error" role="alert">
          <p>{error}</p>
          <button type="button" className="secondary" onClick={() => void load()}>
            {t("shell.error.retry")}
          </button>
        </div>
      </div>
    );
  if (loaded === null)
    return (
      <div className="setup-card">
        <p role="status">{t("shell.loading")}</p>
      </div>
    );
  const kitchen = (draft.values["kitchen"] as KitchenSettings | undefined) ?? loaded.kitchen;
  return (
    <div className="setup-card setup-form menu-step">
      <p className="muted small">{t("onboarding.menu.intro")}</p>

      <section className="setup-fieldset">
        <h3>{t("onboarding.menu.byHand")}</h3>
        <p className="muted small">{t("onboarding.menu.byHand.hint")}</p>
        <Link to="/admin/menu" className="button secondary">
          {t("onboarding.menu.openMenu")}
        </Link>
      </section>

      <SheetUpload
        venueId={venueId}
        onSaved={() => {
          saved.current();
          void load();
        }}
      />

      <SendToUs venueId={venueId} requests={loaded.requests} onSent={() => void load()} />

      {loaded.openPoints.length > 0 && (
        <section className="setup-fieldset">
          <h3>{t("onboarding.menu.openPoints")}</h3>
          <p className="muted small">{t("onboarding.menu.openPoints.hint")}</p>
          <OpenPoints points={loaded.openPoints} />
          <Link to="/admin/menu" className="button secondary">
            {t("onboarding.menu.openMenu")}
          </Link>
        </section>
      )}

      {kitchen && (
        <section className="setup-fieldset">
          <h3>{t("onboarding.menu.allergy")}</h3>
          <p className="muted small">{t("onboarding.menu.allergy.hint")}</p>
          <AllergyNotice
            key={draft.version}
            current={kitchen}
            onChange={(next) => draft.set("kitchen", next)}
          />
        </section>
      )}
      {draft.error && (
        <p className="error" role="alert">
          {draft.error === "admin_read_only" ? t("plan.refused") : draft.error}
        </p>
      )}
    </div>
  );
}

function OpenPoints({ points }: { points: OpenPoint[] }) {
  const { t } = useT();
  return (
    <ul className="menu-open-points">
      {points.map((p) => (
        <li key={`${p.kind}|${p.item}|${p.group ?? ""}`}>
          {t(`onboarding.menu.point.${p.kind}` as MessageKey, {
            item: p.item,
            group: p.group ?? "",
          })}
        </li>
      ))}
    </ul>
  );
}

/** The spreadsheet path: read the files, the importer's dry run, then Looks right saves. */
function SheetUpload({ venueId, onSaved }: { venueId: string; onSaved: () => void }) {
  const { t, money } = useT();
  const [files, setFiles] = useState<{ name: string; text: string }[] | null>(null);
  const [report, setReport] = useState<SheetReport | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [savedLines, setSavedLines] = useState<number | null>(null);
  const [inputKey, setInputKey] = useState(0);

  const choose = async (list: FileList | null) => {
    setReport(null);
    setProblems(null);
    setFailed(null);
    setSavedLines(null);
    if (!list || list.length === 0) return setFiles(null);
    setFiles(
      await Promise.all([...list].map(async (f) => ({ name: f.name, text: await f.text() }))),
    );
  };

  const run = async (save: boolean) => {
    if (!files) return;
    setBusy(save ? "save" : "check");
    setProblems(null);
    setFailed(null);
    try {
      const r = await api<SheetReport>("POST", `/v1/venues/${venueId}/setup/menu-sheet`, {
        files,
        save,
      });
      if (save) {
        setSavedLines(r.new_lines);
        setReport(null);
        setFiles(null);
        setInputKey((k) => k + 1);
        onSaved();
      } else setReport(r);
    } catch (e) {
      setReport(null);
      const listed = problemsOf(e);
      if (listed) setProblems(listed);
      else setFailed(e instanceof ApiCallError ? e.message : t("shell.error.cantReach"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="setup-fieldset">
      <h3>{t("onboarding.menu.sheet")}</h3>
      <p className="muted small">{t("onboarding.menu.sheet.hint")}</p>
      <label>
        <span>{t("onboarding.menu.sheet.files")}</span>
        <input
          key={inputKey}
          type="file"
          multiple
          accept=".csv,.json,text/csv,application/json"
          aria-label={t("onboarding.menu.sheet.files")}
          onChange={(e) => void choose(e.target.files)}
        />
      </label>
      {files && !report && (
        <button type="button" disabled={busy !== null} onClick={() => void run(false)}>
          {busy === "check"
            ? t("onboarding.menu.sheet.checking")
            : t("onboarding.menu.sheet.check")}
        </button>
      )}
      {report && (
        <div className="menu-sheet-report" role="status">
          <p>
            {t("onboarding.menu.sheet.found", {
              lines: report.menu_lines,
              money: money(cents(report.cents_in_files)),
              choices: report.choices,
              packages: report.packages,
            })}
          </p>
          {report.already > 0 && (
            <p className="muted small">
              {t("onboarding.menu.sheet.already", { n: report.already })}
            </p>
          )}
          {report.changed > 0 && (
            <p className="notice small">
              {t("onboarding.menu.sheet.changed", { n: report.changed })}
            </p>
          )}
          {report.not_on_grid.length > 0 && (
            <p className="notice small">
              {t("onboarding.menu.sheet.notOnGrid", { items: report.not_on_grid.join(", ") })}
            </p>
          )}
          {report.layout_skipped !== null && (
            <p className="notice small">{t("onboarding.menu.sheet.layoutSkipped")}</p>
          )}
          {report.open_points.length > 0 && (
            <>
              <h4>{t("onboarding.menu.openPoints")}</h4>
              <OpenPoints points={report.open_points} />
            </>
          )}
          <div className="menu-sheet-actions">
            <button type="button" disabled={busy !== null} onClick={() => void run(true)}>
              {busy === "save"
                ? t("onboarding.menu.sheet.saving")
                : t("onboarding.menu.sheet.looksRight")}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy !== null}
              onClick={() => {
                setReport(null);
                setFiles(null);
                setInputKey((k) => k + 1);
              }}
            >
              {t("onboarding.menu.sheet.startOver")}
            </button>
          </div>
        </div>
      )}
      {problems && (
        <div className="error" role="alert">
          <p>{t("onboarding.menu.sheet.problems")}</p>
          <ul>
            {problems.slice(0, 20).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {failed && (
        <p className="error" role="alert">
          {failed}
        </p>
      )}
      {savedLines !== null && (
        <p className="ok" role="status">
          {t("onboarding.menu.sheet.saved", { n: savedLines })}
        </p>
      )}
    </section>
  );
}

/** A PDF or a photo for our team: uploaded straight to storage, then a request in our Console. */
function SendToUs({
  venueId,
  requests,
  onSent,
}: {
  venueId: string;
  requests: SetupRequest[];
  onSent: () => void;
}) {
  const { t, date } = useT();
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const rule = FILE_RULES.menu_source;

  const send = async () => {
    if (!file) return;
    if (!rule.types.includes(file.type) || file.size > rule.maxBytes) {
      setFailed(t("onboarding.menu.send.wrongFile"));
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      const fileId = await uploadPhoto(venueId, "menu_source", file);
      await api("POST", `/v1/venues/${venueId}/setup/requests`, {
        kind: "menu",
        file_id: fileId,
        note: note.trim() || null,
      });
      setFile(null);
      setNote("");
      setInputKey((k) => k + 1);
      onSent();
    } catch {
      setFailed(t("shell.error.cantReach"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="setup-fieldset">
      <h3>{t("onboarding.menu.send")}</h3>
      <p className="muted small">{t("onboarding.menu.send.hint")}</p>
      <label>
        <span>{t("onboarding.menu.send.file")}</span>
        <input
          key={inputKey}
          type="file"
          accept=".pdf,image/jpeg,image/png,image/heic,application/pdf"
          aria-label={t("onboarding.menu.send.file")}
          onChange={(e) => {
            setFailed(null);
            setFile(e.target.files?.[0] ?? null);
          }}
        />
      </label>
      <label>
        <span>{t("onboarding.menu.send.note")}</span>
        <textarea
          rows={2}
          maxLength={500}
          aria-label={t("onboarding.menu.send.note")}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button type="button" disabled={!file || busy} onClick={() => void send()}>
        {busy ? t("onboarding.menu.send.sending") : t("onboarding.menu.send.submit")}
      </button>
      {failed && (
        <p className="error" role="alert">
          {failed}
        </p>
      )}
      {requests.length > 0 && (
        <ul className="menu-requests">
          {requests.map((r) => (
            <li key={r.id}>
              {t(
                r.state === "open"
                  ? "onboarding.menu.request.open"
                  : "onboarding.menu.request.done",
                { date: date(new Date(r.requested_at).toLocaleDateString("en-CA")) },
              )}
              {r.note && <span className="muted small"> · {r.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

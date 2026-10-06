import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FILE_RULES, type MessageKey } from "@west4/shared";
import { api, ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { BarModeSettings } from "./BarModeSettings.js";

/**
 * Admin → Bar mode (M6-23; screens N34; Song systems and texts · Songbook; D63): the songbook upload.
 * A CSV of title, artist and code goes straight to storage through POST /files, then POST
 * /songbook/uploads checks every row: all pass and it replaces the last upload; otherwise nothing
 * loads and each failing line is listed. The `barMode` settings (M6-26) come first, in BarModeSettings.
 */
interface Summary {
  readonly songs: number;
  readonly loaded_at: string | null;
}
interface RowError {
  readonly line: number;
  readonly problem: string;
}

export function BarMode() {
  const { t, tn, date } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const timeZone = state.status === "signedIn" ? state.membership.venue.time_zone : "UTC";
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [rows, setRows] = useState<{ errors: RowError[]; count: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setSummary(await api<Summary>("GET", `/v1/venues/${venueId}/songbook`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    if (venueId) void load();
  }, [venueId, load]);

  const problemText = (p: string) => t(`barMode.songbook.problem.${p}` as MessageKey);
  const loadedOn = (at: string) => date(new Date(at).toLocaleDateString("en-CA", { timeZone }));

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setNote(null);
    setProblem(null);
    setRows(null);
    if (file.size > FILE_RULES.songbook.maxBytes || file.size === 0) {
      setProblem(t("barMode.songbook.tooBig"));
      return;
    }
    setBusy(true);
    try {
      // A spreadsheet's .csv can come with another type (Windows says application/vnd.ms-excel); the
      // file is checked row by row on the server, so it goes as text/csv.
      const presigned = await api<{
        file_id: string;
        upload: { url: string; fields: Record<string, string> };
      }>("POST", `/v1/venues/${venueId}/files`, {
        kind: "songbook",
        content_type: "text/csv",
        bytes: file.size,
      });
      const form = new FormData();
      for (const [k, v] of Object.entries(presigned.upload.fields)) form.append(k, v);
      form.append("file", file);
      const sent = await fetch(presigned.upload.url, { method: "POST", body: form });
      if (!sent.ok)
        throw new ApiCallError(sent.status, "not_uploaded", "", { reason: "not_uploaded" });
      const loaded = await api<{ songs: number }>(
        "POST",
        `/v1/venues/${venueId}/songbook/uploads`,
        { file_id: presigned.file_id },
      );
      setNote(tn("barMode.songbook.loaded", loaded.songs));
      setFile(null);
      await load();
    } catch (err) {
      const details = err instanceof ApiCallError ? err.details : {};
      if (details["reason"] === "rows") {
        const errors = (details["errors"] as RowError[] | undefined) ?? [];
        const whole = errors.find((r) => r.line === 0);
        if (whole) setProblem(problemText(whole.problem));
        else setRows({ errors, count: Number(details["count"] ?? errors.length) });
      } else if (details["reason"] === "not_uploaded")
        setProblem(t("barMode.songbook.notUploaded"));
      else setProblem(t("shell.error.cantReach"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bar-mode">
      <h2>{t("admin.section.barMode")}</h2>
      <p className="small muted">{t("barMode.settings.now")}</p>
      {venueId && <BarModeSettings venueId={venueId} />}
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {summary === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          <h3>{t("barMode.songbook")}</h3>
          <p>
            {summary.songs > 0 && summary.loaded_at
              ? tn("barMode.songbook.current", summary.songs, { date: loadedOn(summary.loaded_at) })
              : t("barMode.songbook.none")}
          </p>
          <p className="small muted">{t("barMode.songbook.lead")}</p>
          <form onSubmit={(e) => void upload(e)}>
            <label>
              <span>{t("barMode.songbook.file")}</span>
              <input
                type="file"
                accept=".csv,text/csv"
                required
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setNote(null);
                  setProblem(null);
                  setRows(null);
                }}
              />
            </label>
            <div className="actions">
              <button type="submit" disabled={!file || busy}>
                {busy ? t("barMode.songbook.uploading") : t("barMode.songbook.upload")}
              </button>
            </div>
          </form>
          {note && <p role="status">{note}</p>}
          {problem && (
            <p className="error" role="alert">
              {problem}
            </p>
          )}
          {rows && (
            <div role="alert" className="error">
              <p>{t("barMode.songbook.refused")}</p>
              <ul>
                {rows.errors.map((r) => (
                  <li key={`${r.line}:${r.problem}`}>
                    {t("barMode.songbook.line", { line: r.line, problem: problemText(r.problem) })}
                  </li>
                ))}
              </ul>
              {rows.count > rows.errors.length && (
                <p>{tn("barMode.songbook.more", rows.count - rows.errors.length)}</p>
              )}
            </div>
          )}
          <p className="small muted">{t("barMode.songbook.agreement")}</p>
        </>
      )}
    </section>
  );
}

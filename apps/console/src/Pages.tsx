import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

/**
 * Pages in the Console (M8-17; spec 13 · On call). The pages that are open and recent ones, who is
 * on call, and Acknowledge, which stops a page going to the second responder after 10 minutes.
 * Internal tool: English only.
 */
interface Page {
  id: string;
  rule: string;
  summary: string;
  runbook: string;
  severity: "page" | "ticket";
  opened_at: string;
  acked_at: string | null;
  cleared_at: string | null;
  test: boolean;
}
interface RotaSlot {
  slot: "first" | "second";
  name: string | null;
  email: string | null;
  text: boolean;
}
interface PagesResponse {
  pages: Page[];
  rota: RotaSlot[];
  rota_hint: string | null;
  escalate_after_minutes: number;
}

const RUNBOOK_BASE = "https://github.com/abhishekgaire/Noraymi/blob/main/";
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export function Pages() {
  const [data, setData] = useState<PagesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<PagesResponse>("GET", "/v1/console/pages"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const ack = async (id: string) => {
    setBusy(id);
    try {
      await api("POST", `/v1/console/pages/${id}/ack`, {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const open = data?.pages.filter((p) => !p.acked_at) ?? [];
  const recent = data?.pages.filter((p) => p.acked_at).slice(0, 10) ?? [];
  return (
    <section id="pages" aria-labelledby="pages-title">
      <h2 id="pages-title">Pages</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data === null ? (
        !error && <p role="status">Loading…</p>
      ) : (
        <>
          <p className="muted">
            On call:{" "}
            {data.rota
              .map(
                (r) =>
                  `${r.slot === "first" ? "First" : "Second"} · ${r.name ? `${r.name}${r.text ? " (email and text)" : " (email)"}` : "nobody yet"}`,
              )
              .join(" · ")}
            . A page nobody acknowledges in {data.escalate_after_minutes} minutes goes to the second
            responder.
          </p>
          {data.rota_hint && <p className="hint">{data.rota_hint}</p>}
          {open.length === 0 ? (
            <p>No open pages.</p>
          ) : (
            <ul className="pages-list">
              {open.map((p) => (
                <li key={p.id}>
                  <strong>
                    {p.test ? "[TEST] " : ""}
                    {p.severity === "ticket" ? "[Ticket] " : ""}
                    {p.summary}
                  </strong>
                  <span className="muted">
                    {" "}
                    · opened {when(p.opened_at)}
                    {p.cleared_at ? " · condition cleared" : ""} ·{" "}
                    <a href={`${RUNBOOK_BASE}${p.runbook}`} target="_blank" rel="noreferrer">
                      Runbook
                    </a>
                  </span>{" "}
                  <button type="button" disabled={busy === p.id} onClick={() => void ack(p.id)}>
                    Acknowledge
                  </button>
                </li>
              ))}
            </ul>
          )}
          {recent.length > 0 && (
            <details>
              <summary>Acknowledged</summary>
              <ul className="pages-list">
                {recent.map((p) => (
                  <li key={p.id}>
                    {p.test ? "[TEST] " : ""}
                    {p.summary} <span className="muted">· acknowledged {when(p.acked_at!)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

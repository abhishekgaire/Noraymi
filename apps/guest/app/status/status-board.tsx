"use client";

import { useCallback, useEffect, useState } from "react";
import { t, type MessageKey, type PublicStatus } from "@west4/shared";

const REFRESH_MS = 30_000;

const time = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function StatusBoard() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/v1/public/status", { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setStatus((await r.json()) as PublicStatus);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <main className="guest status-page">
      <h1>{t("en", "status.title")}</h1>
      <p>{t("en", "status.intro")}</p>
      {failed && (
        <div role="alert" className="status-unreachable">
          <p>{t("en", "status.unreachable")}</p>
          <button type="button" onClick={() => void load()}>
            {t("en", "status.retry")}
          </button>
        </div>
      )}
      {!status && !failed && <p aria-busy="true">{t("en", "status.loading")}</p>}
      {status && (
        <>
          <ul className="status-parts">
            {status.parts.map((p) => (
              <li key={p.part} data-part={p.part} data-state={p.state}>
                <span className="status-name">
                  {t("en", `status.part.${p.part}` as MessageKey)}
                </span>
                <span className="status-state">
                  {t("en", `status.state.${p.state}` as MessageKey)}
                </span>
                {p.note && <span className="status-note">{p.note}</span>}
                {p.since && p.state !== "operational" && (
                  <span className="status-since">
                    {t("en", "status.since", { time: time(p.since) })}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="status-updated">
            {t("en", "status.updated", { time: time(status.updated_at) })}
          </p>
        </>
      )}
    </main>
  );
}

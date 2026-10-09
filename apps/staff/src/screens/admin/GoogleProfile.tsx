import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Temporal } from "@west4/shared";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";

/**
 * Admin → Connections → Google Business Profile (M5-15): connect through
 * Google's own consent screen, pick the location when the account has
 * several, and see the last push of the hours. Google sends the browser back
 * here with ?code=&state=, which this posts to the API in the person's own
 * session. Until it's connected, Google shows as not connected and nothing is
 * sent.
 */
interface GoogleState {
  readonly available: boolean;
  readonly status: "not_connected" | "pending" | "connected" | "disconnected" | "error";
  readonly location: { name: string; title: string } | null;
  readonly last_push: { status: "ok" | "failed"; at: string; error?: string } | null;
  readonly locations?: { name: string; title: string }[];
}

export function GoogleProfile({ venueId, timeZone }: { venueId: string; timeZone: string }) {
  const { t, time, date } = useT();
  const [params, setParams] = useSearchParams();
  const [g, setG] = useState<GoogleState | null>(null);
  const [locations, setLocations] = useState<{ name: string; title: string }[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);
  const base = `/v1/venues/${venueId}/connections/google`;

  const act = useCallback(async (work: () => Promise<GoogleState | null>) => {
    setBusy(true);
    setFailed(false);
    try {
      const next = await work();
      if (next) {
        setG(next);
        if (next.locations) setLocations(next.locations);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    if (code && state && !handled.current) {
      handled.current = true;
      setParams({}, { replace: true });
      void act(() => api<GoogleState>("POST", `${base}/callback`, { code, state }));
      return;
    }
    if (!handled.current) void act(() => api<GoogleState>("GET", base));
  }, [act, base, params, setParams]);

  useEffect(() => {
    if (g?.status === "pending" && locations.length === 0)
      void api<{ locations: { name: string; title: string }[] }>("GET", `${base}/locations`)
        .then((r) => setLocations(r.locations))
        .catch(() => setFailed(true));
  }, [base, g?.status, locations.length]);

  const connect = () =>
    act(async () => {
      const r = await api<{ url: string }>("POST", `${base}/connect`);
      window.location.assign(r.url);
      return null;
    });

  const when = (at: string) =>
    `${date(Temporal.Instant.from(at).toZonedDateTimeISO(timeZone).toPlainDate())} ${time(at, timeZone)}`;

  return (
    <section className="google-profile" aria-labelledby="google-title">
      <h3 id="google-title">{t("google.title")}</h3>
      <p className="small muted">{t("google.hint")}</p>
      {failed && (
        <p className="error" role="alert">
          {t("google.error")}
        </p>
      )}
      {g === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : !g.available ? (
        <p className="muted">{t("google.notSetUp")}</p>
      ) : g.status === "connected" && g.location ? (
        <>
          <p>
            <span className="ok">{t("connections.status.connected")}</span> ·{" "}
            {t("google.location", { title: g.location.title })}
          </p>
          {g.last_push === null ? (
            <p className="muted">{t("google.push.waiting")}</p>
          ) : g.last_push.status === "ok" ? (
            <p>{t("google.push.ok", { when: when(g.last_push.at) })}</p>
          ) : (
            <p className="error" role="alert">
              {t("google.push.failed", { when: when(g.last_push.at) })}
              {g.last_push.error ? ` · ${g.last_push.error}` : ""}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => api<GoogleState>("POST", `${base}/push`))}
            >
              {t("google.pushNow")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => api<GoogleState>("POST", `${base}/disconnect`))}
            >
              {t("google.disconnect")}
            </button>
          </div>
        </>
      ) : g.status === "pending" ? (
        <>
          <p>{t("google.pickLocation")}</p>
          {locations.length === 0 ? (
            <p className="muted">{t("google.noLocations")}</p>
          ) : (
            <ul className="list">
              {locations.map((l) => (
                <li key={l.name}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api<GoogleState>("PUT", `${base}/location`, { name: l.name }))
                    }
                  >
                    {l.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <p className="muted">{t("connections.status.not_connected")}</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void connect()}>
              {t("google.connect")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

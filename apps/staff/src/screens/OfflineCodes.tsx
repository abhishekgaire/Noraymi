import { useCallback, useEffect, useState } from "react";
import { Temporal } from "@west4/shared";
import { api } from "../api.js";
import { useClock } from "../clock.js";
import { useT } from "../i18n.js";
import {
  codeNow,
  fetchAndKeepCodes,
  keptCodes,
  OFFLINE_CODES_REFRESH_MS,
  type KeptCodes,
} from "../offline-codes.js";
import { useSession } from "../session.js";

/**
 * Offline codes (M8-04; screens N29), on managers' and owners' phones: each
 * computer's code right now, from the codes this phone keeps, so it works
 * when our cloud is down; and, online, tonight's one-time codes to print
 * for the sealed card.
 */
export function OfflineCodes() {
  const { t, time, date } = useT();
  const { state } = useSession();
  const { now } = useClock();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [kept, setKept] = useState<KeptCodes | null>(() => (venueId ? keptCodes(venueId) : null));
  const [failed, setFailed] = useState(false);
  const [printed, setPrinted] = useState<{
    name: string;
    business_date: string;
    codes: string[];
  } | null>(null);
  const [printFailed, setPrintFailed] = useState(false);

  const refresh = useCallback(async () => {
    if (!venueId) return;
    try {
      setKept(await fetchAndKeepCodes(venueId));
      setFailed(false);
    } catch {
      setKept(keptCodes(venueId));
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), OFFLINE_CODES_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const print = async (deviceId: string) => {
    setPrintFailed(false);
    try {
      setPrinted(
        await api<{ name: string; business_date: string; codes: string[] }>(
          "GET",
          `/v1/venues/${venueId}/devices/${deviceId}/offline-codes/printed`,
        ),
      );
      setTimeout(() => window.print(), 0);
    } catch {
      setPrintFailed(true);
    }
  };

  const at = now ?? Temporal.Now.instant();
  return (
    <section className="offline-codes" aria-labelledby="offline-codes-title">
      <h1 id="offline-codes-title">{t("offlineCodes.title")}</h1>
      <p className="muted">{t("offlineCodes.intro")}</p>
      {failed && (
        <p className="error" role="alert">
          {t("offlineCodes.failed")}
        </p>
      )}
      {!kept ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : kept.devices.length === 0 ? (
        <p className="muted">{t("offlineCodes.none")}</p>
      ) : (
        <>
          <p className="small muted">
            {t("offlineCodes.kept", { time: time(kept.fetched_at, timeZone) })}
          </p>
          <ul className="plain">
            {kept.devices.map((d) => {
              const current = codeNow(d, at);
              return (
                <li key={d.device_id} className="card" aria-label={d.name}>
                  <h2>{t("offlineCodes.now", { name: d.name })}</h2>
                  {current ? (
                    <>
                      <p className="code-now" data-testid={`code-${d.kind}`}>
                        {current.code.slice(0, 3)} {current.code.slice(3)}
                      </p>
                      <p className="small muted">
                        {t("offlineCodes.until", { time: time(current.ends_at, timeZone) })}
                      </p>
                    </>
                  ) : (
                    <p className="error">{t("offlineCodes.stale")}</p>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void print(d.device_id)}
                  >
                    {t("offlineCodes.print")}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {printFailed && (
        <p className="error" role="alert">
          {t("offlineCodes.failed")}
        </p>
      )}
      {printed && (
        <div className="card" role="region" aria-labelledby="printed-codes-title">
          <h2 id="printed-codes-title">
            {t("offlineCodes.printed", {
              name: printed.name,
              date: date(Temporal.PlainDate.from(printed.business_date)),
            })}
          </h2>
          <p className="small">{t("offlineCodes.printedHint")}</p>
          <ol className="printed-codes">
            {printed.codes.map((c) => (
              <li key={c}>
                {c.slice(0, 4)}-{c.slice(4)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/**
 * In the background on a manager's or owner's phone (never a shared
 * computer): fetch and keep the codes while online, so they're there when
 * the venue goes offline even if nobody opened the screen.
 */
export function OfflineCodesSync({ venueId }: { venueId: string }) {
  useEffect(() => {
    const keep = () => void fetchAndKeepCodes(venueId).catch(() => undefined);
    keep();
    const timer = setInterval(keep, OFFLINE_CODES_REFRESH_MS);
    return () => clearInterval(timer);
  }, [venueId]);
  return null;
}

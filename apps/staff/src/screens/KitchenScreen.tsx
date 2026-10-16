import { useCallback, useEffect, useRef, useState } from "react";
import { formatTime, Temporal } from "@west4/shared";
import { ApiCallError, NetworkError, api } from "../api.js";
import { deviceOnlyApi, deviceRevoked, readDevice, type StoredDevice } from "../device.js";
import { startDisplayHeartbeats } from "../heartbeat.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import "./kitchen.css";

/** A kitchen ticket as the kitchen screen route answers it (P-17). */
export interface KitchenTicket {
  readonly id: string;
  readonly created_at: string;
  readonly done_at: string | null;
  readonly room: string | null;
  readonly remake: boolean;
  readonly after_outage: boolean;
  readonly training: boolean;
  readonly by: string | null;
  readonly lines: readonly {
    qty: number;
    name: string;
    options: readonly string[];
    notes: string | null;
    kitchen_note: string | null;
    allergy: boolean;
  }[];
}

/** How often the screen asks for new tickets: a sent ticket shows within 3 seconds (P-17). */
export const KITCHEN_POLL_MS = 2_000;

const CACHE = "west4.kitchen.tickets";
const PENDING = "west4.kitchen.pendingDone";

function readStore<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeStore(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the screen still works while it's online.
  }
}

type Load =
  | { kind: "loading" }
  | { kind: "live" }
  | { kind: "offline"; since: string }
  | { kind: "off" }
  | { kind: "error" };

/**
 * The kitchen screen (P-17; module kitchen_screen): a paired kitchen display, or a bar computer's
 * second window, showing the open kitchen tickets oldest first with their times. Done bumps one and
 * tells the bar. Offline it keeps the last tickets it saw (this window's own copy) and holds Done
 * taps until the connection is back; the server takes a repeated Done once.
 */
export function KitchenScreen() {
  const { t, locale } = useT();
  const { setLocale } = useSession();
  const [device, setDevice] = useState<StoredDevice | null | undefined>(undefined);
  const [tickets, setTickets] = useState<KitchenTicket[] | null>(
    () => readStore<{ tickets: KitchenTicket[] }>(CACHE)?.tickets ?? null,
  );
  const [now, setNow] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [pending, setPending] = useState<string[]>(() => readStore<string[]>(PENDING) ?? []);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    void readDevice().then(setDevice);
  }, []);
  useEffect(() => {
    if (device?.kind !== "kitchen_display") return;
    return startDisplayHeartbeats(device);
  }, [device]);

  const venueId = device?.venueId ?? null;
  const timeZone = device?.venue?.time_zone ?? "America/New_York";

  const call = useCallback(
    <T,>(method: "GET" | "POST", path: string): Promise<T> =>
      device ? deviceOnlyApi<T>(device, method, path) : api<T>(method, path),
    [device],
  );

  const refresh = useCallback(async () => {
    if (!venueId) return;
    // Done taps held while offline go first, so a bumped ticket doesn't come back.
    for (const id of pendingRef.current) {
      try {
        await call("POST", `/v1/venues/${venueId}/kitchen/tickets/${id}/done`);
        const rest = pendingRef.current.filter((x) => x !== id);
        pendingRef.current = rest;
        setPending(rest);
        writeStore(PENDING, rest);
      } catch (e) {
        if (e instanceof ApiCallError && e.status === 404) {
          const rest = pendingRef.current.filter((x) => x !== id);
          pendingRef.current = rest;
          setPending(rest);
          writeStore(PENDING, rest);
          continue;
        }
        break;
      }
    }
    try {
      const r = await call<{ tickets: KitchenTicket[]; now: string }>(
        "GET",
        `/v1/venues/${venueId}/kitchen/tickets`,
      );
      setTickets(r.tickets);
      setNow(r.now);
      setLoad({ kind: "live" });
      writeStore(CACHE, { tickets: r.tickets, at: r.now });
    } catch (e) {
      if (e instanceof ApiCallError && e.code === "module_off") {
        setLoad({ kind: "off" });
        return;
      }
      if (e instanceof ApiCallError && e.status === 403 && device) {
        void deviceRevoked();
        return;
      }
      const unreachable =
        e instanceof NetworkError || (e instanceof ApiCallError && e.status >= 502);
      const kept = readStore<{ tickets: KitchenTicket[]; at: string }>(CACHE);
      if (unreachable && kept) {
        setTickets(kept.tickets);
        setLoad({ kind: "offline", since: kept.at });
      } else setLoad(unreachable ? { kind: "offline", since: "" } : { kind: "error" });
    }
  }, [venueId, call, device]);

  useEffect(() => {
    if (device === undefined) return;
    void refresh();
    const timer = setInterval(() => void refresh(), KITCHEN_POLL_MS);
    return () => clearInterval(timer);
  }, [device, refresh]);

  const done = async (id: string) => {
    if (!venueId) return;
    const next = [...pendingRef.current.filter((x) => x !== id), id];
    pendingRef.current = next;
    setPending(next);
    writeStore(PENDING, next);
    await refresh();
  };

  const minutes = (at: string) =>
    now
      ? Math.max(
          0,
          Math.floor(
            (Temporal.Instant.from(now).epochMilliseconds -
              Temporal.Instant.from(at).epochMilliseconds) /
              60_000,
          ),
        )
      : null;
  const shown = (tickets ?? []).filter((k) => !pending.includes(k.id));

  return (
    <main className="kitchen-screen" aria-labelledby="kitchen-title">
      <header className="kitchen-head">
        <h1 id="kitchen-title">{t("kitchenScreen.title")}</h1>
        {device?.venue && <span className="muted">{device.venue.name}</span>}
        <button
          type="button"
          className="kitchen-lang"
          onClick={() => void setLocale(locale === "es" ? "en" : "es")}
        >
          {locale === "es" ? "English" : "Español"}
        </button>
      </header>
      {device === null && load.kind === "error" && (
        <p className="error" role="alert">
          {t("kitchenScreen.notPaired")}
        </p>
      )}
      {load.kind === "offline" && (
        <p className="kitchen-band" role="status">
          {load.since
            ? t("kitchenScreen.offline", { time: formatTime(locale, load.since, timeZone) })
            : t("kitchenScreen.offlineNoCopy")}
          {pending.length > 0 && <> · {t("kitchenScreen.offlineDone", { n: pending.length })}</>}
        </p>
      )}
      {load.kind === "error" && device !== null && (
        <p className="error" role="alert">
          {t("kitchenScreen.error")}
        </p>
      )}
      {load.kind === "off" ? (
        <p className="kitchen-empty" role="status">
          {t("kitchenScreen.off")}
        </p>
      ) : tickets === null ? (
        load.kind === "loading" && <p role="status">{t("shell.loading")}</p>
      ) : shown.length === 0 ? (
        <p className="kitchen-empty" role="status">
          {t("kitchenScreen.empty")}
        </p>
      ) : (
        <ol className="kitchen-tickets" aria-label={t("kitchenScreen.open")}>
          {shown.map((k) => {
            const age = minutes(k.created_at);
            return (
              <li
                key={k.id}
                className="kitchen-ticket"
                aria-label={k.room ?? t("kitchenScreen.title")}
              >
                <div className="kitchen-ticket-head">
                  <strong>{k.room ?? "—"}</strong>
                  <span>
                    {formatTime(locale, k.created_at, timeZone)}
                    {age !== null && <> · {t("kitchenScreen.age", { min: age })}</>}
                  </span>
                </div>
                {k.training && <p className="kitchen-stamp">{t("kitchenScreen.training")}</p>}
                {k.remake && <p className="kitchen-stamp">{t("kitchenScreen.remake")}</p>}
                {k.after_outage && (
                  <p className="kitchen-stamp">{t("kitchenScreen.afterOutage")}</p>
                )}
                <ul className="kitchen-lines">
                  {k.lines.map((l, i) => (
                    <li key={i}>
                      <span className="kitchen-qty">{l.qty}×</span> {l.name}
                      {l.options.length > 0 && (
                        <span className="kitchen-options">{l.options.join(" · ")}</span>
                      )}
                      {l.notes && <span className="kitchen-options">“{l.notes}”</span>}
                      {l.kitchen_note &&
                        (l.allergy ? (
                          <strong className="kitchen-allergy">
                            {t("kitchen.note.allergy", { note: l.kitchen_note.toUpperCase() })}
                          </strong>
                        ) : (
                          <span className="kitchen-options">“{l.kitchen_note}”</span>
                        ))}
                    </li>
                  ))}
                </ul>
                {k.by && <p className="muted small">{t("kitchenScreen.by", { name: k.by })}</p>}
                <button
                  type="button"
                  className="primary kitchen-done"
                  onClick={() => void done(k.id)}
                >
                  {t("kitchenScreen.done")}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}

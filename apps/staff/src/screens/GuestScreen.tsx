import { useCallback, useEffect, useRef, useState } from "react";
import type { Cents, Locale } from "@west4/shared";
import { ApiCallError, NetworkError, api } from "../api.js";
import { deviceOnlyApi, deviceRevoked, readDevice, type StoredDevice } from "../device.js";
import { startDisplayHeartbeats } from "../heartbeat.js";
import { LocaleProvider, useLocale, useT } from "../i18n.js";
import "./guest.css";

/** A line as the guest screen route answers it (P-18). */
interface Line {
  readonly label: string;
  readonly amount_cents: number;
  readonly strong?: boolean;
}

export interface GuestScreenView {
  readonly fp: string;
  readonly unchanged: false;
  readonly venue: string;
  readonly register: { readonly id: string; readonly name: string } | null;
  readonly needs_register: boolean;
  readonly check: {
    readonly id: string;
    readonly number: string;
    readonly where: string | null;
    readonly training: boolean;
    readonly lines: readonly Line[];
    readonly totals: readonly Line[];
    readonly payments: readonly Line[];
    readonly total_cents: number;
    readonly due_cents: number;
    readonly cash_total_cents: number | null;
    readonly cash_due_cents: number | null;
  } | null;
  readonly unsent: readonly {
    readonly name: string;
    readonly qty: number;
    readonly options: readonly string[];
    readonly amount_cents: number;
  }[];
  readonly unsent_cents: number;
}

/**
 * How often the screen asks its register what it shows (P-18: within a second). An unchanged
 * answer is a fingerprint alone; every few seconds it asks in full, for room time and the like.
 */
export const GUEST_POLL_MS = 500;
const FULL_EVERY = 10;
const LANG = "west4.guestScreen.lang";

function storedLang(): Locale | null {
  try {
    const v = localStorage.getItem(LANG);
    return v === "en" || v === "es" ? v : null;
  } catch {
    return null;
  }
}

type Load = "loading" | "live" | "offline" | "off" | "error" | "notPaired";

/**
 * The guest screen (P-18; module guest_screen): the check being rung up at the register, facing the
 * guest, on a paired guest display or the bar computer's second monitor. Idle, the venue's name.
 * It shows exactly what the last answer says: a new check replaces the old one whole, and offline
 * or on an error it goes back to the venue's name rather than keep a check that may have moved on.
 * English or Spanish, with a toggle the guest can tap; nobody signs in here.
 */
export function GuestScreen() {
  const staffLocale = useLocale();
  const [lang, setLang] = useState<Locale>(() => storedLang() ?? staffLocale);
  const choose = (next: Locale) => {
    setLang(next);
    try {
      localStorage.setItem(LANG, next);
    } catch {
      // Storage unavailable: the choice lasts while the window is open.
    }
  };
  return (
    <LocaleProvider locale={lang}>
      <GuestScreenBody onLang={choose} />
    </LocaleProvider>
  );
}

function GuestScreenBody({ onLang }: { onLang: (l: Locale) => void }) {
  const { t, locale, money } = useT();
  const [device, setDevice] = useState<StoredDevice | null | undefined>(undefined);
  const [view, setView] = useState<GuestScreenView | null>(null);
  const [load, setLoad] = useState<Load>("loading");
  const fp = useRef<string | null>(null);
  const asks = useRef(0);
  // One ask at a time; a language or device change starts a new generation and drops older answers.
  const busy = useRef(false);
  const gen = useRef(0);

  useEffect(() => {
    void readDevice().then(setDevice);
  }, []);
  useEffect(() => {
    if (device?.kind !== "guest_display") return;
    return startDisplayHeartbeats(device);
  }, [device]);

  const venueId = device?.venueId ?? null;

  const refresh = useCallback(async () => {
    if (device === undefined) return;
    if (!venueId) {
      setLoad("notPaired");
      return;
    }
    if (busy.current) return;
    busy.current = true;
    const full = asks.current++ % FULL_EVERY === 0 || fp.current === null;
    const since = full ? "" : `&since=${encodeURIComponent(fp.current!)}`;
    const path = `/v1/venues/${venueId}/guest-screen?lang=${locale}${since}`;
    const mine = gen.current;
    try {
      const r = await (device
        ? deviceOnlyApi<GuestScreenView | { fp: string; unchanged: true }>(device, "GET", path)
        : api<GuestScreenView | { fp: string; unchanged: true }>("GET", path));
      if (mine !== gen.current) return;
      setLoad("live");
      if (r.unchanged) return;
      fp.current = r.fp;
      setView(r);
    } catch (e) {
      if (mine !== gen.current) return;
      fp.current = null;
      // Never keep a check on screen that the register may have moved on from.
      setView((v) => (v ? { ...v, check: null, unsent: [], unsent_cents: 0 } : v));
      if (e instanceof ApiCallError && e.code === "module_off") return setLoad("off");
      if (e instanceof ApiCallError && e.status === 403 && device) {
        void deviceRevoked();
        return;
      }
      const unreachable =
        e instanceof NetworkError || (e instanceof ApiCallError && e.status >= 502);
      setLoad(unreachable ? "offline" : "error");
    } finally {
      busy.current = false;
    }
  }, [device, venueId, locale]);

  useEffect(() => {
    if (device === undefined) return;
    fp.current = null;
    gen.current++;
    busy.current = false;
    void refresh();
    const timer = setInterval(() => void refresh(), GUEST_POLL_MS);
    return () => clearInterval(timer);
  }, [device, refresh]);

  const venueName = view?.venue ?? device?.venue?.name ?? "";
  const check = load === "live" ? (view?.check ?? null) : null;
  const unsent = load === "live" ? (view?.unsent ?? []) : [];
  const m = (c: number) => money(c as Cents);
  const note =
    load === "loading"
      ? t("shell.loading")
      : load === "offline"
        ? t("guestScreen.offline")
        : load === "error"
          ? t("guestScreen.error")
          : load === "off"
            ? t("guestScreen.off")
            : load === "notPaired"
              ? t("guestScreen.notPaired")
              : view?.needs_register
                ? t("guestScreen.chooseRegister")
                : null;

  return (
    <main className="guest-screen" aria-label={t("guestScreen.title")}>
      <button
        type="button"
        className="guest-lang"
        onClick={() => onLang(locale === "es" ? "en" : "es")}
      >
        {locale === "es" ? "English" : "Español"}
      </button>
      {check || unsent.length > 0 ? (
        <section className="guest-check" aria-live="polite">
          {check?.training && <p className="guest-training">{t("training.band")}</p>}
          <header className="guest-check-head">
            <h1>{check?.where ?? venueName}</h1>
            {check && <span>{check.number}</span>}
          </header>
          {check && (
            <ul className="guest-lines" aria-label={t("guestScreen.title")}>
              {check.lines.map((l, i) => (
                <li key={i}>
                  <span>{l.label}</span>
                  <span>{m(l.amount_cents)}</span>
                </li>
              ))}
            </ul>
          )}
          {unsent.length > 0 && (
            <>
              <h2 className="guest-sub">{t("guestScreen.unsent")}</h2>
              <ul className="guest-lines guest-unsent" aria-label={t("guestScreen.unsent")}>
                {unsent.map((u, i) => (
                  <li key={i}>
                    <span>
                      {u.qty > 1 ? `${u.qty}× ` : ""}
                      {u.name}
                      {u.options.length > 0 && (
                        <span className="guest-options"> · {u.options.join(" · ")}</span>
                      )}
                    </span>
                    <span>{m(u.amount_cents)}</span>
                  </li>
                ))}
                {!check && (
                  <li className="guest-strong">
                    <span>{t("guestScreen.subtotal")}</span>
                    <span>{m(view?.unsent_cents ?? 0)}</span>
                  </li>
                )}
              </ul>
            </>
          )}
          {check && (
            <ul className="guest-lines guest-totals" aria-label={t("guestScreen.totals")}>
              {check.totals.map((l, i) => (
                <li key={i} className={l.strong ? "guest-strong" : undefined}>
                  <span>{l.label}</span>
                  <span>{m(l.amount_cents)}</span>
                </li>
              ))}
              {check.cash_total_cents !== null && (
                <li className="guest-cash">
                  <span>{t("guestScreen.cashPrice")}</span>
                  <span>{m(check.cash_total_cents)}</span>
                </li>
              )}
              {check.payments.map((l, i) => (
                <li key={`p${i}`} className={l.strong ? "guest-strong" : undefined}>
                  <span>{l.label}</span>
                  <span>{m(l.amount_cents)}</span>
                </li>
              ))}
              {check.cash_due_cents !== null && (
                <li className="guest-cash">
                  <span>{t("guestScreen.cashPrice")}</span>
                  <span>{m(check.cash_due_cents)}</span>
                </li>
              )}
            </ul>
          )}
        </section>
      ) : (
        <section className="guest-idle">
          <h1>{venueName}</h1>
        </section>
      )}
      {note && (
        <p className="guest-note" role="status">
          {note}
        </p>
      )}
    </main>
  );
}

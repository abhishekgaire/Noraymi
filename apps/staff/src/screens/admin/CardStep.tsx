import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../api.js";
import { useConnection } from "../../connection.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Set up your venue's step 3, Card payments (O-05; spec 17 · Step details 3;
 * Stripe setup 2). Connect with Stripe opens Stripe's own onboarding, where
 * the owner types the EIN, the bank details and their ID; nothing is pasted
 * here. The state comes from the saved rows account.updated keeps: Not
 * connected, Waiting for Stripe…, Stripe needs more from you (Continue with
 * Stripe), or Connected through the organization with card payments on.
 */
interface ConnectState {
  readonly state: "not_connected" | "waiting" | "needs_more" | "connected";
  readonly organization_name: string | null;
}

export function CardStep({ onSaved }: { onSaved: () => void }) {
  const { t } = useT();
  const { state: session } = useSession();
  const connection = useConnection();
  const [params] = useSearchParams();
  const back = params.get("stripe") === "back";
  const venueId = session.status === "signedIn" ? session.membership.venue_id : null;
  const [state, setState] = useState<ConnectState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offline = connection.kind === "offline";
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const done = useRef(false);

  const take = useCallback((next: ConnectState) => {
    setState(next);
    if (next.state === "connected" && !done.current) {
      done.current = true;
      saved.current();
    }
  }, []);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      take(await api<ConnectState>("GET", `/v1/venues/${venueId}/payments/stripe/connect`));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [venueId, take]);
  useEffect(() => {
    void load();
  }, [load]);
  // Back from Stripe: look again until account.updated has come.
  const waiting = !!state && state.state !== "connected";
  useEffect(() => {
    if (!back || !waiting) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [back, waiting, load]);

  const connect = async () => {
    if (!venueId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<ConnectState & { url: string | null }>(
        "POST",
        `/v1/venues/${venueId}/payments/stripe/connect`,
      );
      if (r.url) {
        window.location.assign(r.url);
        return;
      }
      take(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  if (loadError)
    return (
      <div className="setup-card">
        <div className="error" role="alert">
          <p>{t("onboarding.card.loadFailed")}</p>
          <button type="button" className="secondary" onClick={() => void load()}>
            {t("shell.error.retry")}
          </button>
        </div>
      </div>
    );
  if (!state)
    return (
      <div className="setup-card">
        <p role="status">{t("shell.loading")}</p>
      </div>
    );

  const button = (label: string) => (
    <button
      type="button"
      className="primary"
      disabled={busy || offline}
      onClick={() => void connect()}
    >
      {busy ? t("onboarding.card.opening") : label}
    </button>
  );

  return (
    <div className="setup-card">
      {state.state === "connected" ? (
        <p className="ok" role="status">
          {t("onboarding.card.connected", { org: state.organization_name ?? "" })}
        </p>
      ) : state.state === "not_connected" ? (
        <>
          <p>{t("onboarding.card.notConnected")}</p>
          {button(t("onboarding.card.connect"))}
        </>
      ) : (
        <>
          <p role="status" className={state.state === "needs_more" ? "notice" : ""}>
            {state.state === "needs_more"
              ? t("onboarding.card.needsMore")
              : t("onboarding.card.waiting")}
          </p>
          {button(t("onboarding.card.continue"))}
        </>
      )}
      <p className="muted small">{t("onboarding.card.note")}</p>
      {offline && (
        <p className="notice" role="status">
          {t("onboarding.card.offline")}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

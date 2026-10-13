import { useCallback, useEffect, useId, useState } from "react";
import type { MessageKey } from "@west4/shared";
import { api, ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";

/**
 * Connect your Twilio account (T-02; D123; spec 11 · Accounts), in Admin → Phone & texts and in Set
 * up your venue's step 11: the venue's own Twilio account. The Account SID and Auth Token, Check (a
 * read-only call that lists the account's +1 numbers and messaging services), the number and the
 * service picked from those lists, Connect; then Not connected, Connected · waiting for approval
 * (Check again) or Approved, Replace keys and Disconnect. The token is never shown after saving.
 */
export interface TwilioView {
  state: "not_connected" | "waiting" | "approved";
  account: { sid_last4: string; name: string | null; trial: boolean } | null;
  number: string | null;
  service_sid: string | null;
  campaign: "not_registered" | "pending" | "approved" | "rejected";
  checked_at: string | null;
  live: boolean;
}
interface Checked {
  account: { sid_last4: string; name: string; trial: boolean };
  numbers: { sid: string; phone_e164: string; name: string }[];
  services: { sid: string; name: string }[];
}

const SID = /^AC[0-9a-f]{32}$/i;
const TOKEN = /^[0-9a-f]{32}$/i;
const GUIDE = [1, 2, 3, 4, 5, 6] as const;

/** "+12122550011" as "+1 212 255 0011". */
const pretty = (e164: string) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164;
};

function errorKey(e: unknown): MessageKey {
  if (e instanceof ApiCallError) {
    const reason = e.details["reason"];
    if (reason === "twilio_refused") return "twilio.error.refused";
    if (reason === "account_in_use") return "twilio.error.inUse";
    if (reason === "number_in_use") return "twilio.error.numberInUse";
    if (e.code === "twilio_error") return "twilio.error.unavailable";
    if (e.status === 400) return "twilio.error.format";
  }
  return "shell.error.cantReach";
}

export function TwilioConnect({
  venueId,
  onChange,
}: {
  venueId: string;
  onChange?: (view: TwilioView) => void;
}) {
  const { t } = useT();
  const id = useId();
  const [view, setView] = useState<TwilioView | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sid, setSid] = useState("");
  const [token, setToken] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  const [number, setNumber] = useState("");
  const [service, setService] = useState("");
  const [busy, setBusy] = useState<"check" | "connect" | "refresh" | "disconnect" | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [confirming, setConfirming] = useState(false);

  const show = useCallback(
    (v: TwilioView) => {
      setView(v);
      onChange?.(v);
    },
    [onChange],
  );
  const load = useCallback(async () => {
    try {
      show(await api<TwilioView>("GET", `/v1/venues/${venueId}/texts/twilio`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId, show]);
  useEffect(() => {
    if (venueId) void load();
  }, [venueId, load]);

  const keys = () => ({ account_sid: sid.trim(), auth_token: token.trim() });
  const check = async () => {
    if (!SID.test(sid.trim()) || !TOKEN.test(token.trim())) return setError("twilio.error.format");
    setBusy("check");
    setError(null);
    try {
      const c = await api<Checked>("POST", `/v1/venues/${venueId}/texts/twilio/check`, keys());
      setChecked(c);
      setNumber(c.numbers[0]?.sid ?? "");
      setService(c.services[0]?.sid ?? "");
    } catch (e) {
      setChecked(null);
      setError(errorKey(e));
    } finally {
      setBusy(null);
    }
  };
  const connect = async () => {
    setBusy("connect");
    setError(null);
    try {
      show(
        await api<TwilioView>("POST", `/v1/venues/${venueId}/texts/twilio`, {
          ...keys(),
          number_sid: number,
          service_sid: service,
        }),
      );
      // The token leaves the page once it's saved.
      setSid("");
      setToken("");
      setChecked(null);
      setEditing(false);
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(null);
    }
  };
  const act = async (which: "refresh" | "disconnect") => {
    setBusy(which);
    setError(null);
    try {
      show(
        which === "refresh"
          ? await api<TwilioView>("POST", `/v1/venues/${venueId}/texts/twilio/refresh`)
          : await api<TwilioView>("POST", `/v1/venues/${venueId}/texts/twilio/disconnect`),
      );
      setConfirming(false);
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(null);
    }
  };

  const heading = `${id}-h`;
  if (failed)
    return (
      <section className="twilio-connect" aria-labelledby={heading}>
        <h3 id={heading}>{t("twilio.title")}</h3>
        <div className="error" role="alert">
          <p>{t("shell.error.cantReach")}</p>
          <button type="button" className="secondary" onClick={() => void load()}>
            {t("shell.error.retry")}
          </button>
        </div>
      </section>
    );
  if (!view)
    return (
      <section className="twilio-connect" aria-labelledby={heading}>
        <h3 id={heading}>{t("twilio.title")}</h3>
        <p role="status">{t("shell.loading")}</p>
      </section>
    );

  const connected = view.state !== "not_connected";
  const form = !connected || editing;
  return (
    <section className="twilio-connect" aria-labelledby={heading} data-testid="twilio">
      <h3 id={heading}>{t("twilio.title")}</h3>
      <p className="twilio-state" role="status">
        <strong>{t(`twilio.state.${view.state}`)}</strong>
      </p>
      {connected ? (
        <>
          <dl className="twilio-facts">
            <dt>{t("twilio.number")}</dt>
            <dd>{view.number ? pretty(view.number) : "—"}</dd>
            <dt>{t("twilio.account")}</dt>
            <dd>
              {t("twilio.accountValue", {
                name: view.account?.name || "Twilio",
                last4: view.account?.sid_last4 ?? "",
              })}
            </dd>
          </dl>
          {view.account?.trial && <p className="notice small">{t("twilio.trial")}</p>}
          {view.state !== "approved" && (
            <p className="small muted">{t(`twilio.campaign.${view.campaign}`)}</p>
          )}
          <p className={view.live ? "small" : "small muted"}>
            {t(view.live ? "twilio.live" : "twilio.held")}
          </p>
          {!editing && (
            <div className="team-actions">
              {view.state !== "approved" && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== null}
                  onClick={() => void act("refresh")}
                >
                  {busy === "refresh" ? t("twilio.checking") : t("twilio.checkAgain")}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={busy !== null}
                onClick={() => {
                  setEditing(true);
                  setError(null);
                }}
              >
                {t("twilio.replace")}
              </button>
              {confirming ? (
                <p className="notice" role="alertdialog">
                  {t("twilio.disconnect.confirm")}
                  <button
                    type="button"
                    className="primary"
                    disabled={busy !== null}
                    onClick={() => void act("disconnect")}
                  >
                    {t("twilio.disconnect.yes")}
                  </button>
                  <button type="button" className="secondary" onClick={() => setConfirming(false)}>
                    {t("twilio.cancel")}
                  </button>
                </p>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null}
                  onClick={() => setConfirming(true)}
                >
                  {t("twilio.disconnect")}
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="small muted">{t("twilio.notConnected.hint")}</p>
      )}
      {form && (
        <div className="twilio-form">
          <p className="small muted">{t("twilio.intro")}</p>
          <details className="twilio-guide">
            <summary>{t("twilio.guide")}</summary>
            <ol>
              {GUIDE.map((n) => (
                <li key={n}>{t(`twilio.guide.${n}`)}</li>
              ))}
            </ol>
          </details>
          <div className="invite-fields">
            <label>
              <span>{t("twilio.sid")}</span>
              <input
                value={sid}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setSid(e.target.value);
                  setChecked(null);
                }}
              />
              <span className="small muted">{t("twilio.sid.hint")}</span>
            </label>
            <label>
              <span>{t("twilio.token")}</span>
              <input
                type="password"
                value={token}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setToken(e.target.value);
                  setChecked(null);
                }}
              />
              <span className="small muted">{t("twilio.token.hint")}</span>
            </label>
          </div>
          {!checked && (
            <div className="team-actions">
              <button
                type="button"
                className="primary"
                disabled={busy !== null}
                onClick={() => void check()}
              >
                {busy === "check" ? t("twilio.checking") : t("twilio.check")}
              </button>
              {editing && (
                <button type="button" className="secondary" onClick={() => setEditing(false)}>
                  {t("twilio.cancel")}
                </button>
              )}
            </div>
          )}
          {checked && (
            <>
              {checked.account.trial && <p className="notice small">{t("twilio.trial")}</p>}
              <div className="invite-fields">
                <label>
                  <span>{t("twilio.number")}</span>
                  {checked.numbers.length === 0 ? (
                    <span className="small error">{t("twilio.noNumbers")}</span>
                  ) : (
                    <select value={number} onChange={(e) => setNumber(e.target.value)}>
                      {checked.numbers.map((n) => (
                        <option key={n.sid} value={n.sid}>
                          {n.name ? `${pretty(n.phone_e164)} · ${n.name}` : pretty(n.phone_e164)}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
                <label>
                  <span>{t("twilio.service")}</span>
                  {checked.services.length === 0 ? (
                    <span className="small error">{t("twilio.noServices")}</span>
                  ) : (
                    <select value={service} onChange={(e) => setService(e.target.value)}>
                      {checked.services.map((s) => (
                        <option key={s.sid} value={s.sid}>
                          {s.name || s.sid}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              </div>
              <div className="team-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== null || !number || !service}
                  onClick={() => void connect()}
                >
                  {busy === "connect" ? t("twilio.connecting") : t("twilio.connect")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setChecked(null);
                    if (connected) setEditing(false);
                  }}
                >
                  {t("twilio.cancel")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
    </section>
  );
}

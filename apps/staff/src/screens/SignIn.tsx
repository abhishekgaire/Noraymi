import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import { LanguageSwitch } from "../layout/LanguageSwitch.js";

/**
 * The shell's sign-in (M1-19 on the web): an owner or manager by email with a
 * passkey or their authenticator app. The name tiles with badge or PIN for
 * shared screens arrive with M1-24 and M1-26, which also give this screen its
 * final shape.
 */
type Step =
  | { readonly kind: "email" }
  | { readonly kind: "code"; readonly expiresMinutes: number }
  | { readonly kind: "working" };

type PasskeyJson = {
  parseRequestOptionsFromJSON(options: unknown): PublicKeyCredentialRequestOptions;
};

function passkeySupport(): PasskeyJson | null {
  const ctor = (globalThis as { PublicKeyCredential?: Partial<PasskeyJson> }).PublicKeyCredential;
  return ctor && typeof ctor.parseRequestOptionsFromJSON === "function"
    ? (ctor as PasskeyJson)
    : null;
}

export function SignIn() {
  const { t } = useT();
  const { state, refresh } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    await refresh();
    navigate("/", { replace: true });
  };

  const fail = (error: unknown) => {
    setStep({ kind: "email" });
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      setError(t("signIn.passkeyCancelled"));
    } else if (error instanceof ApiCallError && error.code === "session_locked") {
      setError(t("signIn.sessionLocked"));
    } else {
      setError(t("signIn.failed"));
    }
  };

  const withPasskey = async (event: FormEvent) => {
    event.preventDefault();
    const support = passkeySupport();
    if (!support) {
      setError(t("signIn.passkeyUnsupported"));
      return;
    }
    setError(null);
    setStep({ kind: "working" });
    try {
      const start = await api<{ options: unknown }>("POST", "/v1/auth/login", {
        step: "start",
        method: "passkey",
        email,
      });
      const credential = (await navigator.credentials.get({
        publicKey: support.parseRequestOptionsFromJSON(start.options),
      })) as (Credential & { toJSON(): unknown }) | null;
      if (!credential) throw new DOMException("", "NotAllowedError");
      await api("POST", "/v1/auth/login", {
        step: "finish",
        method: "passkey",
        email,
        credential: credential.toJSON(),
        client: "web",
      });
      await finish();
    } catch (error) {
      fail(error);
    }
  };

  const withAuthenticator = async () => {
    setError(null);
    setStep({ kind: "working" });
    try {
      const start = await api<{ expires_minutes: number }>("POST", "/v1/auth/login", {
        step: "start",
        method: "authenticator",
        email,
      });
      setStep({ kind: "code", expiresMinutes: start.expires_minutes });
    } catch (error) {
      fail(error);
    }
  };

  const withCodes = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setStep({ kind: "working" });
    try {
      await api("POST", "/v1/auth/login", {
        step: "finish",
        method: "authenticator",
        email,
        email_code: emailCode,
        totp_code: totpCode,
        client: "web",
      });
      await finish();
    } catch (error) {
      fail(error);
    }
  };

  const notice =
    state.status === "signedOut" && state.reason === "locked"
      ? t("signIn.locked")
      : state.status === "signedOut" && state.reason === "expired"
        ? t("signIn.sessionExpired")
        : null;

  return (
    <main className="sign-in" id="main">
      <h1>{t("signIn.title")}</h1>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {step.kind === "working" && (
        <p className="muted" role="status">
          {t("signIn.working")}
        </p>
      )}
      {step.kind === "email" && (
        <form onSubmit={withPasskey}>
          <label>
            <span>{t("signIn.email")}</span>
            <input
              type="email"
              name="email"
              autoComplete="username webauthn"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button type="submit" className="primary">
            {t("signIn.withPasskey")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={email === ""}
            onClick={withAuthenticator}
          >
            {t("signIn.withAuthenticator")}
          </button>
        </form>
      )}
      {step.kind === "code" && (
        <form onSubmit={withCodes}>
          <p className="muted">{t("signIn.codeSent", { email })}</p>
          <label>
            <span>{t("signIn.emailCode")}</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
              value={emailCode}
              onChange={(e) => setEmailCode(e.target.value)}
            />
          </label>
          <label>
            <span>{t("signIn.totpCode")}</span>
            <input
              inputMode="numeric"
              pattern="[0-9]{6}"
              required
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
            />
          </label>
          <button type="submit" className="primary">
            {t("signIn.continue")}
          </button>
          <button type="button" className="secondary" onClick={() => setStep({ kind: "email" })}>
            {t("signIn.back")}
          </button>
        </form>
      )}
      <LanguageSwitch />
    </main>
  );
}

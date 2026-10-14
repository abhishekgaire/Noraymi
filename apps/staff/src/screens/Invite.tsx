import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { makeDeviceKey, pinProblem, type MessageKey, type Role } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useCaptcha } from "../captcha.js";
import { usE164 } from "../us-phone.js";
import { roleKey, useT } from "../i18n.js";
import { storeDevice } from "../device.js";
import { useSession } from "../session.js";
import { LanguageSwitch } from "../layout/LanguageSwitch.js";

/**
 * N25 Set your PIN (M1-23): the invite link on the person's own phone. Confirm
 * the number with a texted code (once), choose a PIN and the language, and the
 * phone becomes their staff_phone. Owners and managers add a passkey too.
 */
interface InvitePage {
  readonly state: "open" | "used" | "replaced" | "expired";
  readonly venue_name: string;
  readonly name: string;
  readonly role: Role;
  readonly pin_digits: 4 | 6;
  readonly locale: "en" | "es";
  readonly phone_verified: boolean;
  readonly needs_passkey: boolean;
  /** How the phone code comes (T-03): by text once the venue's own texts are live, else by email. */
  readonly code_by?: "text" | "email";
}

type Step =
  | { kind: "loading" }
  | { kind: "closed"; why: "used" | "replaced" | "expired" | "invalid" }
  | { kind: "phone" }
  | { kind: "code"; phone: string; email: string | null }
  | { kind: "pin" }
  | { kind: "passkey"; email: string; code: string }
  | { kind: "done"; manager: boolean };

const problemKey: Record<NonNullable<ReturnType<typeof pinProblem>>, MessageKey> = {
  length: "invite.pin.length",
  digits: "invite.pin.digits",
  repeated: "invite.pin.repeated",
  sequential: "invite.pin.sequential",
  common: "invite.pin.common",
};

export function Invite() {
  const { token = "" } = useParams();
  const { t, locale } = useT();
  const { setLocale } = useSession();
  const [page, setPage] = useState<InvitePage | null>(null);
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [pinAgain, setPinAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The security check on the phone-code request (M2-27).
  const captcha = useCaptcha("invite_code");

  useEffect(() => {
    let live = true;
    api<InvitePage>("GET", `/v1/invites/${encodeURIComponent(token)}`)
      .then((p) => {
        if (!live) return;
        setPage(p);
        if (p.state !== "open") setStep({ kind: "closed", why: p.state });
        else setStep(p.phone_verified ? { kind: "pin" } : { kind: "phone" });
        void setLocale(p.locale);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setStep({
          kind: "closed",
          why: e instanceof ApiCallError && e.status === 404 ? "invalid" : "invalid",
        });
      });
    return () => {
      live = false;
    };
    // The invite is read once per token; the language it names is applied then.
  }, [token]);

  const run = async (work: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch {
      setError(t("invite.failed"));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (event: FormEvent) => {
    event.preventDefault();
    // Typed any way ("(929) 739-7310"); the API takes E.164.
    const e164 = usE164(phone);
    if (!e164) {
      setError(t("invite.badPhone"));
      return;
    }
    setPhone(e164);
    void run(async () => {
      let sent: { sent_by?: "text" | "email"; email_hint?: string };
      try {
        sent = await api("POST", `/v1/invites/${encodeURIComponent(token)}/phone`, {
          phone_e164: e164,
          captcha_token: captcha.token ?? "",
        });
      } catch (e) {
        captcha.reset();
        if (e instanceof ApiCallError && e.code === "daily_limit") {
          setError(t("invite.dailyLimit"));
          return;
        }
        if (e instanceof ApiCallError && e.code.startsWith("captcha_")) {
          setError(t("invite.captchaFailed"));
          return;
        }
        // The venue's texts aren't connected and this invite has no email (T-03).
        if (e instanceof ApiCallError && e.details["reason"] === "texts_not_live") {
          setError(t("invite.textsNotLive"));
          return;
        }
        throw e;
      }
      captcha.reset();
      // Until the venue's own texts are live, the code goes to the invite's email (T-03; D123).
      setStep({
        kind: "code",
        phone: e164,
        email: sent.sent_by === "email" ? (sent.email_hint ?? "") : null,
      });
    });
  };

  const verify = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      try {
        await api("POST", `/v1/invites/${encodeURIComponent(token)}/phone/verify`, {
          phone_e164: usE164(phone) ?? phone,
          code,
        });
        setStep({ kind: "pin" });
      } catch (e) {
        if (e instanceof ApiCallError && e.status === 400) setError(t("invite.wrongCode"));
        else throw e;
      }
    });
  };

  const finish = (event: FormEvent) => {
    event.preventDefault();
    if (!page) return;
    const problem = pinProblem(pin, page.pin_digits);
    if (problem) {
      setError(t(problemKey[problem], { count: page.pin_digits }));
      return;
    }
    if (pin !== pinAgain) {
      setError(t("invite.pinMismatch"));
      return;
    }
    void run(async () => {
      const key = await makeDeviceKey();
      const done = await api<{
        venue_id: string;
        device_id: string | null;
        email: string | null;
        enrol_code: string | null;
      }>("POST", `/v1/invites/${encodeURIComponent(token)}/finish`, {
        pin,
        locale,
        public_key: key.publicJwk,
        phone_name: phoneName(),
      });
      setPin("");
      setPinAgain("");
      if (done.device_id)
        await storeDevice({
          deviceId: done.device_id,
          venueId: done.venue_id,
          kind: "staff_phone",
          name: phoneName(),
          privateKey: key.privateKey,
          pinDigits: page.pin_digits,
          venue: null,
        });
      if (done.enrol_code && done.email)
        setStep({ kind: "passkey", email: done.email, code: done.enrol_code });
      else setStep({ kind: "done", manager: false });
    });
  };

  const addPasskey = (email: string, enrolCode: string) =>
    void run(async () => {
      const ctor = (
        globalThis as {
          PublicKeyCredential?: {
            parseCreationOptionsFromJSON?: (o: unknown) => PublicKeyCredentialCreationOptions;
          };
        }
      ).PublicKeyCredential;
      if (!ctor?.parseCreationOptionsFromJSON) {
        setError(t("signIn.passkeyUnsupported"));
        return;
      }
      const start = await api<{ options: unknown }>("POST", "/v1/auth/enroll", {
        step: "passkey_options",
        email,
        code: enrolCode,
      });
      const credential = (await navigator.credentials.create({
        publicKey: ctor.parseCreationOptionsFromJSON(start.options),
      })) as (Credential & { toJSON(): unknown }) | null;
      if (!credential) throw new Error("cancelled");
      await api("POST", "/v1/auth/enroll", {
        step: "passkey_finish",
        email,
        code: enrolCode,
        credential: credential.toJSON(),
        name: phoneName(),
        client: "web",
      });
      setStep({ kind: "done", manager: true });
    });

  return (
    <main className="sign-in invite" id="main">
      <h1>{page ? t("invite.title", { venue: page.venue_name }) : t("shell.loading")}</h1>
      {page && step.kind !== "closed" && (
        <p className="muted">
          {t("invite.hello", { name: page.name, role: t(roleKey[page.role]) })}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {step.kind === "closed" && (
        <p className="notice" role="status">
          {step.why === "used"
            ? t("invite.used")
            : step.why === "replaced"
              ? t("invite.replaced")
              : step.why === "expired"
                ? t("invite.expired")
                : t("invite.invalid")}
        </p>
      )}
      {step.kind === "phone" && (
        <form onSubmit={sendCode}>
          <label>
            <span>{t("invite.phone")}</span>
            <input
              type="tel"
              name="phone"
              autoComplete="tel"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          <p className="muted">
            {t(page?.code_by === "email" ? "invite.phoneHintEmail" : "invite.phoneHint")}
          </p>
          {captcha.widget}
          <button type="submit" className="primary" disabled={busy || !captcha.token}>
            {t(page?.code_by === "email" ? "invite.emailCode" : "invite.sendCode")}
          </button>
        </form>
      )}
      {step.kind === "code" && (
        <form onSubmit={verify}>
          <p className="muted">
            {step.email !== null
              ? t("invite.codeEmailed", { email: step.email })
              : t("invite.codeSent", { phone: step.phone })}
          </p>
          <label>
            <span>{t(step.email !== null ? "invite.codeFromEmail" : "invite.code")}</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {t("invite.confirm")}
          </button>
          <button type="button" className="secondary" onClick={() => setStep({ kind: "phone" })}>
            {t("signIn.back")}
          </button>
        </form>
      )}
      {step.kind === "pin" && page && (
        <form onSubmit={finish}>
          <h2>{t("invite.choosePin")}</h2>
          <p className="muted">
            {page.pin_digits === 6 ? t("invite.pinHint.6") : t("invite.pinHint.4")}
          </p>
          <label>
            <span>{t("invite.choosePin")}</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={page.pin_digits}
              required
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </label>
          <label>
            <span>{t("invite.pinAgain")}</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={page.pin_digits}
              required
              value={pinAgain}
              onChange={(e) => setPinAgain(e.target.value)}
            />
          </label>
          <LanguageSwitch />
          <button type="submit" className="primary" disabled={busy}>
            {t("invite.setPin")}
          </button>
        </form>
      )}
      {step.kind === "passkey" && (
        <section>
          <h2>{t("invite.passkeyTitle")}</h2>
          <p className="muted">{t("invite.passkeyHint")}</p>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => addPasskey(step.email, step.code)}
          >
            {t("invite.addPasskey")}
          </button>
        </section>
      )}
      {step.kind === "done" && (
        <section>
          <p className="notice" role="status">
            {page?.role === "owner"
              ? t("invite.doneOwner")
              : step.manager
                ? t("invite.doneManager")
                : t("invite.done")}
          </p>
          <Link to="/sign-in" className="button secondary">
            {t("invite.goSignIn")}
          </Link>
        </section>
      )}
    </main>
  );
}

function phoneName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Phone";
}

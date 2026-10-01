import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Temporal, type Role } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useClock } from "../clock.js";
import {
  claimDevice,
  isShared,
  readDevice,
  signedApi,
  syncClock,
  type StoredDevice,
} from "../device.js";
import { roleKey, useT } from "../i18n.js";
import { useSession } from "../session.js";
import { LanguageSwitch } from "../layout/LanguageSwitch.js";
import { Keypad } from "./Keypad.js";

/**
 * The Pin screen (M1-26): on a paired bar or front-desk computer, a badge
 * tap (the reader is M1-30) or a name tile then the PIN pad; on a person's
 * own phone, their PIN; in a plain browser, an owner or manager's passkey or
 * authenticator app, or the code that pairs the screen. "Badge or name and
 * PIN" everywhere; refunds, cash counts and no-sale ask for the PIN again;
 * Admin needs a passkey.
 */
interface Tile {
  readonly membership_id: string;
  readonly name: string;
  readonly role: Role;
  readonly locale: "en" | "es";
  readonly has_pin: boolean;
}

interface TilesAnswer {
  readonly tiles: Tile[];
  readonly venue: { id: string; name: string; time_zone: string; day_cutover: string };
  readonly server_time: string;
}

type Step =
  | { readonly kind: "email" }
  | { readonly kind: "code"; readonly expiresMinutes: number }
  | { readonly kind: "pair" }
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

const pinDigits = (role: Role): 4 | 6 => (role === "owner" || role === "manager" ? 6 : 4);

export function SignIn() {
  const { t, time, locale } = useT();
  const { state, refresh, setLocale, signInWithPin, signInWithBadge } = useSession();
  const clock = useClock();
  const navigate = useNavigate();
  const [device, setDevice] = useState<StoredDevice | null | undefined>(undefined);
  const [tiles, setTiles] = useState<TilesAnswer | null>(null);
  const [chosen, setChosen] = useState<Tile | null>(null);
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wallTime, setWallTime] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [ownerForm, setOwnerForm] = useState(false);

  // What this screen is, and the venue's clock for it.
  useEffect(() => {
    let live = true;
    void (async () => {
      const found = await readDevice();
      if (!live) return;
      setDevice(found);
      if (isShared(found)) {
        try {
          await syncClock();
          const answer = await signedApi<TilesAnswer>(
            found,
            "GET",
            `/v1/venues/${found.venueId}/team/tiles`,
          );
          if (!live) return;
          setTiles(answer);
          clock.sync(answer.server_time);
        } catch {
          if (live) setError(t("shell.error.cantReach"));
        }
      } else {
        // No venue yet: the server's own wall clock, never the device's.
        try {
          const health = await api<{ server_time: string }>("GET", "/v1/health");
          if (live) setWallTime(health.server_time);
        } catch {
          // The time line simply stays empty.
        }
      }
    })();
    return () => {
      live = false;
    };
    // Once per load: the device and the tiles don't change under the screen.
  }, []);

  const finish = async () => {
    await refresh();
    navigate("/", { replace: true });
  };

  const failPin = (e: unknown) => {
    if (e instanceof ApiCallError && e.status === 429) {
      const seconds = /(\d+)/.exec(e.message)?.[1] ?? "60";
      setError(t("signIn.lockedFor", { seconds: Number(seconds) }));
    } else if (e instanceof ApiCallError && e.status === 403 && /paused/.test(e.message)) {
      setError(t("signIn.paused"));
    } else {
      setError(t("signIn.failed"));
    }
  };

  // The PIN pad submits by itself when the PIN is complete.
  const digits = chosen ? pinDigits(chosen.role) : device?.kind === "staff_phone" ? 6 : 4;
  useEffect(() => {
    if (!device || busy) return;
    const shared = isShared(device);
    const needed = shared
      ? chosen
        ? pinDigits(chosen.role)
        : 0
      : pin.length >= 4
        ? pin.length
        : 0;
    if (shared && (!chosen || pin.length !== needed)) return;
    if (!shared && pin.length < 4) return;
    if (!shared && pin.length < 6 && pin.length !== 4) return;
    const submit = async () => {
      setBusy(true);
      setError(null);
      try {
        await signInWithPin(device, {
          ...(chosen ? { membershipId: chosen.membership_id } : {}),
          pin,
        });
        await finish();
      } catch (e) {
        setPin("");
        failPin(e);
      } finally {
        setBusy(false);
      }
    };
    void submit();
    // Runs when the PIN reaches its length.
  }, [pin]);

  // A badge on the reader takes over at once, whoever's tile is open.
  useEffect(() => {
    const shared = device ?? null;
    if (!isShared(shared) || !window.west4) return;
    return window.west4.badge.onTap(({ url }) => {
      setBusy(true);
      setError(null);
      setStatusLine(t("badge.signingIn"));
      signInWithBadge(shared, url)
        .then(() => finish())
        .catch(() => setError(t("badge.failed")))
        .finally(() => {
          setBusy(false);
          setStatusLine(null);
        });
    });
    // The subscription lives as long as the paired screen is on the sign-in page.
  }, [device, signInWithBadge, t]);

  const choose = (tile: Tile) => {
    setChosen(tile);
    setPin("");
    setError(null);
    // The pad speaks the person's own language (spec 02 · Languages).
    if (tile.locale !== locale) void setLocale(tile.locale);
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
    } catch (e) {
      setStep({ kind: "email" });
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? t("signIn.passkeyCancelled")
          : t("signIn.failed"),
      );
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
    } catch {
      setStep({ kind: "email" });
      setError(t("signIn.failed"));
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
    } catch {
      setStep({ kind: "email" });
      setError(t("signIn.failed"));
    }
  };

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const paired = await claimDevice(pairCode.trim());
      setDevice(paired);
      setStep({ kind: "email" });
      await syncClock();
      const answer = await signedApi<TilesAnswer>(
        paired,
        "GET",
        `/v1/venues/${paired.venueId}/team/tiles`,
      );
      setTiles(answer);
      clock.sync(answer.server_time);
    } catch {
      setError(t("signIn.pairFailed"));
    } finally {
      setBusy(false);
    }
  };

  const notice =
    state.status === "signedOut" && state.reason === "locked"
      ? t("signIn.locked")
      : state.status === "signedOut" && state.reason === "expired"
        ? t("signIn.sessionExpired")
        : null;

  const clockLine = tiles
    ? time(clock.now ?? tiles.server_time, tiles.venue.time_zone)
    : wallTime
      ? time(Temporal.PlainDateTime.from(wallTime).toZonedDateTime("UTC").toInstant(), "UTC")
      : null;

  if (device === undefined) {
    return (
      <main className="sign-in" id="main">
        <p role="status">{t("shell.loading")}</p>
      </main>
    );
  }

  // --- A paired bar or front-desk computer: badge, or a name tile then the PIN pad.
  // An owner or manager opens Admin here with the passkey form below instead.
  if (isShared(device) && !ownerForm) {
    return (
      <main className="sign-in shared" id="main">
        <header className="sign-in-top">
          <h1>{t("signIn.staff.title")}</h1>
          <div className="clock-line">
            {clockLine && <time>{clockLine}</time>}
            <span className="muted">{tiles?.venue.name ?? device.venue?.name ?? ""}</span>
          </div>
        </header>
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
        {statusLine && (
          <p className="notice" role="status">
            {statusLine}
          </p>
        )}
        {!chosen && (
          <>
            <p className="badge-line">{t("signIn.tapBadge")}</p>
            <p className="muted">{t("signIn.noBadge")}</p>
            <ul className="tiles" aria-label={t("signIn.noBadge")}>
              {(tiles?.tiles ?? [])
                .filter((tile) => tile.has_pin)
                .map((tile) => (
                  <li key={tile.membership_id}>
                    <button type="button" className="tile" onClick={() => choose(tile)}>
                      <span className="tile-name">{tile.name}</span>
                      <span className="tile-role">{t(roleKey[tile.role])}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </>
        )}
        {chosen && (
          <section className="pin-entry" aria-label={t("signIn.pinFor", { name: chosen.name })}>
            <p className="pin-for">{t("signIn.pinFor", { name: chosen.name })}</p>
            <Keypad digits={pinDigits(chosen.role)} value={pin} onChange={setPin} disabled={busy} />
            <button type="button" className="secondary" onClick={() => setChosen(null)}>
              {t("signIn.back")}
            </button>
          </section>
        )}
        <footer className="sign-in-foot">
          <p className="muted small">{t("signIn.pinAgainRule")}</p>
          <button type="button" className="secondary" onClick={() => setOwnerForm(true)}>
            {t("signIn.ownerWeb")}
          </button>
          <LanguageSwitch />
        </footer>
      </main>
    );
  }

  // --- A person's own phone: their PIN.
  if (device?.kind === "staff_phone") {
    return (
      <main className="sign-in phone" id="main">
        <h1>{t("signIn.title")}</h1>
        {clockLine && <p className="muted">{clockLine}</p>}
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
        <section className="pin-entry" aria-label={t("signIn.yourPin")}>
          <p className="pin-for">{t("signIn.yourPin")}</p>
          <Keypad digits={digits} value={pin} onChange={setPin} disabled={busy} />
        </section>
        <p className="muted small">{t("signIn.pinAgainRule")}</p>
        <LanguageSwitch />
      </main>
    );
  }

  // --- A plain browser: an owner or manager's passkey or authenticator app, or pairing this screen.
  return (
    <main className="sign-in" id="main">
      <h1>{t("signIn.title")}</h1>
      {clockLine && <p className="muted">{clockLine}</p>}
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
          <p className="muted">{t("signIn.ownerWeb")}</p>
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
          <p className="muted small">{t("signIn.staffHere")}</p>
          {isShared(device) ? (
            <button type="button" className="secondary" onClick={() => setOwnerForm(false)}>
              {t("signIn.back")}
            </button>
          ) : (
            <button type="button" className="secondary" onClick={() => setStep({ kind: "pair" })}>
              {t("signIn.pairScreen")}
            </button>
          )}
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
      {step.kind === "pair" && (
        <form onSubmit={pair}>
          <label>
            <span>{t("signIn.pairCode")}</span>
            <input
              name="code"
              autoComplete="off"
              required
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {t("signIn.pair")}
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

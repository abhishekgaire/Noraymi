import { useCallback, useEffect, useState, type FormEvent } from "react";
import { t, type Locale, type MessageKey } from "@west4/shared";
import { SupportAccess } from "./SupportAccess.js";
import { EmergencyActions } from "./EmergencyActions.js";
import { Pages } from "./Pages.js";
import { api, ConsoleApiError } from "./api.js";

/**
 * The minimal Console (M1-35): our own staff's tool on its own hostname.
 * Sign-in is single sign-on, then a FIDO2 security key. Then a read-only
 * venue list with device health, and per venue the module allow-list and the
 * venue flags. Internal tool: English only; module names come from the shared
 * catalog so they match Admin → Features word for word (Console note 5).
 */
const locale: Locale = "en";

interface Staff {
  id: string;
  name: string;
  email: string;
}

interface Health {
  tablets: { online: number; total: number };
  readers: { online: number; total: number };
  router: { online: boolean; backup_internet: "on" | "off" | null; on_backup_now: boolean } | null;
  devices: { online: number; total: number };
}

interface VenueSummary {
  id: string;
  name: string;
  slug: string;
  time_zone: string;
  health: Health;
  /** The go-live checklist (M4-29): the same rows as Admin → Payments. */
  go_live?: { passes: boolean; merchant_category: { status: string } };
}

interface VenueDetail {
  venue: VenueSummary;
  health: Health;
  modules: {
    id: string;
    allowed: boolean;
    state: "on" | "stopping" | "off";
    core: boolean;
    phase1: boolean;
  }[];
  flags: Record<string, boolean>;
}

type Screen =
  | { kind: "loading" }
  | { kind: "signedOut"; sso: "oidc" | "local" | null; step: "sso" | "key"; error: string | null }
  | {
      kind: "venues";
      staff: Staff;
      venues: VenueSummary[] | null;
      open: VenueDetail | null;
      error: string | null;
    };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const me = await api<{ staff: Staff }>("GET", "/v1/console/auth/me");
      setScreen({ kind: "venues", staff: me.staff, venues: null, open: null, error: null });
      const list = await api<{ venues: VenueSummary[] }>("GET", "/v1/console/venues");
      setScreen((s) => (s.kind === "venues" ? { ...s, venues: list.venues } : s));
    } catch {
      const config = await api<{ sso: "oidc" | "local" }>("GET", "/v1/console/auth/config").catch(
        () => null,
      );
      const params = new URLSearchParams(window.location.search);
      const error = params.get("error");
      setScreen({
        kind: "signedOut",
        sso: config?.sso ?? null,
        step: window.location.hash === "#key" ? "key" : "sso",
        error: error ? `Single sign-on didn't finish (${error})` : null,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (screen.kind === "loading") {
    return (
      <main className="console">
        <h1>Console</h1>
        <p role="status">Loading…</p>
      </main>
    );
  }
  if (screen.kind === "signedOut") {
    return <SignIn screen={screen} onSignedIn={load} />;
  }
  return <Venues screen={screen} setScreen={setScreen} onSignOut={load} />;
}

function SignIn({
  screen,
  onSignedIn,
}: {
  screen: Extract<Screen, { kind: "signedOut" }>;
  onSignedIn: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"sso" | "key">(screen.step);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(screen.error);

  const local = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/v1/console/auth/local", { email: email.trim() });
      setStep("key");
    } catch (err) {
      setError(err instanceof ConsoleApiError ? err.message : "Couldn't sign in");
    } finally {
      setBusy(false);
    }
  };

  const key = async () => {
    setBusy(true);
    setError(null);
    try {
      const start = await api<{ mode: "register" | "login"; options: unknown }>(
        "POST",
        "/v1/console/auth/key",
        { step: "start" },
      );
      const PKC = (
        window as unknown as {
          PublicKeyCredential?: {
            parseCreationOptionsFromJSON?: (o: unknown) => PublicKeyCredentialCreationOptions;
            parseRequestOptionsFromJSON?: (o: unknown) => PublicKeyCredentialRequestOptions;
          };
        }
      ).PublicKeyCredential;
      if (!PKC?.parseCreationOptionsFromJSON || !PKC.parseRequestOptionsFromJSON)
        throw new Error("This browser can't use security keys");
      const credential = (
        start.mode === "register"
          ? await navigator.credentials.create({
              publicKey: PKC.parseCreationOptionsFromJSON(start.options),
            })
          : await navigator.credentials.get({
              publicKey: PKC.parseRequestOptionsFromJSON(start.options),
            })
      ) as (Credential & { toJSON(): unknown }) | null;
      if (!credential) throw new Error("The security key prompt was closed");
      await api("POST", "/v1/console/auth/key", {
        step: "finish",
        credential: credential.toJSON(),
        name: start.mode === "register" ? "Security key" : undefined,
      });
      window.history.replaceState(null, "", "/");
      await onSignedIn();
    } catch (err) {
      setError(
        err instanceof ConsoleApiError
          ? err.status === 401
            ? "Sign in with single sign-on first"
            : err.message
          : err instanceof Error
            ? err.message
            : "The security key didn't work",
      );
      if (err instanceof ConsoleApiError && err.status === 401) setStep("sso");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="console narrow">
      <h1>Console</h1>
      <p className="muted">Our staff only. Single sign-on, then your FIDO2 security key.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {step === "sso" ? (
        screen.sso === "local" ? (
          <form onSubmit={(e) => void local(e)}>
            <label>
              <span>Work email</span>
              <input
                type="email"
                value={email}
                required
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <p className="muted small">
              Local development: the email stands in for single sign-on.
            </p>
            <button type="submit" className="primary" disabled={busy}>
              Continue
            </button>
          </form>
        ) : (
          <a className="button primary" href="/v1/console/auth/sso/start">
            Sign in with single sign-on
          </a>
        )
      ) : (
        <div>
          <p>Step 2 of 2: touch your security key.</p>
          <button type="button" className="primary" disabled={busy} onClick={() => void key()}>
            Use your security key
          </button>
        </div>
      )}
    </main>
  );
}

function healthLine(h: Health): string {
  const parts = [
    `${h.tablets.online} of ${h.tablets.total} room tablets online`,
    `${h.readers.online} of ${h.readers.total} readers online`,
  ];
  if (h.router) {
    parts.push(
      h.router.backup_internet === "on"
        ? h.router.on_backup_now
          ? "Backup internet · on · in use now"
          : "Backup internet · on"
        : h.router.backup_internet === "off"
          ? "Backup internet · off"
          : h.router.online
            ? "Router online"
            : "Router offline",
    );
  }
  return parts.join(" · ");
}

function Venues({
  screen,
  setScreen,
  onSignOut,
}: {
  screen: Extract<Screen, { kind: "venues" }>;
  setScreen: (s: Screen | ((s: Screen) => Screen)) => void;
  onSignOut: () => Promise<void>;
}) {
  const [flagName, setFlagName] = useState("");
  const [busy, setBusy] = useState(false);

  const openVenue = async (id: string) => {
    try {
      const detail = await api<VenueDetail>("GET", `/v1/console/venues/${id}`);
      setScreen((s) => (s.kind === "venues" ? { ...s, open: detail, error: null } : s));
    } catch (e) {
      setScreen((s) =>
        s.kind === "venues"
          ? { ...s, error: e instanceof Error ? e.message : "Couldn't open it" }
          : s,
      );
    }
  };

  const change = async (run: () => Promise<void>) => {
    if (!screen.open) return;
    setBusy(true);
    try {
      await run();
      await openVenue(screen.open.venue.id);
    } catch (e) {
      setScreen((s) =>
        s.kind === "venues" ? { ...s, error: e instanceof Error ? e.message : "Refused" } : s,
      );
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await api("POST", "/v1/console/auth/logout", {}).catch(() => {});
    await onSignOut();
  };

  const open = screen.open;
  return (
    <main className="console app">
      <header className="bar">
        <h1>Console</h1>
        <nav className="rail-nav" aria-label="Console">
          <a href="#venues">Venues</a>
          <a href="#pages">Pages</a>
          <a href="#rule-packs">Rule packs</a>
        </nav>
        <span className="staff-card">
          {screen.staff.name} · {screen.staff.email}
        </span>
        <button type="button" className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      {screen.error && (
        <p className="error" role="alert">
          {screen.error}
        </p>
      )}
      <Pages />
      <div className="columns">
        <section id="venues">
          <h2>Venues</h2>
          {screen.venues === null ? (
            <p role="status">Loading…</p>
          ) : (
            <ul className="venue-list">
              {screen.venues.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className={open?.venue.id === v.id ? "venue active" : "venue"}
                    onClick={() => void openVenue(v.id)}
                  >
                    <span className="venue-name">{v.name}</span>
                    <span className="muted small">{healthLine(v.health)}</span>
                    {v.go_live && (
                      <span className="muted small">
                        {v.go_live.passes
                          ? t("en", "console.goLive.passes")
                          : t("en", "console.goLive.notYet", {
                              merchant: t(
                                "en",
                                `console.goLive.merchant.${v.go_live.merchant_category.status}` as MessageKey,
                              ),
                            })}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {open && (
          <section>
            <h2>{open.venue.name}</h2>
            <p className="muted small">{healthLine(open.health)}</p>
            <h3>Modules</h3>
            <p className="muted small">
              Allowed by the plan and add-ons. The venue switches an allowed module on or off in
              Admin → Features; one it has on can't be taken away until it's off.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Venue state</th>
                  <th>Allowed</th>
                </tr>
              </thead>
              <tbody>
                {open.modules
                  .filter((m) => m.phase1)
                  .map((m) => (
                    <tr key={m.id}>
                      <td>{t(locale, `module.${m.id}.name` as MessageKey)}</td>
                      <td>
                        {m.core ? "Always on" : t(locale, `modules.state.${m.state}` as MessageKey)}
                      </td>
                      <td>
                        {m.core ? (
                          <span className="muted">Core</span>
                        ) : (
                          <label className="switch">
                            <input
                              type="checkbox"
                              aria-label={`${t(locale, `module.${m.id}.name` as MessageKey)} allowed`}
                              checked={m.allowed}
                              disabled={busy}
                              onChange={(e) =>
                                void change(() =>
                                  api(
                                    "PATCH",
                                    `/v1/console/venues/${open.venue.id}/modules/${m.id}`,
                                    {
                                      allowed: e.target.checked,
                                    },
                                  ),
                                )
                              }
                            />
                            <span>{m.allowed ? "Allowed" : "Not in the plan"}</span>
                          </label>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <h3>Venue flags</h3>
            <p className="muted small">Beta and rollout switches. Our own test venue goes first.</p>
            {Object.keys(open.flags).length === 0 ? (
              <p className="muted">No flags set</p>
            ) : (
              <ul className="flag-list">
                {Object.entries(open.flags).map(([flag, on]) => (
                  <li key={flag}>
                    <label className="switch">
                      <input
                        type="checkbox"
                        aria-label={`${flag} on`}
                        checked={on}
                        disabled={busy}
                        onChange={(e) =>
                          void change(() =>
                            api("PUT", `/v1/console/venues/${open.venue.id}/flags/${flag}`, {
                              on: e.target.checked,
                            }),
                          )
                        }
                      />
                      <code>{flag}</code>
                      <span className="muted">{on ? "on" : "off"}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                const flag = flagName.trim();
                if (!flag) return;
                void change(() =>
                  api("PUT", `/v1/console/venues/${open.venue.id}/flags/${flag}`, { on: true }),
                ).then(() => setFlagName(""));
              }}
            >
              <label>
                <span>New flag</span>
                <input
                  value={flagName}
                  pattern="[a-z][a-z0-9_.\-]{1,63}"
                  placeholder="beta.room_screen"
                  onChange={(e) => setFlagName(e.target.value)}
                />
              </label>
              <button type="submit" className="secondary" disabled={busy}>
                Turn on
              </button>
            </form>
            <SupportAccess key={open.venue.id} venue={open.venue} />
            <EmergencyActions
              key={`emergency-${open.venue.id}`}
              venue={open.venue}
              staffId={screen.staff.id}
            />
          </section>
        )}
      </div>
      <RulePacks />
    </main>
  );
}

interface PackSummary {
  id: string;
  versions: { version: string; effective_on: string }[];
  latest: Record<string, unknown> | null;
}
interface Draft {
  id: string;
  pack_id: string;
  version: string;
  effective_on: string;
  data: Record<string, unknown>;
  approvers: string[];
  published_at: string | null;
}

/**
 * Rule packs (M1-36; spec 12 · 11): a new version is a draft with its data
 * and the business date it starts on; two different people approve it; then
 * the key service signs it and it publishes. One approval never publishes.
 */
function RulePacks() {
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [packId, setPackId] = useState("");
  const [version, setVersion] = useState("");
  const [effectiveOn, setEffectiveOn] = useState("");
  const [data, setData] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const answer = await api<{ packs: PackSummary[]; drafts: Draft[] }>(
      "GET",
      "/v1/console/rule-packs",
    );
    setPacks(answer.packs);
    setDrafts(answer.drafts);
    setPackId((p) => p || answer.packs[0]?.id || "");
  }, []);
  useEffect(() => {
    load().catch(() => setMessage({ kind: "error", text: "Couldn't load the rule packs" }));
  }, [load]);

  const pack = packs?.find((p) => p.id === packId) ?? null;
  const prefill = () => {
    if (!pack?.latest) return;
    setData(JSON.stringify({ ...pack.latest, version }, null, 2));
  };

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await work();
      await load();
      setMessage({ kind: "ok", text });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : "Refused" });
    } finally {
      setBusy(false);
    }
  };

  const propose = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        throw new Error("The data isn't valid JSON");
      }
      parsed = { ...parsed, id: packId, version };
      await api("POST", "/v1/console/rule-packs/drafts", {
        effective_on: effectiveOn,
        data: parsed,
      });
      setVersion("");
      setEffectiveOn("");
      setData("");
      return `Draft ${packId} ${version} saved · it needs two approvals`;
    });
  };

  const waiting = drafts.filter((d) => !d.published_at);
  return (
    <section className="rule-packs" id="rule-packs">
      <h2>Rule packs</h2>
      <p className="muted small">
        Versioned limits for a place: the tax table, the alcohol window, wage rules. Two people
        approve a version, it's signed, and the venues on it see what changes before it applies at
        the first 6:00 AM on or after its date.
      </p>
      {message && (
        <p className={message.kind === "error" ? "error" : "small"} role="status">
          {message.text}
        </p>
      )}
      {packs === null ? (
        <p role="status">Loading…</p>
      ) : (
        <div className="columns">
          <div>
            <h3>Published</h3>
            {packs.map((p) => (
              <p key={p.id}>
                <strong>{p.id}</strong>
                <br />
                <span className="muted small">
                  {p.versions.map((v) => `${v.version} from ${v.effective_on}`).join(" · ")}
                </span>
              </p>
            ))}
            <h3>Drafts</h3>
            {waiting.length === 0 ? (
              <p className="muted">No drafts waiting</p>
            ) : (
              <ul className="flag-list">
                {waiting.map((d) => (
                  <li key={d.id} className="draft">
                    <div>
                      <strong>
                        {d.pack_id} {d.version}
                      </strong>{" "}
                      <span className="muted small">from {d.effective_on}</span>
                      <br />
                      <span className="muted small">
                        {d.approvers.length === 0
                          ? "No approvals yet"
                          : `Approved by ${d.approvers.join(" and ")}`}
                        {d.approvers.length < 2 ? ` · ${2 - d.approvers.length} more needed` : ""}
                      </span>
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const r = await api<{ approvers: string[] }>(
                              "POST",
                              `/v1/console/rule-packs/drafts/${d.id}/approve`,
                              {},
                            );
                            return `Approved · ${r.approvers.length} of 2`;
                          })
                        }
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy || d.approvers.length < 2}
                        onClick={() =>
                          void run(async () => {
                            const r = await api<{ version: string; effective_on: string }>(
                              "POST",
                              `/v1/console/rule-packs/drafts/${d.id}/publish`,
                              {},
                            );
                            return `Published ${r.version} · applies from ${r.effective_on}`;
                          })
                        }
                      >
                        Sign and publish
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <form onSubmit={propose}>
            <h3>New version</h3>
            <label>
              <span>Pack</span>
              <select value={packId} onChange={(e) => setPackId(e.target.value)}>
                {packs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Version</span>
              <input
                value={version}
                required
                placeholder="2026.10"
                onChange={(e) => setVersion(e.target.value)}
              />
            </label>
            <label>
              <span>Starts on (business date)</span>
              <input
                type="date"
                value={effectiveOn}
                required
                onChange={(e) => setEffectiveOn(e.target.value)}
              />
            </label>
            <label>
              <span>Data (JSON)</span>
              <textarea
                value={data}
                required
                rows={12}
                spellCheck={false}
                onChange={(e) => setData(e.target.value)}
              />
            </label>
            <div className="row">
              <button
                type="button"
                className="secondary"
                disabled={!pack?.latest}
                onClick={prefill}
              >
                Start from the latest
              </button>
              <button type="submit" className="primary" disabled={busy}>
                Save the draft
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

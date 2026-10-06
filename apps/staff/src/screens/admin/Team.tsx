import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  localeNames,
  locales,
  roles,
  type Locale,
  type MessageKey,
  type MessageParams,
  type Role,
} from "@west4/shared";
import { api, stepUpToken, type ApiCallError } from "../../api.js";
import { readDevice } from "../../device.js";
import { roleKey, useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Team (M1-31, owner only; spec 02 · Roles, Languages, Offboarding;
 * AdminDesk notes 4, 5, 6 and 8). Each person with their role, invite state,
 * language and badges; invite, PIN reset and deactivate; and the switch for
 * the front desk using the bar POS when covering the bar. Role and language
 * changes go through `PATCH /team/{m}`, which asks for the passkey again.
 * Badges (M1-30) pair on the bar or front-desk computer's USB reader.
 * Training mode (M7-03): per person here, and per device for a new hire's
 * first shifts (`PATCH /devices/{d}`), with the screens it applies to showing
 * the band at once. Tip eligibility comes in M7.
 */
interface Badge {
  readonly id: string;
  readonly label: string;
  readonly disabled_at: string | null;
}

interface Person {
  readonly membership_id: string;
  readonly name: string;
  readonly email: string | null;
  readonly role: Role;
  readonly status: "invited" | "active" | "deactivated";
  readonly locale: Locale;
  readonly training: boolean;
  readonly has_pin: boolean;
  readonly invite_expires_at: string | null;
  readonly badges: readonly Badge[];
}

/** A phone or shared screen that can be put in training (M7-03). */
interface TrainingDevice {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly training: boolean;
  readonly revoked_at: string | null;
}
const TRAINING_KINDS = new Set(["bar_computer", "front_desk", "staff_phone"]);

interface PermissionRow {
  readonly action: string;
  readonly front_desk: boolean;
}

type Pairing = { membershipId: string; step: "waiting" | "programming" } | null;
/** Notes keep their catalog key, not a translated string, so a language switch re-renders them. */
type Message = { readonly key: MessageKey; readonly params?: MessageParams };
type Note = ({ readonly membershipId: string } & Message) | null;

const FRONT_DESK_BAR_ACTIONS = ["pos.use", "orders.accept"] as const;

export function Team() {
  const { t, time } = useT();
  const { state } = useSession();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const myMembership = signedIn?.membership.membership_id ?? "";
  const allowed = signedIn?.membership.permissions.includes("admin.team") ?? false;

  const [people, setPeople] = useState<Person[] | null>(null);
  const [devices, setDevices] = useState<TrainingDevice[] | null>(null);
  const [frontDeskBar, setFrontDeskBar] = useState<boolean | null>(null);
  const [readers, setReaders] = useState<string[]>([]);
  const [pairing, setPairing] = useState<Pairing>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [error, setError] = useState<string | null>(null);
  const shell = typeof window === "undefined" ? undefined : window.west4;
  const device = useDeviceKind();

  const load = useCallback(async () => {
    const [team, permissions, paired] = await Promise.all([
      api<{ people: Person[] }>("GET", `/v1/venues/${venueId}/team`),
      api<{ rows: PermissionRow[] }>("GET", `/v1/venues/${venueId}/permissions`),
      api<{ devices: TrainingDevice[] }>("GET", `/v1/venues/${venueId}/devices`),
    ]);
    setPeople(team.people);
    setDevices(paired.devices.filter((d) => TRAINING_KINDS.has(d.kind) && !d.revoked_at));
    setFrontDeskBar(permissions.rows.find((r) => r.action === "pos.use")?.front_desk ?? true);
  }, [venueId]);

  useEffect(() => {
    if (!venueId || !allowed) return;
    load().catch(() => setError(t("shell.error.cantReach")));
  }, [venueId, allowed, load, t]);

  useEffect(() => {
    if (!shell) return;
    void shell.readers().then((list) => setReaders(list.map((r) => r.name)));
    return shell.badge.onReaders((list) => setReaders(list.map((r) => r.name)));
  }, [shell]);

  /** Every change to a person asks for the passkey again, then refetches the list. */
  const change = async (
    membershipId: string,
    run: (stepUp: string) => Promise<Message | null>,
  ): Promise<void> => {
    setError(null);
    setNote(null);
    setBusy(membershipId);
    try {
      const message = await run(await stepUpToken());
      await load();
      setNote({ membershipId, ...(message ?? { key: "team.changed" }) });
    } catch (e) {
      const code = (e as ApiCallError)?.code;
      setError(
        code === "step_up_required" || code === "cancelled" || code === "passkey_unsupported"
          ? t("stepUp.needed")
          : ((e as ApiCallError)?.message ?? t("shell.error.title")),
      );
    } finally {
      setBusy(null);
    }
  };

  const sentBy = (by: "text" | "email" | null): Message => ({
    key:
      by === "text"
        ? "team.linkSent.text"
        : by === "email"
          ? "team.linkSent.email"
          : "team.pinCleared",
  });

  const setRole = (person: Person, role: Role) =>
    change(person.membership_id, async (stepUp) => {
      const r = await api<{ pin_reset_sent_by: "text" | "email" | null }>(
        "PATCH",
        `/v1/venues/${venueId}/team/${person.membership_id}`,
        { role },
        { stepUp },
      );
      // Between 4 and 6 digits the old PIN no longer fits: say where the new link went.
      const digitsChanged = pinDigits(role) !== pinDigits(person.role);
      return digitsChanged && person.status === "active" ? sentBy(r.pin_reset_sent_by) : null;
    });

  const setLanguage = (person: Person, locale: Locale) =>
    change(person.membership_id, async (stepUp) => {
      await api(
        "PATCH",
        `/v1/venues/${venueId}/team/${person.membership_id}`,
        { locale },
        { stepUp },
      );
      return null;
    });

  const setTraining = (person: Person, training: boolean) =>
    change(person.membership_id, async (stepUp) => {
      await api(
        "PATCH",
        `/v1/venues/${venueId}/team/${person.membership_id}`,
        { training },
        { stepUp },
      );
      return null;
    });

  const setDeviceTraining = async (device: TrainingDevice, training: boolean) => {
    setError(null);
    setBusy(device.id);
    try {
      await api("PATCH", `/v1/venues/${venueId}/devices/${device.id}`, { training });
      await load();
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("shell.error.title"));
    } finally {
      setBusy(null);
    }
  };

  const resetPin = (person: Person) =>
    change(person.membership_id, async (stepUp) => {
      const r = await api<{ sent_by: "text" | "email" }>(
        "POST",
        `/v1/venues/${venueId}/team/${person.membership_id}/reset-pin`,
        {},
        { stepUp },
      );
      return sentBy(r.sent_by);
    });

  const deactivate = (person: Person) => {
    setConfirming(null);
    return change(person.membership_id, async (stepUp) => {
      await api(
        "POST",
        `/v1/venues/${venueId}/team/${person.membership_id}/deactivate`,
        {},
        { stepUp },
      );
      return { key: "team.deactivated.done", params: { name: person.name } };
    });
  };

  const switchFrontDeskBar = async (allowedNow: boolean) => {
    setError(null);
    setFrontDeskBar(allowedNow);
    try {
      for (const action of FRONT_DESK_BAR_ACTIONS) {
        await api("PATCH", `/v1/venues/${venueId}/permissions/front_desk/${action}`, {
          allowed: allowedNow,
        });
      }
    } catch {
      setError(t("shell.error.title"));
      await load().catch(() => {});
    }
  };

  const pair = async (person: Person) => {
    if (!shell) return;
    setError(null);
    setPairing({ membershipId: person.membership_id, step: "waiting" });
    try {
      const { uid } = await shell.badge.pairStart();
      setPairing({ membershipId: person.membership_id, step: "programming" });
      const keys = await api<{ key_version: number; meta_read_key: string; file_read_key: string }>(
        "POST",
        `/v1/venues/${venueId}/team/${person.membership_id}/badges/keys`,
        { uid },
      );
      const programmed = await shell.badge.pairFinish({ host: window.location.origin, ...keys });
      const count = person.badges.length + 1;
      await api(
        "POST",
        `/v1/venues/${venueId}/team/${person.membership_id}/badges`,
        { sun: programmed.url, label: t("team.badge.label", { n: count }) },
        { stepUp: await stepUpToken() },
      );
      await load();
    } catch (e) {
      await shell.badge.cancelPair().catch(() => {});
      setError(
        (e as ApiCallError)?.code === "step_up_required"
          ? t("stepUp.needed")
          : t("team.badge.failed"),
      );
    } finally {
      setPairing(null);
    }
  };

  const switchOff = async (badge: Badge) => {
    setError(null);
    try {
      await api(
        "POST",
        `/v1/venues/${venueId}/badges/${badge.id}/disable`,
        {},
        { stepUp: await stepUpToken() },
      );
      await load();
    } catch {
      setError(t("shell.error.title"));
    }
  };

  if (!allowed) {
    return (
      <section className="team">
        <h2>{t("team.title")}</h2>
        <p className="notice" role="status">
          {t("admin.notYours")}
        </p>
      </section>
    );
  }

  const statusOf = (p: Person): string => {
    if (p.status === "deactivated") return t("team.status.deactivated");
    if (p.status === "active") return t("team.status.active");
    return p.invite_expires_at
      ? t("team.status.invited", { when: time(p.invite_expires_at, timeZone) })
      : t("team.status.inviteExpired");
  };

  return (
    <section className="team">
      <h2>{t("team.title")}</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!shell || device !== "shared" ? (
        <p className="muted">{t("team.badge.noReader")}</p>
      ) : (
        <p className="muted small">{t("team.readers", { list: readers.join(", ") || "—" })}</p>
      )}
      {people === null ? (
        <p role="status">{t("shell.loading")}</p>
      ) : (
        <table className="team-table">
          <thead>
            <tr>
              <th>{t("team.person")}</th>
              <th>{t("team.role")}</th>
              <th>{t("team.status")}</th>
              <th>{t("team.language")}</th>
              <th>{t("team.training")}</th>
              <th>{t("team.badges")}</th>
              <th>{t("team.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => {
              const gone = person.status === "deactivated";
              const self = person.membership_id === myMembership;
              const working = busy === person.membership_id;
              return (
                <tr key={person.membership_id} className={gone ? "gone" : ""}>
                  <td>
                    <div className="tile-name">{person.name}</div>
                    {person.email && <div className="tile-role">{person.email}</div>}
                  </td>
                  <td>
                    <select
                      aria-label={t("team.role")}
                      value={person.role}
                      disabled={gone || self || working}
                      title={self ? t("team.cantChangeOwnRole") : undefined}
                      onChange={(e) => void setRole(person, e.target.value as Role)}
                    >
                      {roles.map((role) => (
                        <option key={role} value={role}>
                          {t(roleKey[role])}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{statusOf(person)}</td>
                  <td>
                    <select
                      aria-label={t("team.language")}
                      value={person.locale}
                      disabled={gone || working}
                      onChange={(e) => void setLanguage(person, e.target.value as Locale)}
                    >
                      {locales.map((l) => (
                        <option key={l} value={l}>
                          {localeNames[l]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <label className="switch-line">
                      <input
                        type="checkbox"
                        aria-label={t("team.training.for", { name: person.name })}
                        checked={person.training}
                        disabled={gone || working}
                        onChange={(e) => void setTraining(person, e.target.checked)}
                      />
                      <span>{person.training ? t("training.mark") : t("team.training.off")}</span>
                    </label>
                  </td>
                  <td>
                    <ul className="badge-list">
                      {person.badges.map((badge) => (
                        <li key={badge.id}>
                          <span>
                            {badge.disabled_at
                              ? t("team.badge.off")
                              : t("team.badge.paired", { label: badge.label })}
                          </span>
                          {!badge.disabled_at && !gone && (
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => void switchOff(badge)}
                            >
                              {t("team.badge.switchOff")}
                            </button>
                          )}
                        </li>
                      ))}
                      {person.badges.length === 0 && (
                        <li className="muted">{t("team.badges.none")}</li>
                      )}
                    </ul>
                    {gone ? null : pairing?.membershipId === person.membership_id ? (
                      <p className="notice" role="status">
                        {t("team.badge.waiting")}
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void shell?.badge.cancelPair()}
                        >
                          {t("team.badge.cancel")}
                        </button>
                      </p>
                    ) : (
                      <button
                        type="button"
                        className="primary"
                        disabled={!shell || device !== "shared" || pairing !== null}
                        onClick={() => void pair(person)}
                      >
                        {t("team.badge.pair")}
                      </button>
                    )}
                  </td>
                  <td>
                    {!gone && (
                      <div className="team-actions">
                        <button
                          type="button"
                          className="secondary"
                          disabled={working}
                          onClick={() => void resetPin(person)}
                        >
                          {person.status === "invited" ? t("team.resendLink") : t("team.resetPin")}
                        </button>
                        {!self && confirming !== person.membership_id && (
                          <button
                            type="button"
                            className="secondary danger"
                            disabled={working}
                            onClick={() => setConfirming(person.membership_id)}
                          >
                            {t("team.deactivate")}
                          </button>
                        )}
                        {confirming === person.membership_id && (
                          <p className="notice" role="alertdialog">
                            {t("team.deactivate.confirm", { name: person.name })}
                            <button
                              type="button"
                              className="primary"
                              onClick={() => void deactivate(person)}
                            >
                              {t("team.confirm")}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => setConfirming(null)}
                            >
                              {t("team.badge.cancel")}
                            </button>
                          </p>
                        )}
                      </div>
                    )}
                    {note?.membershipId === person.membership_id && (
                      <p className="small" role="status">
                        {t(note.key, note.params)}
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {frontDeskBar !== null && (
        <label className="switch-line">
          <input
            type="checkbox"
            checked={frontDeskBar}
            onChange={(e) => void switchFrontDeskBar(e.target.checked)}
          />
          <span>{t("team.frontDeskPos")}</span>
        </label>
      )}
      <h3>{t("team.training.devices")}</h3>
      <p className="muted small">{t("team.training.devicesHint")}</p>
      {devices === null ? null : devices.length === 0 ? (
        <p className="empty">{t("team.training.noDevices")}</p>
      ) : (
        <ul className="training-devices">
          {devices.map((d) => (
            <li key={d.id}>
              <label className="switch-line">
                <input
                  type="checkbox"
                  checked={d.training}
                  disabled={busy === d.id}
                  onChange={(e) => void setDeviceTraining(d, e.target.checked)}
                />
                <span data-guest-text>{d.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <InviteForm venueId={venueId} onSent={load} />
    </section>
  );
}

function InviteForm({ venueId, onSent }: { venueId: string; onSent: () => Promise<void> }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [locale, setLocale] = useState<Locale>("en");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<({ kind: "ok" | "error" } & Message) | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setMessage(null);
    try {
      await api(
        "POST",
        `/v1/venues/${venueId}/team/invite`,
        { name: name.trim(), email: email.trim(), role, locale },
        { stepUp: await stepUpToken() },
      );
      setMessage({ kind: "ok", key: "team.invite.sent", params: { email: email.trim() } });
      setName("");
      setEmail("");
      await onSent();
    } catch (err) {
      const code = (err as ApiCallError)?.code;
      setMessage({
        kind: "error",
        key:
          code === "step_up_required" || code === "cancelled"
            ? "stepUp.needed"
            : "team.invite.failed",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="invite-form" onSubmit={(e) => void submit(e)}>
      <h3>{t("team.invite.title")}</h3>
      <div className="invite-fields">
        <label>
          <span>{t("team.invite.name")}</span>
          <input value={name} required maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t("team.invite.email")}</span>
          <input
            type="email"
            value={email}
            required
            maxLength={254}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          <span>{t("team.role")}</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {t(roleKey[r])}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("team.language")}</span>
          <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
            {locales.map((l) => (
              <option key={l} value={l}>
                {localeNames[l]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="submit" className="primary" disabled={sending}>
        {t("team.invite.send")}
      </button>
      {message && (
        <p className={message.kind === "error" ? "error" : "small"} role="status">
          {t(message.key, message.params)}
        </p>
      )}
    </form>
  );
}

const pinDigits = (role: Role): 4 | 6 => (role === "owner" || role === "manager" ? 6 : 4);

function useDeviceKind(): "shared" | "phone" | "none" | "loading" {
  const [kind, setKind] = useState<"shared" | "phone" | "none" | "loading">("loading");
  useEffect(() => {
    void readDevice().then((d) =>
      setKind(!d ? "none" : d.kind === "staff_phone" ? "phone" : "shared"),
    );
  }, []);
  return kind;
}

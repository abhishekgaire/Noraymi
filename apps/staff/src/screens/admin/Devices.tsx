import { useCallback, useEffect, useState, type FormEvent } from "react";
import { cents, type MessageKey } from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Printers & devices, the M1 part (M1-34; spec 09 · Devices at
 * West 4, Pairing; AdminDesk notes 4 and 9): every device row with its kind,
 * where it is, whether it's online and when it was last seen, from the same
 * rows the Console reads. "Pair a device" makes a one-time code; Revoke ends
 * the device's sessions at once; Rename. Printers are set up in M3, drawers
 * and readers in M4, the router in M8, and a room tablet's room arrives with
 * Admin → Rooms in M2.
 */
type Kind =
  | "bar_computer"
  | "front_desk"
  | "room_tablet"
  | "reader"
  | "printer"
  | "nfc_reader"
  | "router"
  | "staff_phone"
  | "up_next_display"
  | "mic_outlet";

interface Device {
  readonly id: string;
  readonly kind: Kind;
  readonly name: string;
  readonly room_id: string | null;
  readonly last_seen_at: string | null;
  readonly online: boolean;
  readonly revoked_at: string | null;
  readonly network: { cellular_backup?: boolean; on_backup_now?: boolean } | null;
}

/** The spec's order of places: bar, front desk, rooms, around the venue, people. */
const KIND_ORDER: readonly Kind[] = [
  "bar_computer",
  "front_desk",
  "nfc_reader",
  "printer",
  "reader",
  "room_tablet",
  "up_next_display",
  "router",
  "mic_outlet",
  "staff_phone",
];

const PAIRABLE: readonly Kind[] = KIND_ORDER.filter((k) => k !== "staff_phone");

const whereKey: Record<Kind, MessageKey> = {
  bar_computer: "devices.where.bar",
  front_desk: "devices.where.frontDesk",
  nfc_reader: "devices.where.barOrFrontDesk",
  printer: "devices.where.barOrFrontDesk",
  reader: "devices.where.barOrFrontDesk",
  room_tablet: "devices.where.rooms",
  up_next_display: "devices.where.bar",
  router: "devices.where.around",
  mic_outlet: "devices.where.rooms",
  staff_phone: "devices.where.people",
};

export function Devices() {
  const { t, locale } = useT();
  const { state } = useSession();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; key: MessageKey; name?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const answer = await api<{ devices: Device[] }>("GET", `/v1/venues/${venueId}/devices`);
    const live = answer.devices.filter((d) => d.revoked_at === null);
    live.sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    setDevices(live);
  }, [venueId]);

  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setError(t("shell.error.cantReach")));
  }, [venueId, load, t]);

  const seen = (at: string): string =>
    new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(new Date(at));

  const rename = async (d: Device, name: string) => {
    setError(null);
    try {
      await api("PATCH", `/v1/venues/${venueId}/devices/${d.id}`, { name: name.trim() });
      setRenaming(null);
      await load();
      setNote({ id: d.id, key: "devices.renamed" });
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("shell.error.title"));
    }
  };

  const revoke = async (d: Device) => {
    setConfirming(null);
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/devices/${d.id}/revoke`, {});
      await load();
      setNote({ id: "", key: "devices.revoked", name: d.name });
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("shell.error.title"));
    }
  };

  const tablets = devices?.filter((d) => d.kind === "room_tablet") ?? [];

  return (
    <section className="devices">
      <h2>{t("admin.section.devices")}</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note?.id === "" && (
        <p className="small" role="status">
          {t(note.key, { name: note.name ?? "" })}
        </p>
      )}
      {devices === null ? (
        <p role="status">{t("shell.loading")}</p>
      ) : devices.length === 0 ? (
        <p className="empty">{t("devices.empty")}</p>
      ) : (
        <>
          {tablets.length > 0 && (
            <p className="small muted">
              {t("devices.tabletsOnline", {
                online: tablets.filter((d) => d.online).length,
                total: tablets.length,
              })}
            </p>
          )}
          <table className="team-table devices-table">
            <thead>
              <tr>
                <th>{t("devices.col.device")}</th>
                <th>{t("devices.col.kind")}</th>
                <th>{t("devices.col.where")}</th>
                <th>{t("devices.col.state")}</th>
                <th>{t("devices.col.lastSeen")}</th>
                <th>{t("devices.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className={d.online ? "" : "gone"}>
                  <td>
                    {renaming?.id === d.id ? (
                      <form
                        className="field-line"
                        onSubmit={(e: FormEvent) => {
                          e.preventDefault();
                          void rename(d, renaming.name);
                        }}
                      >
                        <input
                          aria-label={t("devices.pair.name")}
                          value={renaming.name}
                          maxLength={80}
                          required
                          onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                        />
                        <button type="submit" className="primary">
                          {t("devices.rename")}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setRenaming(null)}
                        >
                          {t("team.badge.cancel")}
                        </button>
                      </form>
                    ) : (
                      <div className="tile-name">{d.name}</div>
                    )}
                    {note?.id === d.id && (
                      <div className="small" role="status">
                        {t(note.key)}
                      </div>
                    )}
                  </td>
                  <td>{t(`devices.kind.${d.kind}` as MessageKey)}</td>
                  <td>{t(whereKey[d.kind])}</td>
                  <td>
                    <span className={d.online ? "state-online" : "muted"}>
                      {d.online
                        ? t("devices.online")
                        : d.last_seen_at
                          ? t("devices.offline")
                          : t("devices.neverSeen")}
                    </span>
                    {d.kind === "router" && typeof d.network?.cellular_backup === "boolean" && (
                      <div className="small muted">
                        {t(
                          d.network.cellular_backup
                            ? "devices.backupInternet.on"
                            : "devices.backupInternet.off",
                        )}
                      </div>
                    )}
                  </td>
                  <td className="muted">{d.last_seen_at ? seen(d.last_seen_at) : "—"}</td>
                  <td>
                    <div className="team-actions">
                      {renaming?.id !== d.id && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setRenaming({ id: d.id, name: d.name })}
                        >
                          {t("devices.rename")}
                        </button>
                      )}
                      {confirming === d.id ? (
                        <p className="notice" role="alertdialog">
                          {t("devices.revoke.confirm", { name: d.name })}
                          <button type="button" className="primary" onClick={() => void revoke(d)}>
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
                      ) : (
                        <button
                          type="button"
                          className="secondary danger"
                          onClick={() => setConfirming(d.id)}
                        >
                          {t("devices.revoke")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <PairForm venueId={venueId} timeZone={timeZone} onMade={load} />
      <Printers
        venueId={venueId}
        printers={(devices ?? []).filter((d) => d.kind === "printer")}
        onAdded={load}
      />
      <Readers venueId={venueId} />
    </section>
  );
}

/**
 * Card readers (M4-02; Stripe setup 4; AdminDesk note 9): each reader with its
 * label, model, online and cellular, and the $10 a month cellular fee; add
 * one with the code it shows. Only the S710, S700 and WisePOS E are offered,
 * the S700 and WisePOS E labeled "no cellular backup"; never the M2.
 */
interface Reader {
  readonly id: string;
  readonly label: string;
  readonly model: string | null;
  readonly registered: boolean;
  readonly online: boolean;
  readonly cellular: boolean;
  readonly monthly_fee_cents: number;
}

function Readers({ venueId }: { venueId: string }) {
  const { t, money } = useT();
  const [readers, setReaders] = useState<readonly Reader[] | null>(null);
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ readers: Reader[] }>("GET", `/v1/venues/${venueId}/readers`);
    setReaders(r.readers);
  }, [venueId]);
  useEffect(() => {
    if (venueId) load().catch(() => setError(t("shell.error.cantReach")));
  }, [venueId, load, t]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const r = await api<Reader>("POST", `/v1/venues/${venueId}/readers`, {
        registration_code: code.trim(),
        label: label.trim(),
      });
      setMessage(t("readers.registered", { name: r.label }));
      setCode("");
      setLabel("");
      await load();
    } catch (err) {
      const details = (err as ApiCallError)?.details as { reason?: string } | undefined;
      setError(
        details?.reason === "unsupported_reader" ? t("readers.unsupported") : t("readers.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="readers" aria-labelledby="readers-h">
      <h3 id="readers-h">{t("readers.title")}</h3>
      {readers === null ? (
        !error && <p role="status">{t("shell.loading")}</p>
      ) : readers.length === 0 ? (
        <p className="muted">{t("readers.none")}</p>
      ) : (
        <ul className="list">
          {readers.map((r) => (
            <li key={r.id} aria-label={r.label}>
              <strong>{r.label}</strong>
              <span>
                {r.model ? t(`readers.model.${r.model}` as MessageKey) : t("readers.notRegistered")}
              </span>
              <span className={r.online ? "ok" : "muted"}>
                {r.online ? t("readers.online") : t("readers.offline")}
              </span>
              {r.cellular && (
                <span className="small">
                  {t("readers.cellular", { fee: money(cents(r.monthly_fee_cents)) })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">{t("readers.tipDelay")}</p>
      <form onSubmit={(e) => void add(e)} className="invite-fields">
        <h4>{t("readers.add")}</h4>
        <p className="small muted">{t("readers.supported")}</p>
        <label>
          <span>{t("readers.label")}</span>
          <input
            aria-label={t("readers.label")}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <span className="small muted">{t("readers.label.hint")}</span>
        </label>
        <label>
          <span>{t("readers.code")}</span>
          <input
            aria-label={t("readers.code")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <span className="small muted">{t("readers.code.hint")}</span>
        </label>
        <button type="submit" className="primary" disabled={busy || !label.trim() || !code.trim()}>
          {t("readers.register")}
        </button>
        {message && <p role="status">{message}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

function PairForm({
  venueId,
  timeZone,
  onMade,
}: {
  venueId: string;
  timeZone: string;
  onMade: () => Promise<void>;
}) {
  const { t, time } = useT();
  const [kind, setKind] = useState<Kind>("room_tablet");
  const [name, setName] = useState("");
  const [sending, setSending] = useState(false);
  const [made, setMade] = useState<{ code: string; expires_at: string } | null>(null);
  const [failed, setFailed] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setFailed(false);
    setMade(null);
    try {
      const answer = await api<{ code: string; expires_at: string }>(
        "POST",
        `/v1/venues/${venueId}/devices/pair`,
        { kind, name: name.trim() },
      );
      setMade(answer);
      setName("");
      await onMade();
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="invite-form" onSubmit={(e) => void submit(e)}>
      <h3>{t("devices.pair.title")}</h3>
      <div className="invite-fields">
        <label>
          <span>{t("devices.col.kind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {PAIRABLE.map((k) => (
              <option key={k} value={k}>
                {t(`devices.kind.${k}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("devices.pair.name")}</span>
          <input value={name} required maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <button type="submit" className="primary" disabled={sending}>
        {t("devices.pair.make")}
      </button>
      {made && (
        <p className="notice" role="status">
          {t("devices.pair.code", { code: made.code, until: time(made.expires_at, timeZone) })}
        </p>
      )}
      {failed && (
        <p className="error" role="alert">
          {t("devices.pair.failed")}
        </p>
      )}
    </form>
  );
}

/**
 * Network printers (M3-13): add a Star CloudPRNT or Epson Server Direct Print
 * printer for a station, its credential shown once, and print a test ticket.
 */
function Printers({
  venueId,
  printers,
  onAdded,
}: {
  venueId: string;
  printers: readonly { id: string; name: string }[];
  onAdded: () => Promise<void>;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [station, setStation] = useState("bar");
  const [protocol, setProtocol] = useState("cloudprnt");
  const [made, setMade] = useState<{ url: string; user: string; password: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ username: string; password: string; poll_path: string }>(
        "POST",
        `/v1/venues/${venueId}/printers`,
        { name: name.trim(), station, protocol },
      );
      setMade({
        url: `${window.location.origin}${r.poll_path}`,
        user: r.username,
        password: r.password,
      });
      setName("");
      await onAdded();
    } catch {
      setError(t("printers.failed"));
    }
  };
  const test = async (printer: { id: string; name: string }) => {
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/printers/${printer.id}/test`);
      setMessage(t("printers.testSent", { name: printer.name }));
    } catch {
      setError(t("printers.failed"));
    }
  };

  return (
    <section className="printers" aria-labelledby="printers-h">
      <h3 id="printers-h">{t("printers.title")}</h3>
      {printers.length > 0 && (
        <ul className="faults">
          {printers.map((p) => (
            <li key={p.id}>
              <span>{p.name}</span>{" "}
              <button type="button" className="secondary" onClick={() => void test(p)}>
                {t("printers.test")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      {made && (
        <p className="notice" role="status">
          {t("printers.credential", { url: made.url, user: made.user, password: made.password })}
        </p>
      )}
      <form className="invite-form" onSubmit={(e) => void add(e)}>
        <h4>{t("printers.add")}</h4>
        <div className="invite-fields">
          <label>
            <span>{t("printers.name")}</span>
            <input value={name} required maxLength={60} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>{t("printers.station")}</span>
            <select
              aria-label={t("printers.station")}
              value={station}
              onChange={(e) => setStation(e.target.value)}
            >
              <option value="bar">{t("printers.station.bar")}</option>
              <option value="front_desk">{t("printers.station.front_desk")}</option>
            </select>
          </label>
          <label>
            <span>{t("printers.protocol")}</span>
            <select
              aria-label={t("printers.protocol")}
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
            >
              <option value="cloudprnt">{t("printers.protocol.cloudprnt")}</option>
              <option value="server_direct">{t("printers.protocol.server_direct")}</option>
            </select>
          </label>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary">
          {t("printers.add")}
        </button>
      </form>
    </section>
  );
}

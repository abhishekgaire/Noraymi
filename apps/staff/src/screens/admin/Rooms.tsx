import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { MessageKey, RoomSettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api, type ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Rooms (M2-04; spec 04 · rooms; spec 03 · RoomSettings): each room's
 * name, size tier, capacity, cleaning minutes, VIP, bookable online, and the
 * switch on or off ("Switched off" is an out-of-service state, flagged in
 * M2-04). Archive takes a room off the board and out of assignment and keeps
 * its history. The `rooms` settings go through Save and publish.
 */
interface Room {
  readonly id: string;
  readonly name: string;
  readonly size_tier: string;
  readonly capacity_min: number;
  readonly capacity_max: number;
  readonly cleaning_min: number | null;
  readonly is_vip: boolean;
  readonly bookable_online: boolean;
  readonly state: string;
  readonly state_reason: string | null;
}

interface Reassigned {
  readonly unplaced: readonly unknown[];
}

const TIERS = ["small", "medium", "large", "vip"];
const SWITCHED_OFF = "Switched off";

export function Rooms() {
  const { t } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [saved, setSaved] = useState<RoomSettings | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, settings] = await Promise.all([
      api<{ rooms: Room[] }>("GET", `/v1/venues/${venueId}/rooms`),
      api<{ value: RoomSettings }>("GET", `/v1/venues/${venueId}/settings/rooms`),
    ]);
    setRooms(list.rooms);
    setSaved(settings.value);
  }, [venueId]);

  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setError(t("shell.error.cantReach")));
  }, [venueId, load, t, draft.version]);

  const tier = (name: string) =>
    TIERS.includes(name) ? t(`rooms.tier.${name}` as MessageKey) : name;

  const patch = async (room: Room, body: Record<string, unknown>, path = "") => {
    setError(null);
    setMessage(null);
    try {
      const answer = await api<{ reassigned?: Reassigned }>(
        "PATCH",
        `/v1/venues/${venueId}/rooms/${room.id}${path}`,
        body,
      );
      const unplaced = answer.reassigned?.unplaced.length ?? 0;
      if (unplaced > 0) setMessage(t("rooms.unplaced", { count: unplaced }));
      await load();
      return true;
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("rooms.failed"));
      return false;
    }
  };

  const switchRoom = (room: Room, on: boolean) =>
    patch(
      room,
      on ? { state: "available" } : { state: "out_of_service", reason: SWITCHED_OFF },
      "/state",
    );

  const archive = async (room: Room) => {
    setConfirming(null);
    if (await patch(room, { archived: true })) setMessage(t("rooms.archived", { name: room.name }));
  };

  const current = (draft.values["rooms"] as RoomSettings | undefined) ?? saved;
  const setSetting = <K extends keyof RoomSettings>(key: K, value: RoomSettings[K]) => {
    if (current) draft.set("rooms", { ...current, [key]: value });
  };

  return (
    <section className="rooms">
      <h2>{t("admin.section.rooms")}</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      {rooms === null || current === null ? (
        <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          <table className="team-table">
            <thead>
              <tr>
                <th>{t("rooms.col.room")}</th>
                <th>{t("rooms.col.size")}</th>
                <th>{t("rooms.col.capacity")}</th>
                <th>{t("rooms.col.cleaning")}</th>
                <th>{t("rooms.col.online")}</th>
                <th>{t("rooms.col.state")}</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => {
                const off = room.state === "out_of_service";
                return (
                  <tr key={room.id} className={off ? "gone" : ""}>
                    <td>
                      <div className="tile-name">{room.name}</div>
                      {room.is_vip && <div className="tile-role">{t("rooms.vip")}</div>}
                    </td>
                    <td>{tier(room.size_tier)}</td>
                    <td>
                      {t("rooms.capacity", { min: room.capacity_min, max: room.capacity_max })}
                    </td>
                    <td>
                      {room.cleaning_min === null
                        ? t("rooms.cleaningDefault", { min: current.cleaningMin })
                        : t("rooms.cleaningMin", { min: room.cleaning_min })}
                    </td>
                    <td>
                      <label className="switch-line">
                        <input
                          type="checkbox"
                          aria-label={`${room.name} · ${t("rooms.col.online")}`}
                          checked={room.bookable_online}
                          onChange={(e) => void patch(room, { bookable_online: e.target.checked })}
                        />
                        <span>
                          {room.bookable_online ? t("rooms.bookable") : t("rooms.notBookable")}
                        </span>
                      </label>
                    </td>
                    <td>
                      <div className="team-actions">
                        <span className={off ? "muted" : "state-online"}>
                          {off
                            ? room.state_reason === SWITCHED_OFF
                              ? t("rooms.switchedOff")
                              : (room.state_reason ?? t("rooms.off"))
                            : t("rooms.on")}
                        </span>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void switchRoom(room, off)}
                        >
                          {off ? t("rooms.switchOn") : t("rooms.switchOff")}
                        </button>
                        {confirming === room.id ? (
                          <p className="notice" role="alertdialog">
                            {t("rooms.archive.confirm", { name: room.name })}
                            <button
                              type="button"
                              className="primary"
                              onClick={() => void archive(room)}
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
                        ) : (
                          <button
                            type="button"
                            className="secondary danger"
                            onClick={() => setConfirming(room.id)}
                          >
                            {t("rooms.archive")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h3>{t("rooms.settings")}</h3>
          <div className="invite-fields">
            <label>
              <span>{t("rooms.settings.cleaningMin")}</span>
              <input
                type="number"
                min={0}
                value={current.cleaningMin}
                onChange={(e) =>
                  setSetting("cleaningMin", Math.max(0, Number(e.target.value) || 0))
                }
              />
            </label>
            <label>
              <span>{t("rooms.settings.cleaningEnds")}</span>
              <select
                value={current.cleaningEnds}
                onChange={(e) =>
                  setSetting("cleaningEnds", e.target.value as RoomSettings["cleaningEnds"])
                }
              >
                <option value="staff">{t("rooms.settings.cleaningEnds.staff")}</option>
                <option value="timer">{t("rooms.settings.cleaningEnds.timer")}</option>
              </select>
            </label>
            <label>
              <span>{t("rooms.settings.cleaningFlagMin")}</span>
              <input
                type="number"
                min={0}
                value={current.cleaningFlagMin}
                onChange={(e) =>
                  setSetting("cleaningFlagMin", Math.max(0, Number(e.target.value) || 0))
                }
              />
            </label>
          </div>
          <label className="switch-line">
            <input
              type="checkbox"
              checked={current.stayOnWhenFree}
              onChange={(e) => setSetting("stayOnWhenFree", e.target.checked)}
            />
            <span>{t("rooms.settings.stayOnWhenFree")}</span>
          </label>
          <AddRoom venueId={venueId} onAdded={load} />
        </>
      )}
    </section>
  );
}

function AddRoom({ venueId, onAdded }: { venueId: string; onAdded: () => Promise<void> }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [sizeTier, setSizeTier] = useState("small");
  const [min, setMin] = useState(3);
  const [max, setMax] = useState(6);
  const [cleaning, setCleaning] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/rooms`, {
        name: name.trim(),
        size_tier: sizeTier,
        capacity_min: min,
        capacity_max: max,
        cleaning_min: cleaning === "" ? null : Number(cleaning),
        is_vip: sizeTier === "vip",
      });
      setName("");
      setCleaning("");
      await onAdded();
    } catch (err) {
      setError((err as ApiCallError)?.message ?? t("rooms.failed"));
    }
  };

  return (
    <form className="invite-form" onSubmit={(e) => void submit(e)}>
      <h3>{t("rooms.add")}</h3>
      <div className="invite-fields">
        <label>
          <span>{t("rooms.name")}</span>
          <input value={name} required maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t("rooms.sizeTier")}</span>
          <select value={sizeTier} onChange={(e) => setSizeTier(e.target.value)}>
            {TIERS.map((x) => (
              <option key={x} value={x}>
                {t(`rooms.tier.${x}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("rooms.min")}</span>
          <input
            type="number"
            min={1}
            value={min}
            onChange={(e) => setMin(Number(e.target.value) || 1)}
          />
        </label>
        <label>
          <span>{t("rooms.max")}</span>
          <input
            type="number"
            min={1}
            value={max}
            onChange={(e) => setMax(Number(e.target.value) || 1)}
          />
        </label>
        <label>
          <span>{t("rooms.cleaningField")}</span>
          <input
            type="number"
            min={0}
            value={cleaning}
            onChange={(e) => setCleaning(e.target.value)}
          />
        </label>
      </div>
      <button type="submit" className="primary">
        {t("rooms.add")}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

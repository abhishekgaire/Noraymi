import { useCallback, useEffect, useState } from "react";
import { api, stepUpToken, type ApiCallError } from "../api.js";
import { readDevice } from "../device.js";
import { roleKey, useT } from "../i18n.js";
import { useSession } from "../session.js";
import type { Role } from "@west4/shared";

/**
 * Admin (M1-26, M1-30): in a passkey session, Team's badges column, "Pair
 * (tap the reader)" and "Switch off" for each person (AdminDesk note 4). On a
 * phone, or in a PIN or badge session, the screen says Admin needs a passkey
 * and never shows a PIN pad. The other Admin sections land with their tickets.
 */
interface Tile {
  readonly membership_id: string;
  readonly name: string;
  readonly role: Role;
}

interface Badge {
  readonly id: string;
  readonly label: string;
  readonly disabled_at: string | null;
}

type Pairing = { membershipId: string; step: "waiting" | "programming" } | null;

export function Admin() {
  const { t } = useT();
  const { state } = useSession();
  const assurance = state.status === "signedIn" ? state.me.session.assurance : null;
  const phone = typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;
  return (
    <section className="screen">
      <h1>{t("menu.admin")}</h1>
      {assurance === "passkey" ? (
        <TeamBadges />
      ) : (
        <p className="notice" role="status">
          {phone ? t("admin.needsPasskeyPhone") : t("admin.needsPasskey")}
        </p>
      )}
    </section>
  );
}

function TeamBadges() {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [badges, setBadges] = useState<Record<string, Badge[]>>({});
  const [readers, setReaders] = useState<string[]>([]);
  const [pairing, setPairing] = useState<Pairing>(null);
  const [error, setError] = useState<string | null>(null);
  const shell = typeof window === "undefined" ? undefined : window.west4;

  const load = useCallback(async () => {
    const answer = await api<{ tiles: Tile[] }>("GET", `/v1/venues/${venueId}/team/tiles`);
    setTiles(answer.tiles);
    const all: Record<string, Badge[]> = {};
    for (const tile of answer.tiles) {
      const list = await api<{ badges: Badge[] }>(
        "GET",
        `/v1/venues/${venueId}/team/${tile.membership_id}/badges`,
      );
      all[tile.membership_id] = list.badges;
    }
    setBadges(all);
  }, [venueId]);

  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setError(t("shell.error.cantReach")));
  }, [venueId, load, t]);

  useEffect(() => {
    if (!shell) return;
    void shell.readers().then((list) => setReaders(list.map((r) => r.name)));
    return shell.badge.onReaders((list) => setReaders(list.map((r) => r.name)));
  }, [shell]);

  const pair = async (tile: Tile) => {
    if (!shell) return;
    setError(null);
    setPairing({ membershipId: tile.membership_id, step: "waiting" });
    try {
      const { uid } = await shell.badge.pairStart();
      setPairing({ membershipId: tile.membership_id, step: "programming" });
      const keys = await api<{ key_version: number; meta_read_key: string; file_read_key: string }>(
        "POST",
        `/v1/venues/${venueId}/team/${tile.membership_id}/badges/keys`,
        { uid },
      );
      const programmed = await shell.badge.pairFinish({ host: window.location.origin, ...keys });
      const count = (badges[tile.membership_id] ?? []).length + 1;
      await api(
        "POST",
        `/v1/venues/${venueId}/team/${tile.membership_id}/badges`,
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

  const device = useDeviceKind();

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
      <table className="team-table">
        <thead>
          <tr>
            <th>{t("role.staff")}</th>
            <th>{t("team.badges")}</th>
          </tr>
        </thead>
        <tbody>
          {tiles.map((tile) => (
            <tr key={tile.membership_id}>
              <td>
                <div className="tile-name">{tile.name}</div>
                <div className="tile-role">{t(roleKey[tile.role])}</div>
              </td>
              <td>
                <ul className="badge-list">
                  {(badges[tile.membership_id] ?? []).map((badge) => (
                    <li key={badge.id}>
                      <span>
                        {badge.disabled_at
                          ? t("team.badge.off")
                          : t("team.badge.paired", { label: badge.label })}
                      </span>
                      {!badge.disabled_at && (
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
                  {(badges[tile.membership_id] ?? []).length === 0 && (
                    <li className="muted">{t("team.badges.none")}</li>
                  )}
                </ul>
                {pairing?.membershipId === tile.membership_id ? (
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
                    onClick={() => void pair(tile)}
                  >
                    {t("team.badge.pair")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function useDeviceKind(): "shared" | "phone" | "none" | "loading" {
  const [kind, setKind] = useState<"shared" | "phone" | "none" | "loading">("loading");
  useEffect(() => {
    void readDevice().then((d) =>
      setKind(!d ? "none" : d.kind === "staff_phone" ? "phone" : "shared"),
    );
  }, []);
  return kind;
}

import type { MessageKey } from "@west4/shared";
import { useT } from "../i18n.js";
import { lengthText } from "./room-start.js";
import "../layout/dialog.css";

/**
 * The check-in sheet's presets (D128), shared with the Calendar's New booking (U-13, D133): the
 * party-size chips with More, the length chips, and the room chips. Each chip is a 44 px tap target
 * styled under `.checkin-sheet` (layout/dialog.css).
 */

/** The party-size chips; "More" opens the number field. */
export const PARTY_CHIPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** The lengths offered as chips, in minutes. */
export const LENGTH_CHIPS = [60, 90, 120, 180, 240] as const;

export function PartyChips({
  party,
  more,
  onParty,
  onMore,
}: {
  /** The chosen party; null until one is tapped. */
  party: number | null;
  /** The number field is open (a party bigger than the chips). */
  more: boolean;
  /** `typed` is the More field: it stays open; a chip closes it. */
  onParty: (n: number, typed: boolean) => void;
  onMore: () => void;
}) {
  const { t } = useT();
  return (
    <div className="chips">
      {PARTY_CHIPS.map((n) => (
        <button
          key={n}
          type="button"
          className="chip"
          aria-pressed={!more && party === n}
          onClick={() => onParty(n, false)}
        >
          {n}
        </button>
      ))}
      <button type="button" className="chip" aria-pressed={more} onClick={onMore}>
        {t("checkIn.partyMore")}
      </button>
      {more && (
        <input
          type="number"
          className="chip-input"
          min={1}
          aria-label={t("checkIn.partyCount")}
          value={party ?? ""}
          onChange={(e) => onParty(Math.max(1, Number(e.target.value) || 1), true)}
        />
      )}
    </div>
  );
}

export function LengthChips({
  minutes,
  disabled = false,
  onMinutes,
}: {
  minutes: number;
  disabled?: boolean;
  onMinutes: (m: number) => void;
}) {
  const { t } = useT();
  return (
    <div className="chips">
      {LENGTH_CHIPS.map((m) => (
        <button
          key={m}
          type="button"
          className="chip"
          disabled={disabled}
          aria-pressed={minutes === m}
          onClick={() => onMinutes(m)}
        >
          {lengthText(t, m)}
        </button>
      ))}
    </div>
  );
}

/** A room as a chip (U-09): its size, and the server's reason it can't take the party. */
export interface RoomChoice {
  readonly room_id: string;
  readonly name: string;
  readonly capacity_min: number;
  readonly capacity_max: number;
  readonly ok: boolean;
  readonly why: "too_small" | "in_use" | "cleaning" | "held" | "out_of_service" | null;
  readonly until: string | null;
}

export function RoomChips({
  rooms,
  selected,
  timeZone,
  onPick,
}: {
  rooms: readonly RoomChoice[];
  selected: string | null;
  timeZone: string;
  onPick: (roomId: string) => void;
}) {
  const { t, time } = useT();
  return (
    <div className="chips room-chips">
      {rooms.map((r) => {
        const size = t("checkIn.roomFits", { min: r.capacity_min, max: r.capacity_max });
        return (
          <button
            key={r.room_id}
            type="button"
            className="chip room-chip"
            aria-pressed={r.room_id === selected}
            disabled={!r.ok}
            onClick={() => onPick(r.room_id)}
          >
            <b>{r.name}</b>
            <span className="small">
              {r.ok
                ? r.until
                  ? `${size} · ${t("checkIn.roomUntil", { time: time(r.until, timeZone) })}`
                  : size
                : `${t(`move.why.${r.why ?? "in_use"}` as MessageKey)} · ${size}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

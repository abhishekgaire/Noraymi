import { Temporal } from "@west4/shared";
import { useT } from "../i18n.js";

/**
 * The board's alerts band (M2-30; Board note 3), most urgent first: pink,
 * amber, lime, grey, each with its actions. The order and the data come from
 * `GET /board`; the words come from the catalog.
 */
export type Alert =
  | {
      readonly kind: "needed_now" | "near_end";
      readonly color: string;
      readonly room_name: string;
      readonly session_id: string;
      readonly guest_name: string | null;
      readonly minutes_past?: number;
      readonly minutes_left?: number;
      readonly next: { readonly name: string; readonly party_size: number; readonly at: string };
    }
  | {
      readonly kind: "call";
      readonly color: string;
      readonly call_id: string;
      readonly room_name: string;
      readonly call: "mic" | "tv" | "check" | "other";
      readonly minutes_ago: number;
    }
  | {
      readonly kind: "offer";
      readonly color: string;
      readonly entry_id: string;
      readonly room_name: string;
      readonly name: string;
      readonly party_size: number;
      readonly waited_min: number;
      readonly all_night: boolean;
    }
  | {
      readonly kind: "wipe";
      readonly color: string;
      readonly rooms: readonly {
        readonly room_id: string;
        readonly name: string;
        readonly minutes: number;
      }[];
      readonly waiting: readonly string[];
    }
  | {
      readonly kind: "clear_out";
      readonly color: string;
      readonly done: boolean;
      readonly business_date: string;
      readonly done_at?: string;
      readonly done_by?: string | null;
    }
  | {
      readonly kind: "no_bar";
      readonly color: string;
      readonly lost_at: string;
    }
  | {
      readonly kind: "order";
      readonly color: string;
      readonly order_id: string;
      readonly status: string;
      readonly room_name: string | null;
      readonly items: string | null;
      readonly age_sec: number;
      readonly told: "phone" | "texted" | null;
      readonly manager: string | null;
    }
  | {
      readonly kind: "ticket";
      readonly color: string;
      readonly job_id: string;
      readonly room_name: string | null;
    }
  | {
      readonly kind: "code";
      readonly color: string;
      readonly session_id: string;
      readonly room_name: string;
    }
  | {
      readonly kind: "late";
      readonly color: string;
      readonly booking_id: string;
      readonly conversation_id: string;
      readonly name: string;
      readonly text: string;
      readonly starts_at: string;
      readonly room_name: string;
      readonly held_until: string;
      readonly no_show_ok: boolean;
    };

export interface AlertActions {
  readonly wrapUp: (sessionId: string, name: string) => void;
  readonly move: (sessionId: string, roomName: string) => void;
  readonly onIt: (callId: string) => void;
  readonly reprint: (jobId: string) => void;
  readonly showOrders: () => void;
  readonly clearOut: (businessDate: string) => void;
  readonly offer: (entryId: string) => void;
  readonly show: (roomId: string) => void;
  readonly noProblem: (conversationId: string) => void;
  readonly checkIn: (bookingId: string, name: string) => void;
  readonly noShow: (bookingId: string) => void;
  readonly canText: boolean;
}

export function Alerts({
  alerts,
  timeZone,
  actions,
}: {
  alerts: readonly Alert[];
  timeZone: string;
  actions: AlertActions;
}) {
  const { t, locale } = useT();
  const list = (items: readonly string[]) =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  const short = (iso: string) => {
    const z = Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone);
    const h = z.hour % 12 === 0 ? 12 : z.hour % 12;
    return `${h}:${String(z.minute).padStart(2, "0")}`;
  };
  /** "Rooms 6 and 13" when every room is "Room N"; otherwise the names joined. */
  const roomList = (names: readonly string[]) => {
    const numbers = names.map((n) => /^Room (\S+)$/.exec(n)?.[1]);
    return numbers.every(Boolean) && numbers.length > 1
      ? t("alert.rooms", { list: list(numbers as string[]) })
      : list(names);
  };

  const words = (a: Alert): string => {
    switch (a.kind) {
      case "needed_now":
        return t("alert.neededNow", {
          room: a.room_name,
          min: a.minutes_past ?? 0,
          name: a.next.name,
          party: a.next.party_size,
          time: short(a.next.at),
        });
      case "near_end":
        return t("alert.nearEnd", {
          room: a.room_name,
          min: a.minutes_left ?? 0,
          name: a.next.name,
          time: short(a.next.at),
        });
      case "call":
        return t(`alert.call.${a.call}`, { room: a.room_name, min: a.minutes_ago });
      case "offer":
        return t(a.all_night ? "alert.offerAllNight" : "alert.offer", {
          room: a.room_name,
          name: a.name,
          party: a.party_size,
          min: a.waited_min,
        });
      case "wipe":
        return t("alert.wipe", {
          rooms: roomList(a.rooms.map((r) => r.name)),
          minutes: list(a.rooms.map((r) => String(r.minutes))),
          names: list(a.waiting),
        });
      case "code":
        return t("alert.code", { room: a.room_name });
      case "clear_out":
        return a.done
          ? t("alert.clearOut.done", {
              name: a.done_by ?? "",
              time: new Intl.DateTimeFormat("en-US", {
                timeZone,
                hour: "numeric",
                minute: "2-digit",
              }).format(new Date(a.done_at!)),
            })
          : t("alert.clearOut");
      case "no_bar":
        return t("alert.noBar", { time: short(a.lost_at) });
      case "order": {
        const age = `${Math.floor(a.age_sec / 60)}:${String(a.age_sec % 60).padStart(2, "0")}`;
        const base = t(a.status === "held" ? "alert.order.held" : "alert.order", {
          room: a.room_name ?? "",
          age,
          items: a.items ?? "",
        });
        if (!a.told || !a.manager) return `${base}.`;
        return `${base} · ${t(a.told === "texted" ? "alert.order.texted" : "alert.order.phone", { name: a.manager })}.`;
      }
      case "ticket":
        return a.room_name ? t("alert.ticket", { room: a.room_name }) : t("alert.ticket.noRoom");
      case "late":
        return t("alert.late", {
          name: a.name,
          text: a.text,
          time: short(a.starts_at),
          room: a.room_name,
          until: short(a.held_until),
        });
    }
  };

  if (alerts.length === 0) return null;
  return (
    <ul className="alerts" aria-label={t("alert.title")}>
      {alerts.map((a, i) => (
        <li key={`${a.kind}-${i}`} className={`alert ${a.color}`} aria-label={words(a)}>
          <span>{words(a)}</span>
          <span className="actions">
            {(a.kind === "needed_now" || a.kind === "near_end") && (
              <>
                {a.guest_name && actions.canText && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => actions.wrapUp(a.session_id, a.guest_name!)}
                  >
                    {t("wrapUp.text", { name: a.guest_name })}
                  </button>
                )}
                {a.kind === "needed_now" && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => actions.move(a.session_id, a.room_name)}
                  >
                    {t("alert.move")}
                  </button>
                )}
              </>
            )}
            {a.kind === "clear_out" && !a.done && (
              <button
                type="button"
                className="primary"
                onClick={() => actions.clearOut(a.business_date)}
              >
                {t("alert.clearOut.button")}
              </button>
            )}
            {a.kind === "order" && (
              <button type="button" className="secondary" onClick={() => actions.showOrders()}>
                {t("alert.order.show")}
              </button>
            )}
            {a.kind === "ticket" && (
              <button type="button" className="primary" onClick={() => actions.reprint(a.job_id)}>
                {t("alert.reprint")}
              </button>
            )}
            {a.kind === "call" && (
              <button type="button" className="primary" onClick={() => actions.onIt(a.call_id)}>
                {t("calls.onIt")}
              </button>
            )}
            {a.kind === "offer" && (
              <button type="button" className="primary" onClick={() => actions.offer(a.entry_id)}>
                {t("waitlist.offerButton", { room: a.room_name })}
              </button>
            )}
            {a.kind === "wipe" && (
              <button
                type="button"
                className="secondary"
                onClick={() => actions.show(a.rooms[0]!.room_id)}
              >
                {t("alert.show")}
              </button>
            )}
            {a.kind === "late" && (
              <>
                {actions.canText && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => actions.noProblem(a.conversation_id)}
                  >
                    {t("messages.noProblem")}
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  onClick={() => actions.checkIn(a.booking_id, a.name)}
                >
                  {t("checkIn.button")}
                </button>
                {a.no_show_ok && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => actions.noShow(a.booking_id)}
                  >
                    {t("checkIn.noShow")}
                  </button>
                )}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

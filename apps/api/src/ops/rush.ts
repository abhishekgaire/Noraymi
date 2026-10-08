import { decryptSecret, type Queryable } from "@west4/db";

/**
 * The rush driver (M9-11; docs/trial/rush-script.md): during the timed staff trial it places
 * the script's room orders on the practice sessions the front desk seated, at their times,
 * through the guest's own routes (join with the room code, then order), so the bar's ring,
 * accept and run are the real ones. Practice sessions only: a live session is never touched.
 */
export interface RushOrder {
  /** Seconds from the rush's start. */
  readonly atS: number;
  /** How many drinks, one line each. */
  readonly drinks: number;
  /** Drinks with alcohol, or soft drinks. */
  readonly alcohol: boolean;
}

/**
 * Twenty minutes: an order every 90 seconds, and a burst of three at once at minute 10, when
 * the bar is busiest. Our script's choice, not a venue fact; change it here and in the runbook.
 */
export const RUSH_ORDERS: readonly RushOrder[] = [
  { atS: 60, drinks: 2, alcohol: true },
  { atS: 150, drinks: 1, alcohol: false },
  { atS: 240, drinks: 3, alcohol: true },
  { atS: 330, drinks: 2, alcohol: true },
  { atS: 420, drinks: 1, alcohol: false },
  { atS: 510, drinks: 2, alcohol: true },
  { atS: 600, drinks: 2, alcohol: true },
  { atS: 600, drinks: 1, alcohol: false },
  { atS: 600, drinks: 4, alcohol: true },
  { atS: 750, drinks: 2, alcohol: true },
  { atS: 840, drinks: 1, alcohol: true },
  { atS: 930, drinks: 2, alcohol: false },
  { atS: 1020, drinks: 3, alcohol: true },
  { atS: 1110, drinks: 2, alcohol: true },
];

export interface PracticeRoom {
  readonly roomId: string;
  readonly roomName: string;
  readonly code: string;
}

/** The open practice sessions, with their room codes opened. Live sessions are never read. */
export async function practiceRooms(
  c: Queryable,
  venueId: string,
  key: Buffer,
): Promise<PracticeRoom[]> {
  const r = await c.query<{ room_id: string; name: string; sealed: string | null }>(
    `select s.room_id, r.name, s.room_code_enc as sealed
       from room_sessions s join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
      where s.venue_id = $1 and s.training and s.ended_at is null
      order by r.name`,
    [venueId],
  );
  return r.rows.flatMap((row) => {
    if (!row.sealed) return [];
    try {
      return [{ roomId: row.room_id, roomName: row.name, code: decryptSecret(key, row.sealed) }];
    } catch {
      return [];
    }
  });
}

interface MenuView {
  readonly categories: readonly {
    readonly items: readonly {
      readonly alcohol: boolean;
      readonly out_tonight: boolean;
      readonly variants: readonly { readonly id: string; readonly out_tonight: boolean }[];
      readonly groups: readonly { readonly required: boolean }[];
    }[];
  }[];
}

/** What a guest can order in one tap: not 86'd, no required choice. In menu order. */
export function orderable(menu: MenuView, alcohol: boolean): string[] {
  return menu.categories.flatMap((cat) =>
    cat.items
      .filter((i) => i.alcohol === alcohol && !i.out_tonight && !i.groups.some((g) => g.required))
      .flatMap((i) =>
        i.variants
          .filter((v) => !v.out_tonight)
          .slice(0, 1)
          .map((v) => v.id),
      ),
  );
}

export interface RushDeps {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly nowMs?: () => number;
  readonly log?: (line: string) => void;
}

export interface RushResult {
  readonly placed: number;
  readonly failed: readonly string[];
}

/**
 * Runs the script: order n goes to practice room n mod rooms, with drinks picked in turn from
 * the menu. `speed` above 1 runs it faster (the staging dry run). Each order carries its own
 * client_order_id (`rush-<run>-<n>`), so a retry never orders twice and the report finds them.
 */
export async function driveRush(
  cfg: {
    readonly apiUrl: string;
    readonly slug: string;
    readonly rooms: readonly PracticeRoom[];
    readonly script?: readonly RushOrder[];
    readonly runId: string;
    readonly speed?: number;
  },
  deps: RushDeps = {},
): Promise<RushResult> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = deps.nowMs ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const base = cfg.apiUrl.replace(/\/+$/, "");
  const script = cfg.script ?? RUSH_ORDERS;
  const speed = cfg.speed ?? 1;
  if (cfg.rooms.length === 0)
    throw new Error("no practice room is open: seat practice walk-ins first");
  const menuRes = await doFetch(`${base}/v1/public/venues/${cfg.slug}/menu`);
  if (!menuRes.ok) throw new Error(`the menu answered ${menuRes.status}`);
  const menu = (await menuRes.json()) as MenuView;
  const drinks = { true: orderable(menu, true), false: orderable(menu, false) };
  const cookies = new Map<string, string>();
  const join = async (room: PracticeRoom) => {
    const r = await doFetch(`${base}/v1/public/venues/${cfg.slug}/rooms/${room.roomId}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: room.code }),
    });
    const set = r.headers.getSetCookie?.() ?? [];
    const cookie = set.find((c) => c.startsWith("west4_room="))?.split(";")[0];
    if (!r.ok || !cookie)
      throw new Error(
        `joining ${room.roomName} answered ${r.status} ${(await r.text()).slice(0, 120)}`,
      );
    cookies.set(room.roomId, cookie);
    return cookie;
  };
  const started = nowMs();
  const failed: string[] = [];
  let placed = 0;
  let pick = 0;
  for (const [n, o] of script.entries()) {
    const wait = started + (o.atS * 1000) / speed - nowMs();
    if (wait > 0) await sleep(wait);
    const room = cfg.rooms[n % cfg.rooms.length]!;
    const pool = drinks[`${o.alcohol}`];
    if (pool.length === 0) {
      failed.push(`order ${n + 1}: nothing ${o.alcohol ? "with alcohol" : "soft"} to order`);
      continue;
    }
    const lines = Array.from({ length: o.drinks }, () => ({
      variant_id: pool[pick++ % pool.length]!,
      qty: 1,
      option_ids: [],
    }));
    try {
      const cookie = cookies.get(room.roomId) ?? (await join(room));
      const r = await doFetch(`${base}/v1/public/room-session/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ client_order_id: `rush-${cfg.runId}-${n + 1}`, lines }),
      });
      if (!r.ok) throw new Error(`answered ${r.status} ${(await r.text()).slice(0, 120)}`);
      placed++;
      log(`order ${n + 1} · ${room.roomName} · ${o.drinks} drink(s) · at ${o.atS} s`);
    } catch (e) {
      failed.push(
        `order ${n + 1} (${room.roomName}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { placed, failed };
}

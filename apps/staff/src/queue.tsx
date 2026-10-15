import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useConnection } from "./connection.js";
import { deviceOnlyApi, readDevice } from "./device.js";

/**
 * Queue mode (M8-04; spec 09 · Offline and queue mode; screens N29). Only
 * the desktop app has it: the offline code is checked on the computer
 * itself, and each queued round waits in its encrypted cache for the
 * replay (M8-05). The page only asks; it never sees the computer's secret
 * after handing it over once.
 */
export interface QueueState {
  readonly open: boolean;
  readonly opened_at: string | null;
  readonly ends_at: string | null;
  readonly kind: "time" | "printed" | null;
}

export interface QueuedRound {
  readonly order_id: string;
  readonly business_date: string;
  readonly queued_at: string;
  readonly tab_id: string;
  readonly check_id: string;
  readonly tab_name: string;
  readonly staff: { readonly membership_id: string; readonly name: string };
  readonly lines: readonly {
    readonly variant_id: string;
    readonly name: string;
    readonly qty: number;
    readonly unit_cents: number;
    readonly alcohol: boolean;
  }[];
  readonly cash_note: string | null;
}

export type NewRound = Omit<QueuedRound, "business_date" | "queued_at">;

/**
 * A cash quick sale taken in queue mode (U-16; D133), only while the venue's "Take cash quick sales
 * while offline" is on: priced from the kept terms with packages/rules, it opens the drawer on this
 * computer and replays once on reconnect, by its order id.
 */
export interface QueuedCashSale {
  readonly kind: "cash_sale";
  readonly order_id: string;
  readonly business_date: string;
  readonly queued_at: string;
  readonly staff: { readonly membership_id: string; readonly name: string };
  readonly lines: QueuedRound["lines"];
  readonly total_cents: number;
  readonly cash_cents: number;
  readonly tendered_cents: number;
}

export type NewCashSale = Omit<QueuedCashSale, "business_date" | "queued_at">;

/** Tonight's terms for pricing a cash sale offline, kept with GET /pos/terminal (null while off). */
export interface OfflineCashTermsView {
  readonly tax: {
    readonly rate: number;
    readonly taxed_categories: readonly string[];
    readonly surcharge_taxable: boolean;
    readonly jurisdiction_code: string | null;
  };
  readonly gratuity_pct: number | null;
  readonly cash_discount: {
    readonly pct: number;
    readonly tax_rate_pct: string;
    readonly food_includes_fee: boolean;
  } | null;
}

const isSale = (x: unknown): x is QueuedCashSale =>
  (x as { kind?: unknown } | null)?.kind === "cash_sale";

export type UnlockResult = "ok" | "wrong" | "used" | "malformed" | "not_set_up";

export interface QueueApi {
  /** This screen is the desktop app, which can queue. */
  readonly available: boolean;
  readonly state: QueueState;
  readonly rounds: readonly QueuedRound[];
  /** Cash quick sales kept in queue mode, waiting for the replay (U-16). */
  readonly sales: readonly QueuedCashSale[];
  readonly unlock: (code: string) => Promise<UnlockResult>;
  readonly add: (round: NewRound) => Promise<void>;
  /** Keep a cash sale and open the drawer; `kicked` is false when the drawer didn't open. */
  readonly addSale: (sale: NewCashSale) => Promise<{ kicked: boolean }>;
}

const CLOSED: QueueState = { open: false, opened_at: null, ends_at: null, kind: null };
const QueueContext = createContext<QueueApi>({
  available: false,
  state: CLOSED,
  rounds: [],
  sales: [],
  unlock: async () => "not_set_up",
  add: async () => {},
  addSale: async () => ({ kicked: false }),
});

/** How often the screen asks the computer whether queue mode has run its 4 hours. */
export const QUEUE_POLL_MS = 15_000;
/** How often an online computer checks its offline-code secret with the server. */
export const SECRET_CHECK_MS = 60 * 60_000;

function bridge() {
  return typeof window === "undefined" ? null : (window.west4?.queue ?? null);
}

/** Set up, or confirm, this computer's offline-code secret while online. */
export async function ensureOfflineSecret(): Promise<void> {
  const q = bridge();
  const device = await readDevice();
  if (!q || !device || (device.kind !== "bar_computer" && device.kind !== "front_desk")) return;
  const fingerprint = await q.fingerprint(device.deviceId);
  const answer = await deviceOnlyApi<{ device_id: string; secret: string | null }>(
    device,
    "POST",
    `/v1/venues/${device.venueId}/devices/offline-secret`,
    { fingerprint },
  );
  if (answer.secret) await q.setSecret(answer.device_id, answer.secret);
}

/** How often an online computer asks which drawer a cash sale offline opens (U-16). */
export const DRAWER_CHECK_MS = 60_000;

/**
 * Keep this computer's drawer for a cash sale offline (U-16), or forget it: the server answers null
 * while "Take cash quick sales while offline" is off, so with the switch off nothing is kept.
 */
export async function ensureOfflineDrawer(): Promise<void> {
  const q = bridge();
  const device = await readDevice();
  if (!q?.setDrawer || !device || (device.kind !== "bar_computer" && device.kind !== "front_desk"))
    return;
  const answer = await deviceOnlyApi<{ drawer: unknown }>(
    device,
    "GET",
    `/v1/venues/${device.venueId}/offline-orders/drawer`,
  );
  await q.setDrawer(answer.drawer ?? null);
}

/** How many rounds go up in one replay request. */
const REPLAY_BATCH = 100;

/**
 * The replay (M8-05; spec 09 · Replay): upload every queued round, signed as this computer.
 * The server checks each again and answers it as asked to wait or on Review after outage;
 * only the answered rounds leave the queue, so a lost answer just sends them again, and the
 * server's order id lands each one once.
 */
export async function replayQueue(
  rounds: readonly (QueuedRound | QueuedCashSale)[],
): Promise<number> {
  const q = bridge();
  const device = await readDevice();
  if (!q || !device || rounds.length === 0) return 0;
  let settled = 0;
  for (let i = 0; i < rounds.length; i += REPLAY_BATCH) {
    const answer = await deviceOnlyApi<{ results: { order_id: string }[] }>(
      device,
      "POST",
      `/v1/venues/${device.venueId}/offline-orders/replay`,
      { orders: rounds.slice(i, i + REPLAY_BATCH) },
    );
    settled += await q.settle(answer.results.map((r) => r.order_id));
  }
  return settled;
}

export function QueueProvider({ children }: { children: ReactNode }) {
  const q = bridge();
  const connection = useConnection();
  const offline = connection.kind === "offline";
  // Only an answer from our API ends queue mode: right after a restart the connection isn't known yet.
  const back = connection.browserOnline && connection.apiReachable === true;
  const [state, setState] = useState<QueueState>(CLOSED);
  const [queued, setQueued] = useState<readonly (QueuedRound | QueuedCashSale)[]>([]);
  const rounds = useMemo(() => queued.filter((x): x is QueuedRound => !isSale(x)), [queued]);
  const sales = useMemo(() => queued.filter(isSale), [queued]);

  const refresh = useCallback(async () => {
    if (!q) return;
    try {
      setState(((await q.state()) as QueueState | null) ?? CLOSED);
      setQueued(((await q.list()) as (QueuedRound | QueuedCashSale)[]) ?? []);
    } catch {
      // The computer's cache isn't there: no queue mode, nothing more.
    }
  }, [q]);

  useEffect(() => {
    if (!q) return;
    void refresh();
    const timer = setInterval(() => void refresh(), QUEUE_POLL_MS);
    return () => clearInterval(timer);
  }, [q, refresh]);

  // The connection is back: queue mode ends. The queued rounds stay for the replay.
  useEffect(() => {
    if (!q || !back) return;
    void q.end().then(refresh, () => undefined);
  }, [q, back, refresh]);

  // Online, the computer sets up its secret (or confirms it), so managers' phones can show its codes.
  // Back online with rounds waiting: replay them once at a time, again on the next poll if it fails.
  const replaying = useRef(false);
  useEffect(() => {
    if (!q || !back || queued.length === 0 || replaying.current) return;
    replaying.current = true;
    void replayQueue(queued)
      .catch(() => undefined)
      .finally(() => {
        replaying.current = false;
        void refresh();
      });
  }, [q, back, queued, refresh]);

  useEffect(() => {
    if (!q || !back) return;
    const check = () => void ensureOfflineSecret().catch(() => undefined);
    check();
    const timer = setInterval(check, SECRET_CHECK_MS);
    return () => clearInterval(timer);
  }, [q, back]);

  // Online, the computer keeps the drawer a cash sale offline opens, or forgets it when the switch is off.
  useEffect(() => {
    if (!q || !back) return;
    const check = () => void ensureOfflineDrawer().catch(() => undefined);
    check();
    const timer = setInterval(check, DRAWER_CHECK_MS);
    return () => clearInterval(timer);
  }, [q, back]);

  const unlock = useCallback(
    async (code: string): Promise<UnlockResult> => {
      if (!q) return "not_set_up";
      const r = (await q.unlock(code)) as QueueState & { refused?: UnlockResult };
      await refresh();
      return r.open ? "ok" : (r.refused ?? "wrong");
    },
    [q, refresh],
  );
  const add = useCallback(
    async (round: NewRound) => {
      if (!q) throw new Error("no queue");
      await q.add(round);
      await refresh();
    },
    [q, refresh],
  );

  const addSale = useCallback(
    async (sale: NewCashSale) => {
      if (!q?.addSale) throw new Error("no queue");
      const r = await q.addSale(sale);
      await refresh();
      return { kicked: r.kicked === true };
    },
    [q, refresh],
  );

  const value = useMemo<QueueApi>(
    () => ({
      available: !!q,
      state: offline ? state : CLOSED,
      rounds,
      sales,
      unlock,
      add,
      addSale,
    }),
    [q, offline, state, rounds, sales, unlock, add, addSale],
  );
  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useQueue(): QueueApi {
  return useContext(QueueContext);
}

/** A device-made order id (the replay's key). */
export function newOrderId(): string {
  return crypto.randomUUID();
}

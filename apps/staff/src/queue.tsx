import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

export type UnlockResult = "ok" | "wrong" | "used" | "malformed" | "not_set_up";

export interface QueueApi {
  /** This screen is the desktop app, which can queue. */
  readonly available: boolean;
  readonly state: QueueState;
  readonly rounds: readonly QueuedRound[];
  readonly unlock: (code: string) => Promise<UnlockResult>;
  readonly add: (round: NewRound) => Promise<void>;
}

const CLOSED: QueueState = { open: false, opened_at: null, ends_at: null, kind: null };
const QueueContext = createContext<QueueApi>({
  available: false,
  state: CLOSED,
  rounds: [],
  unlock: async () => "not_set_up",
  add: async () => {},
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

export function QueueProvider({ children }: { children: ReactNode }) {
  const q = bridge();
  const connection = useConnection();
  const offline = connection.kind === "offline";
  // Only an answer from our API ends queue mode: right after a restart the connection isn't known yet.
  const back = connection.browserOnline && connection.apiReachable === true;
  const [state, setState] = useState<QueueState>(CLOSED);
  const [rounds, setRounds] = useState<readonly QueuedRound[]>([]);

  const refresh = useCallback(async () => {
    if (!q) return;
    try {
      setState(((await q.state()) as QueueState | null) ?? CLOSED);
      setRounds(((await q.list()) as QueuedRound[]) ?? []);
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
  useEffect(() => {
    if (!q || !back) return;
    const check = () => void ensureOfflineSecret().catch(() => undefined);
    check();
    const timer = setInterval(check, SECRET_CHECK_MS);
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

  const value = useMemo<QueueApi>(
    () => ({ available: !!q, state: offline ? state : CLOSED, rounds, unlock, add }),
    [q, offline, state, rounds, unlock, add],
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

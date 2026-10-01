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
import { Temporal } from "@west4/shared";
import { businessDate } from "@west4/rules";

/**
 * The venue's clock (spec 01, screens rule 7). The API says what time it is
 * (GET /v1/auth/me and every WebSocket hello); the device's clock only measures
 * how long ago that was. On the demo seed every screen reads 10:41 PM whatever
 * the device says.
 */
interface ClockApi {
  /** The venue's clock now, or null before the API has answered once. */
  readonly now: Temporal.Instant | null;
  /** The API's server_time, in any ISO form. */
  readonly sync: (serverTime: string) => void;
}

const ClockContext = createContext<ClockApi>({ now: null, sync: () => {} });

// The last offset, kept outside React too: device signatures stamp requests with the server's time, never the device's.
let offsetMs: number | null = null;

/** The server's clock as epoch milliseconds, or null before the first sync. */
export function serverNowMs(): number | null {
  return offsetMs === null ? null : Date.now() + offsetMs;
}

/** Record the server's time from any answer that carries it. */
export function syncServerTime(serverTime: string): void {
  offsetMs = Temporal.Instant.from(serverTime).epochMilliseconds - Date.now();
}

const TICK_MS = 15_000;

export function ClockProvider({ children }: { children: ReactNode }) {
  // Server epoch milliseconds minus device epoch milliseconds at the last sync.
  const offset = useRef<number | null>(null);
  const [now, setNow] = useState<Temporal.Instant | null>(null);

  const read = useCallback(() => {
    if (offset.current === null) return null;
    return Temporal.Instant.fromEpochMilliseconds(Date.now() + offset.current);
  }, []);

  const sync = useCallback(
    (serverTime: string) => {
      syncServerTime(serverTime);
      offset.current = offsetMs;
      setNow(read());
    },
    [read],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(read()), TICK_MS);
    return () => clearInterval(timer);
  }, [read]);

  const value = useMemo(() => ({ now, sync }), [now, sync]);
  return <ClockContext.Provider value={value}>{children}</ClockContext.Provider>;
}

export function useClock(): ClockApi {
  return useContext(ClockContext);
}

/** The venue's time and business date for a time zone and cutover ("06:00"). */
export function useVenueTime(timeZone: string, dayCutover: string) {
  const { now } = useClock();
  return useMemo(() => {
    if (!now) return null;
    return { now, timeZone, businessDate: businessDate(now, timeZone, dayCutover).businessDate };
  }, [now, timeZone, dayCutover]);
}

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
import { api, ApiCallError } from "./api.js";
import {
  BANNER_TEXT,
  banners,
  connectionKind,
  footerKey,
  syncedAgo,
  unreachableStatus,
  type ConnectionInput,
  type ConnectionKind,
  type VendorState,
} from "./connection-state.js";
import { useEvents } from "./events.js";
import { useT } from "./i18n.js";
import { useSession } from "./session.js";

/**
 * The connection state in the staff app and the desktop app (M8-01; spec 09
 * · Outages). Every screen polls the venue's connection: an answer is a
 * sync (the Board's footer counts from it), and no answer is offline. The
 * router's and the vendors' events make it poll at once.
 */
export const CONNECTION_POLL_MS = 10_000;

interface ConnectionAnswer {
  readonly backup_internet: boolean;
  readonly vendors: { readonly stripe: VendorState; readonly twilio: VendorState };
  /** M8-05 adds the replayed orders waiting for Accept. */
  readonly replayed_waiting?: number;
}

export interface ConnectionApi extends ConnectionInput {
  readonly kind: ConnectionKind;
  /** When our API last answered, on this device's clock (an age, never a venue time). */
  readonly lastSync: number | null;
}

const initial: ConnectionApi = {
  browserOnline: true,
  apiReachable: null,
  backupInternet: false,
  replayedWaiting: 0,
  vendors: { stripe: "ok", twilio: "ok" },
  kind: "online",
  lastSync: null,
};

const ConnectionContext = createContext<ConnectionApi>(initial);

const REFETCH_ON = new Set([
  // Replayed offline orders (M8-05): the "Confirm replayed orders (N)" count follows each one.
  "order.held",
  "order.accepted",
  "order.cancelled",
  "vendor.health",
  "venue.backup_internet",
  "venue.offline",
  "venue.online",
  "device.online",
  "device.offline",
]);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const { subscribe } = useEvents();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : null;
  const [browserOnline, setBrowserOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);
  const [answer, setAnswer] = useState<ConnectionAnswer | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (!venueId || inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await api<ConnectionAnswer>("GET", `/v1/venues/${venueId}/connection`);
      setAnswer(next);
      setApiReachable(true);
      setLastSync(Date.now());
    } catch (error) {
      // A refusal is still an answer; no answer, or a gateway's, is our API unreachable.
      const unreachable = !(error instanceof ApiCallError) || unreachableStatus(error.status);
      setApiReachable(!unreachable);
    } finally {
      inFlight.current = false;
    }
  }, [venueId]);

  useEffect(() => {
    const up = () => {
      setBrowserOnline(true);
      void poll();
    };
    const down = () => setBrowserOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, [poll]);

  useEffect(() => {
    if (!venueId) return;
    void poll();
    const timer = setInterval(() => void poll(), CONNECTION_POLL_MS);
    return () => clearInterval(timer);
  }, [venueId, poll]);

  useEffect(
    () =>
      subscribe((events) => {
        if (events.some((e) => REFETCH_ON.has(e.type))) void poll();
      }),
    [subscribe, poll],
  );

  const value = useMemo<ConnectionApi>(() => {
    const input: ConnectionInput = {
      browserOnline,
      apiReachable,
      backupInternet: answer?.backup_internet ?? false,
      replayedWaiting: answer?.replayed_waiting ?? 0,
      vendors: answer?.vendors ?? initial.vendors,
    };
    return { ...input, kind: connectionKind(input), lastSync };
  }, [browserOnline, apiReachable, answer, lastSync]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionApi {
  return useContext(ConnectionContext);
}

/** The banners for one screen, as the shell's bands. */
export function ConnectionBanners({ outageScreen }: { outageScreen: boolean }) {
  const { t } = useT();
  const connection = useConnection();
  return (
    <>
      {banners(connection, outageScreen).map((id) => (
        <div
          key={id}
          className={`band connection-${id}`}
          role="status"
          data-testid={`banner-${id}`}
        >
          {t(BANNER_TEXT[id], id === "replayed" ? { n: connection.replayedWaiting } : undefined)}
        </div>
      ))}
    </>
  );
}

/** The Board's footer: "Online · synced 4 s ago", ticking every second (not a live region: it would talk every second). Never "works offline". */
export function SyncFooter() {
  const { t } = useT();
  const { kind, lastSync } = useConnection();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const ago = lastSync === null ? null : syncedAgo(now - lastSync);
  return (
    <footer className={`sync-footer ${kind}`} aria-label={t("connection.footer.label")}>
      <span data-testid="sync-footer">
        {t(footerKey(kind, lastSync), ago ? { ago: t(ago.key, { n: ago.n }) } : undefined)}
      </span>
    </footer>
  );
}

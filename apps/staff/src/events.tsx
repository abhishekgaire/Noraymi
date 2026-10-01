import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EventClient, type ClientWireEvent, type SocketLike } from "@west4/shared";
import { useClock } from "./clock.js";
import { useSession } from "./session.js";

/**
 * The venue's event stream (M1-09): one WebSocket per signed-in session, with
 * the client's own reconnect and backoff. Screens subscribe to refetch what
 * changed; the shell watches the connection for its offline band and takes
 * the venue's time from every hello.
 */
type Listener = (events: readonly ClientWireEvent[]) => void;

interface EventsApi {
  /** False while the socket is down after it was up once, or the browser says it's offline. */
  readonly connected: boolean;
  readonly subscribe: (listener: Listener) => () => void;
}

const EventsContext = createContext<EventsApi>({ connected: true, subscribe: () => () => {} });

export function EventsProvider({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const { sync } = useClock();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : null;
  const listeners = useRef(new Set<Listener>());
  const [socketUp, setSocketUp] = useState(true);
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    if (!venueId) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const client = new EventClient({
      url: `${scheme}://${location.host}/v1/venues/${venueId}/events`,
      connect: (url) => {
        const socket = new WebSocket(url);
        socket.addEventListener("open", () => setSocketUp(true));
        socket.addEventListener("close", () => setSocketUp(false));
        // The browser's WebSocket has the client's SocketLike shape; the handler types differ only in their event parameter.
        return socket as unknown as SocketLike;
      },
      onRefetch: (events) => {
        for (const listener of listeners.current) listener(events);
      },
      onFullRefetch: () => {
        for (const listener of listeners.current) listener([]);
      },
      onHello: (hello) => sync(hello.server_time),
    });
    client.start();
    return () => client.stop();
  }, [venueId, sync]);

  const value = useMemo<EventsApi>(
    () => ({
      connected: online && socketUp,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [online, socketUp],
  );
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>;
}

export function useEvents(): EventsApi {
  return useContext(EventsContext);
}

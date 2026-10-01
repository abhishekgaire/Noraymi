import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isLocale, type Locale } from "@west4/shared";
import {
  api,
  ApiCallError,
  NetworkError,
  setSessionToken,
  type Me,
  type Membership,
} from "./api.js";
import { signedApi, type StoredDevice } from "./device.js";
import { useClock } from "./clock.js";

/**
 * Who is signed in, where, and in which language (spec 02 · Languages).
 * Signed in, the language is the person's memberships.locale. Signed out,
 * it's the device's last choice, so the sign-in screen opens in the language
 * the last person chose there.
 */
export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "signedOut"; readonly reason: "none" | "locked" | "expired" }
  | { readonly status: "signedIn"; readonly me: Me; readonly membership: Membership };

export interface SessionApi {
  readonly state: SessionState;
  readonly locale: Locale;
  /** Change the language: on the membership when signed in, and always on this device. */
  readonly setLocale: (locale: Locale) => Promise<void>;
  /** Ask the API who is signed in. */
  readonly refresh: () => Promise<void>;
  /** Lock: end the session on this screen and show sign-in. */
  readonly lock: () => Promise<void>;
  /** Name and PIN on a shared screen (the tile's membership), or the PIN on the person's own phone (M1-24). */
  readonly signInWithPin: (
    device: StoredDevice,
    args: { membershipId?: string; pin: string },
  ) => Promise<void>;
}

const DEVICE_LOCALE_KEY = "west4.staff.locale";

export function readDeviceLocale(): Locale {
  try {
    const saved = localStorage.getItem(DEVICE_LOCALE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // Private windows and blocked storage: fall through to the browser's language.
  }
  const browser = typeof navigator === "undefined" ? "" : navigator.language;
  return browser.toLowerCase().startsWith("es") ? "es" : "en";
}

function saveDeviceLocale(locale: Locale): void {
  try {
    localStorage.setItem(DEVICE_LOCALE_KEY, locale);
  } catch {
    // Nothing to do: the choice lasts for this load.
  }
}

const SessionContext = createContext<SessionApi | null>(null);

export function SessionProvider({
  children,
  initial,
}: {
  children: ReactNode;
  /** Tests start from a known state instead of calling the API. */
  initial?: SessionState | undefined;
}) {
  // Only the stable sync function: the ticking clock itself must not refetch the session.
  const { sync } = useClock();
  const [state, setState] = useState<SessionState>(initial ?? { status: "loading" });
  const [deviceLocale, setDeviceLocale] = useState<Locale>(readDeviceLocale);

  const refresh = useCallback(async () => {
    try {
      const me = await api<Me>("GET", "/v1/auth/me");
      sync(me.server_time);
      const membership = me.memberships[0];
      if (!membership) {
        setState({ status: "signedOut", reason: "none" });
        return;
      }
      // The desktop shell keeps the venue's clock for its cache (M1-28).
      void window.west4?.venue
        .configure({
          time_zone: membership.venue.time_zone,
          day_cutover: membership.venue.day_cutover,
          server_time: me.server_time,
        })
        .catch(() => {});
      setState({ status: "signedIn", me, membership });
    } catch (error) {
      // No session is 403 (nobody), a dead one is 401 (session_expired or session_locked).
      if (error instanceof ApiCallError && (error.status === 401 || error.status === 403)) {
        setState((s) => ({
          status: "signedOut",
          reason: s.status === "signedIn" ? "expired" : "none",
        }));
      } else if (error instanceof NetworkError) {
        setState({ status: "error", message: error.message });
      } else {
        setState({ status: "error", message: error instanceof Error ? error.message : "" });
      }
    }
  }, [sync]);

  useEffect(() => {
    if (!initial) void refresh();
  }, [initial, refresh]);

  const locale = state.status === "signedIn" ? state.membership.locale : deviceLocale;

  const setLocale = useCallback(
    async (next: Locale) => {
      saveDeviceLocale(next);
      setDeviceLocale(next);
      if (state.status !== "signedIn") return;
      const { membership } = state;
      await api("PATCH", "/v1/auth/me", { membership_id: membership.membership_id, locale: next });
      setState((s) =>
        s.status === "signedIn" ? { ...s, membership: { ...s.membership, locale: next } } : s,
      );
    },
    [state],
  );

  const lock = useCallback(async () => {
    try {
      await api("POST", "/v1/auth/logout", {});
    } catch {
      // Already gone or offline: the screen locks either way.
    }
    setSessionToken(null);
    setState({ status: "signedOut", reason: "locked" });
  }, []);

  const signInWithPin = useCallback(
    async (device: StoredDevice, args: { membershipId?: string; pin: string }) => {
      const shared = device.kind !== "staff_phone";
      const opened = await signedApi<{ token?: string }>(device, "POST", "/v1/auth/pin", {
        ...(shared ? { membership_id: args.membershipId } : {}),
        pin: args.pin,
        client: shared ? "shared" : "phone",
      });
      if (opened.token) setSessionToken(opened.token);
      await refresh();
    },
    [refresh],
  );

  const value = useMemo(
    () => ({ state, locale, setLocale, refresh, lock, signInWithPin }),
    [state, locale, setLocale, refresh, lock, signInWithPin],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession needs a SessionProvider");
  return value;
}

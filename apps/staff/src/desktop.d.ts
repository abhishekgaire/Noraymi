/**
 * The desktop shell's bridge (apps/desktop preload, M1-28): present only
 * inside the Electron app. The bearer token lives in the keychain there, and
 * the shell learns the venue's clock for its cache.
 */
interface West4Desktop {
  readonly desktop: true;
  version(): Promise<string>;
  readonly token: {
    get(): Promise<string | null>;
    set(token: string): Promise<void>;
    clear(): Promise<void>;
  };
  readonly readers: () => Promise<{ name: string; serial: string }[]>;
  /** The USB printers this computer hosts, and raw ESC/POS to one of them (M3-14). */
  readonly printers?: () => Promise<{ name: string; serial: string }[]>;
  readonly print?: (serial: string, base64: string) => Promise<void>;
  /** A network printer on the venue's LAN this computer relays (W-04): raw bytes to its address. */
  readonly printNetwork?: (address: string, port: number, base64: string) => Promise<void>;
  /** Whether a network printer answers on its port. */
  readonly probeNetwork?: (address: string, port: number) => Promise<boolean>;
  readonly fakePlug?: (plugged: boolean) => Promise<void>;
  readonly badge: {
    onTap(listener: (tap: { url: string; reader: string }) => void): () => void;
    onReaders(listener: (list: { name: string; serial: string }[]) => void): () => void;
    pairStart(): Promise<{ uid: string }>;
    pairFinish(plan: {
      host: string;
      meta_read_key: string;
      file_read_key: string;
      key_version: number;
    }): Promise<{ uid: string; url: string }>;
    cancelPair(): Promise<void>;
    fakeTap(uid: string): Promise<void>;
  };
  /** The read-only offline view (M8-03): a listed read's answer kept in the encrypted cache. */
  readonly offline?: {
    save(path: string, json: string): Promise<boolean>;
    read(path: string): Promise<{ synced_at: string; body: unknown } | null>;
  };
  /** Queue mode (M8-04): the offline code is checked on the computer; queued rounds wait in its cache. */
  readonly queue?: {
    fingerprint(deviceId: string): Promise<string | null>;
    setSecret(deviceId: string, secret: string): Promise<void>;
    state(): Promise<unknown>;
    unlock(code: string): Promise<unknown>;
    end(): Promise<void>;
    add(order: unknown): Promise<unknown>;
    list(): Promise<unknown[]>;
    /** Drop the rounds the server answered on replay (M8-05). */
    settle(orderIds: string[]): Promise<number>;
    /** Cash quick sales while offline (U-16): this computer's drawer, kept while online (null forgets it). */
    setDrawer?(drawer: unknown): Promise<void>;
    /** Whether a drawer is kept for a cash sale offline (U-16). */
    hasDrawer?(): Promise<boolean>;
    /** Keep a cash sale in queue mode and open the drawer; `kicked` says whether it opened. */
    addSale?(sale: unknown): Promise<{ sale: unknown; kicked: boolean }>;
  };
  readonly venue: {
    configure(clock: {
      time_zone: string;
      day_cutover: string;
      server_time: string;
    }): Promise<void>;
  };
}

interface Window {
  west4?: West4Desktop;
}

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

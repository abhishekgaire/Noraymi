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

/** The desktop shell's bridge, as the staff app declares it (apps/staff/src/desktop.d.ts). */
interface Window {
  west4?: {
    readonly desktop: true;
    version(): Promise<string>;
    readonly token: {
      get(): Promise<string | null>;
      set(token: string): Promise<void>;
      clear(): Promise<void>;
    };
    readonly readers: () => Promise<{ name: string; serial: string }[]>;
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
    readonly offline?: {
      save(path: string, json: string): Promise<boolean>;
      read(path: string): Promise<{ synced_at: string; body: unknown } | null>;
    };
    /** Queue mode (M8-04). */
    readonly queue?: {
      state(): Promise<unknown>;
      unlock(code: string): Promise<unknown>;
      list(): Promise<unknown[]>;
    };
    readonly venue: {
      configure(clock: {
        time_zone: string;
        day_cutover: string;
        server_time: string;
      }): Promise<void>;
    };
  };
}

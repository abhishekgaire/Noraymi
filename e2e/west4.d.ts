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
    readonly venue: {
      configure(clock: {
        time_zone: string;
        day_cutover: string;
        server_time: string;
      }): Promise<void>;
    };
  };
}

import type pg from "pg";
import type { Queryable } from "./tenancy.js";

/**
 * Live events (spec 08 · Live events). emitEvent writes the row inside the
 * change's own transaction, so an event exists only if the change committed.
 * Routing columns (room, audience, user) never reach the wire.
 */
export type EventAudience = "venue" | "room" | "staff" | "managers" | "user" | "display";

export interface EmitEvent {
  readonly venueId: string;
  readonly type: string;
  readonly entityId: string;
  readonly entityVersion?: number;
  readonly roomId?: string | undefined;
  readonly audience?: EventAudience;
  readonly userId?: string | undefined;
}

export async function emitEvent(client: Queryable, event: EmitEvent): Promise<void> {
  await client.query(
    `insert into venue_events (venue_id, type, entity_id, entity_version, room_id, audience, user_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.venueId,
      event.type,
      event.entityId,
      event.entityVersion ?? 0,
      event.roomId ?? null,
      event.audience ?? "venue",
      event.userId ?? null,
    ],
  );
}

/** A stamped row as the tail sees it. */
export interface StampedEvent {
  readonly stamp: string;
  readonly venue_id: string;
  readonly seq: string;
  readonly type: string;
  readonly entity_id: string;
  readonly entity_version: number;
  readonly at: Date;
  readonly room_id: string | null;
  readonly audience: EventAudience;
  readonly user_id: string | null;
}

/** What goes on the wire: exactly these five fields, never money math. */
export interface WireEvent {
  readonly seq: number;
  readonly type: string;
  readonly id: string;
  readonly entity_version: number;
  readonly at: string;
}

export function toWire(
  row: Pick<StampedEvent, "seq" | "type" | "entity_id" | "entity_version" | "at">,
): WireEvent {
  return {
    seq: Number(row.seq),
    type: row.type,
    id: row.entity_id,
    entity_version: row.entity_version,
    at: row.at.toISOString(),
  };
}

const RELAY_LOCK_KEY = 0x77_34_72_6c; // "w4rl"

/**
 * The relay: one leader (a session advisory lock) stamps committed rows in
 * commit order, woken by NOTIFY and polling each second as a backstop. Every
 * API container runs one; only the leader's does anything.
 */
export class Relay {
  private client: pg.PoolClient | undefined;
  private stopped = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  leader = false;
  stamped = 0;

  constructor(
    private readonly db: pg.Pool,
    private readonly options: { pollMs?: number; log?: (line: string) => void } = {},
  ) {}

  start(): void {
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
    await this.release();
  }

  /** Simulate the process dying: the connection drops, the lock goes with it. */
  async crash(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    if (this.client) {
      this.client.release(new Error("crashed"));
      this.client = undefined;
    }
    this.leader = false;
    await this.loop;
  }

  async tryLead(): Promise<boolean> {
    if (this.leader) return true;
    if (!this.client) {
      this.client = await this.db.connect();
      this.client.on("notification", () => this.wake?.());
      await this.client.query("listen west4_events");
    }
    const r = await this.client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [
      RELAY_LOCK_KEY,
    ]);
    this.leader = r.rows[0]?.ok === true;
    return this.leader;
  }

  /** Stamp what's ready. Returns how many rows were stamped. */
  async stampOnce(): Promise<number> {
    if (!this.client) throw new Error("relay has no connection");
    const r = await this.client.query<{ n: number }>("select stamp_venue_events(1000) as n");
    const n = r.rows[0]?.n ?? 0;
    this.stamped += n;
    return n;
  }

  private async release(): Promise<void> {
    if (this.client) {
      if (this.leader)
        await this.client.query("select pg_advisory_unlock($1)", [RELAY_LOCK_KEY]).catch(() => {});
      this.client.release();
      this.client = undefined;
    }
    this.leader = false;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        if (await this.tryLead()) {
          while ((await this.stampOnce()) > 0) {
            /* drain */
          }
        }
      } catch (error) {
        this.options.log?.(`relay: ${error instanceof Error ? error.message : String(error)}`);
        await this.release().catch(() => {});
      }
      await this.sleep(this.options.pollMs ?? 1000);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      this.wake = done;
      function done(): void {
        clearTimeout(t);
        resolve();
      }
    });
  }
}

/**
 * The tail: each API container follows stamped rows on its own connection,
 * woken by NOTIFY and polling each second, and hands them to its sockets.
 */
export class Tail {
  private client: pg.PoolClient | undefined;
  private stopped = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private position = 0n;

  constructor(
    private readonly db: pg.Pool,
    private readonly onEvents: (events: StampedEvent[]) => void,
    private readonly options: { pollMs?: number; log?: (line: string) => void } = {},
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    // Start from the current end: sockets that need history ask with `after`.
    const r = await this.db.query<{ last: string }>(
      "select case when is_called then last_value else 0 end::text as last from venue_events_stamp_seq",
    );
    this.position = BigInt(r.rows[0]?.last ?? "0");
    this.client = await this.db.connect();
    this.client.on("notification", () => this.wake?.());
    await this.client.query("listen west4_stamped");
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
    this.client?.release();
    this.client = undefined;
  }

  async pull(): Promise<number> {
    if (!this.client) return 0;
    const r = await this.client.query<StampedEvent>("select * from tail_venue_events($1, 500)", [
      this.position.toString(),
    ]);
    if (r.rows.length === 0) return 0;
    this.position = BigInt(r.rows[r.rows.length - 1]!.stamp);
    this.onEvents(r.rows);
    return r.rows.length;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        while ((await this.pull()) > 0) {
          /* drain */
        }
      } catch (error) {
        this.options.log?.(`tail: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, this.options.pollMs ?? 1000);
        this.wake = done;
        function done(): void {
          clearTimeout(t);
          resolve();
        }
      });
    }
  }
}

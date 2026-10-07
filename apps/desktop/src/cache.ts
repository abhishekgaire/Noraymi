import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { Temporal } from "@west4/shared";
import { businessDate } from "@west4/rules";

/**
 * The encrypted cache (spec 12 · 6 and How long we keep things): SQLCipher
 * through SQLite, keyed by a secret the keychain seals, holding only the
 * current business date for the offline view (M8). At the cutover (6:00 AM
 * on the venue's clock) everything from the day before goes.
 */
type Database = {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  close(): void;
};

type DatabaseCtor = new (file: string, options?: { readonly?: boolean }) => Database;

const require = createRequire(import.meta.url);

export interface VenueClock {
  readonly timeZone: string;
  /** "06:00" */
  readonly dayCutover: string;
}

/** The one kind of row the cutover keeps: rounds queued offline that haven't replayed yet. */
const KEPT_PAST_CUTOVER = "queued";

export class DesktopCache {
  private constructor(
    private readonly db: Database,
    private clock: VenueClock | null,
  ) {}

  /** Open (or create) the cache with its key. The wrong key, or none, can't read it. */
  static open(file: string, keyHex: string, clock: VenueClock | null = null): DesktopCache {
    mkdirSync(dirname(file), { recursive: true });
    const Ctor = require("better-sqlite3-multiple-ciphers") as DatabaseCtor;
    const db = new Ctor(file);
    db.pragma(`cipher='sqlcipher'`);
    db.pragma(`key='${keyHex.replace(/'/g, "")}'`);
    db.exec(
      `create table if not exists meta (k text primary key, v text not null);
       create table if not exists rows (
         kind text not null, id text not null, body text not null,
         primary key (kind, id)
       );`,
    );
    const cache = new DesktopCache(db, clock);
    if (clock) cache.configure(clock);
    else {
      const saved = cache.metaGet("clock");
      if (saved) cache.clock = JSON.parse(saved) as VenueClock;
    }
    return cache;
  }

  /** The venue's clock, from the signed-in session; kept so the wipe works before the next sign-in. */
  configure(clock: VenueClock): void {
    this.clock = clock;
    this.metaSet("clock", JSON.stringify(clock));
  }

  /** The venue's clock as last configured, kept across restarts. */
  venueClock(): VenueClock | null {
    return this.clock;
  }

  /** The business date the rows belong to, or null when the cache is empty. */
  businessDate(): string | null {
    return this.metaGet("business_date");
  }

  private today(now: Temporal.Instant | string): string | null {
    if (!this.clock) return null;
    return businessDate(now, this.clock.timeZone, this.clock.dayCutover).businessDate.toString();
  }

  /** Past the cutover, the day before goes. Returns true when something was wiped. */
  wipeIfPastCutover(now: Temporal.Instant | string): boolean {
    const today = this.today(now);
    const stored = this.businessDate();
    if (!today || !stored || stored === today) return false;
    // Queued rounds (M8-04) wait for the replay whatever the date: the server checks their date then.
    this.db.prepare("delete from rows where kind <> ?").run(KEPT_PAST_CUTOVER);
    this.metaSet("business_date", today);
    return true;
  }

  /** Keep one row for the current business date. */
  put(now: Temporal.Instant | string, kind: string, id: string, body: unknown): void {
    const today = this.today(now);
    if (!today) throw new Error("the cache has no venue clock yet");
    this.wipeIfPastCutover(now);
    if (this.businessDate() !== today) this.metaSet("business_date", today);
    this.db
      .prepare(
        "insert into rows (kind, id, body) values (?, ?, ?) on conflict (kind, id) do update set body = excluded.body",
      )
      .run(kind, id, JSON.stringify(body));
  }

  get<T>(kind: string, id: string): T | null {
    const row = this.db.prepare("select body from rows where kind = ? and id = ?").get(kind, id) as
      { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : null;
  }

  list<T>(kind: string): T[] {
    return (
      this.db.prepare("select body from rows where kind = ? order by id").all(kind) as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body) as T);
  }

  /** Drop one row (a queued round the server has answered, M8-05). */
  remove(kind: string, id: string): void {
    this.db.prepare("delete from rows where kind = ? and id = ?").run(kind, id);
  }

  close(): void {
    this.db.close();
  }

  /** A small value of the desktop app's own (queue mode, the venue clock's offset). */
  metaRead(k: string): string | null {
    return this.metaGet(k);
  }

  metaWrite(k: string, v: string): void {
    this.metaSet(k, v);
  }

  metaDelete(k: string): void {
    this.db.prepare("delete from meta where k = ?").run(k);
  }

  private metaGet(k: string): string | null {
    const row = this.db.prepare("select v from meta where k = ?").get(k) as
      { v: string } | undefined;
    return row?.v ?? null;
  }

  private metaSet(k: string, v: string): void {
    this.db
      .prepare("insert into meta (k, v) values (?, ?) on conflict (k) do update set v = excluded.v")
      .run(k, v);
  }
}

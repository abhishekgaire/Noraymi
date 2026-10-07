import { createHmac } from "node:crypto";
import {
  businessDate,
  checkOfflineCode,
  offlineSecretFingerprint,
  queueModeEndsAt,
  type Hmac,
} from "@west4/rules";
import { Temporal } from "@west4/shared";
import type { DesktopCache, VenueClock } from "./cache.js";
import type { SealedStore } from "./keychain.js";

/**
 * Queue mode (M8-04; spec 09 · Offline and queue mode). The computer checks
 * an offline code itself: a time-based code from the secret it set up while
 * online and keeps in the keychain, or a printed one-time code, each valid
 * only for this computer and the business date. A code opens queue mode
 * until the connection returns or 4 hours pass. Queued rounds are requests
 * the server checks again on replay (M8-05); they live in the encrypted
 * cache, so a restart or a watchdog relaunch loses none. The secret never
 * goes back to the page.
 */
export const hmac: Hmac = (secret, message) =>
  createHmac("sha256", Buffer.from(secret, "hex")).update(message).digest();

export interface QueueState {
  readonly open: boolean;
  readonly opened_at: string | null;
  readonly ends_at: string | null;
  readonly kind: "time" | "printed" | null;
}

export interface QueuedLine {
  readonly variant_id: string;
  readonly name: string;
  readonly qty: number;
  readonly unit_cents: number;
  readonly alcohol: boolean;
}

export interface QueuedOrder {
  /** Made on this computer: the server's key for the replay, so a round lands once. */
  readonly order_id: string;
  readonly business_date: string;
  readonly queued_at: string;
  readonly tab_id: string;
  readonly check_id: string;
  readonly tab_name: string;
  /** Picked from the kept team: no PIN offline, since no device keeps PIN hashes. */
  readonly staff: { readonly membership_id: string; readonly name: string };
  readonly lines: readonly QueuedLine[];
  /** The cautious default for cash taken while Stripe is down too: a note for Review after outage. */
  readonly cash_note: string | null;
}

const CLOSED: QueueState = { open: false, opened_at: null, ends_at: null, kind: null };
export const QUEUED_KIND = "queued";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9-]{1,64}$/;

interface Held {
  readonly device_id: string;
  readonly secret: string;
}

export class QueueMode {
  constructor(
    private readonly keychain: SealedStore,
    private readonly cache: () => DesktopCache | null,
    private readonly clock: () => VenueClock | null,
  ) {}

  private held(): Held | null {
    const raw = this.keychain.get();
    if (!raw) return null;
    try {
      const h = JSON.parse(raw) as Held;
      return typeof h.device_id === "string" && /^[0-9a-f]{64}$/.test(h.secret) ? h : null;
    } catch {
      return null;
    }
  }

  /** The fingerprint of the secret held for this device, or null: the page sends it while online. */
  fingerprint(deviceId: unknown): string | null {
    const h = this.held();
    return h && h.device_id === deviceId ? offlineSecretFingerprint(hmac, h.secret) : null;
  }

  /** Keep a new secret from the server, sealed by the keychain. */
  setSecret(deviceId: unknown, secret: unknown): void {
    if (typeof deviceId !== "string" || !ID.test(deviceId))
      throw new Error("refused: not a device");
    if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret))
      throw new Error("refused: not a secret");
    this.keychain.set(JSON.stringify({ device_id: deviceId, secret } satisfies Held));
  }

  /** Queue mode now: closed by itself once 4 hours have passed. */
  state(now: Temporal.Instant): QueueState {
    const cache = this.cache();
    const raw = cache?.metaRead("queue_mode");
    if (!cache || !raw) return CLOSED;
    const s = JSON.parse(raw) as QueueState;
    if (!s.ends_at || Temporal.Instant.compare(now, Temporal.Instant.from(s.ends_at)) >= 0) {
      cache.metaDelete("queue_mode");
      return CLOSED;
    }
    return { ...s, open: true };
  }

  /** Check a code on this computer. A wrong, used, expired or other device's code opens nothing. */
  unlock(now: Temporal.Instant, typed: unknown): QueueState & { readonly refused?: string } {
    const h = this.held();
    const clock = this.clock();
    const cache = this.cache();
    if (!h || !clock || !cache) return { ...CLOSED, refused: "not_set_up" };
    if (typeof typed !== "string" || typed.length > 20) return { ...CLOSED, refused: "malformed" };
    const usedKey = (date: string) => `printed_used:${date}`;
    const scope = { deviceId: h.device_id, timeZone: clock.timeZone, dayCutover: clock.dayCutover };
    const dateNow = this.businessDate(now, clock);
    const used = JSON.parse(cache.metaRead(usedKey(dateNow)) ?? "[]") as number[];
    const check = checkOfflineCode(hmac, h.secret, scope, now, typed, used);
    if (!check.ok) return { ...CLOSED, refused: check.reason };
    if (check.kind === "printed")
      cache.metaWrite(usedKey(check.date), JSON.stringify([...used, check.index]));
    const state: QueueState = {
      open: true,
      opened_at: now.toString(),
      ends_at: queueModeEndsAt(now).toString(),
      kind: check.kind,
    };
    cache.metaWrite("queue_mode", JSON.stringify(state));
    return state;
  }

  /** The connection is back: queue mode ends. What was queued stays for the replay. */
  end(): void {
    this.cache()?.metaDelete("queue_mode");
  }

  /** Queue one round, only while queue mode is open. */
  add(now: Temporal.Instant, input: unknown): QueuedOrder {
    if (!this.state(now).open) throw new Error("refused: queue mode isn't open");
    const clock = this.clock();
    const cache = this.cache();
    if (!clock || !cache) throw new Error("refused: no cache");
    const order = parseOrder(input, this.businessDate(now, clock), now);
    if (cache.get(QUEUED_KIND, order.order_id)) throw new Error("refused: already queued");
    cache.put(now, QUEUED_KIND, order.order_id, order);
    return order;
  }

  /**
   * The server answered these rounds (M8-05): each landed as asked to wait, or on Review after
   * outage. Only answered ids leave the queue; anything not answered stays for the next upload.
   */
  settle(orderIds: unknown): number {
    const cache = this.cache();
    if (!cache || !Array.isArray(orderIds)) return 0;
    let n = 0;
    for (const id of orderIds) {
      if (typeof id !== "string" || !UUID.test(id)) continue;
      if (!cache.get(QUEUED_KIND, id.toLowerCase())) continue;
      cache.remove(QUEUED_KIND, id.toLowerCase());
      n += 1;
    }
    return n;
  }

  list(): QueuedOrder[] {
    return (this.cache()?.list<QueuedOrder>(QUEUED_KIND) ?? []).sort((a, b) =>
      a.queued_at.localeCompare(b.queued_at),
    );
  }

  private businessDate(now: Temporal.Instant, clock: VenueClock): string {
    return businessDate(now, clock.timeZone, clock.dayCutover).businessDate.toString();
  }
}

function text(x: unknown, max: number): string {
  if (typeof x !== "string" || x.trim().length === 0 || x.length > max)
    throw new Error("refused: not an order");
  return x.trim();
}

function parseOrder(input: unknown, businessDate: string, now: Temporal.Instant): QueuedOrder {
  const o = (input ?? {}) as Record<string, unknown>;
  const staff = (o["staff"] ?? {}) as Record<string, unknown>;
  const lines = o["lines"];
  if (typeof o["order_id"] !== "string" || !UUID.test(o["order_id"]))
    throw new Error("refused: not an order id");
  if (typeof o["tab_id"] !== "string" || !ID.test(o["tab_id"])) throw new Error("refused: no tab");
  if (typeof o["check_id"] !== "string" || !ID.test(o["check_id"]))
    throw new Error("refused: no check");
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 50)
    throw new Error("refused: no lines");
  const cash = o["cash_note"];
  return {
    order_id: o["order_id"].toLowerCase(),
    business_date: businessDate,
    queued_at: now.toString(),
    tab_id: o["tab_id"],
    check_id: o["check_id"],
    tab_name: text(o["tab_name"], 120),
    staff: {
      membership_id: text(staff["membership_id"], 64),
      name: text(staff["name"], 120),
    },
    lines: lines.map((raw) => {
      const l = (raw ?? {}) as Record<string, unknown>;
      const qty = l["qty"];
      const unit = l["unit_cents"];
      if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 99)
        throw new Error("refused: not a quantity");
      if (typeof unit !== "number" || !Number.isInteger(unit) || unit < 0 || unit > 1_000_000)
        throw new Error("refused: not a price");
      return {
        variant_id: text(l["variant_id"], 64),
        name: text(l["name"], 200),
        qty,
        unit_cents: unit,
        alcohol: l["alcohol"] === true,
      };
    }),
    cash_note: cash === null || cash === undefined ? null : text(cash, 200),
  };
}

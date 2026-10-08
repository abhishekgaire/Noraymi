import { webcrypto } from "node:crypto";
import {
  DEVICE_KEY_ALGORITHM,
  TARGETS,
  newTraceparent,
  signDeviceRequest,
  signDeviceSocketPath,
} from "@west4/shared";
import { TEST_CARDS, type LoadConfig, type LoadVenue } from "./setup.js";
import { shareWithin, summarize, type Summary } from "./stats.js";

/**
 * A Friday-night peak for many venues at once (M8-21; spec 13 · Tests, Friday-night load test).
 * Every venue runs together: its bar computer listens on the live channel (and polls every 5
 * seconds as the bar does), its rooms are seated and joined from the guests' phones, and through
 * the peak each room orders (the bar's alarm is timed from the order to the ring, as the
 * synthetic check times it), the bartender accepts, bar rounds go onto the rooms and tabs, tabs
 * are opened on the reader, and the owner reads the 8-week trends; partway through, every device
 * of every venue reconnects at once. After the peak, every room pays by card on a simulated
 * reader and every tab closes. The report has the alarm's p50, p95 and slowest, the same during
 * the reconnect storm and while reports run, and every request that failed on our side.
 */
export interface LoadOptions {
  /** How long the peak lasts. */
  readonly peakMs: number;
  /** Rooms seated per venue (at most the venue's rooms). */
  readonly roomsPerVenue: number;
  /** Each room orders this often on average (random gaps). */
  readonly orderEveryMs: number;
  /** A bar round onto a room or a tab, per venue, this often on average. */
  readonly roundEveryMs: number;
  /** Tabs opened per venue at the start of the peak. */
  readonly tabsPerVenue: number;
  /** The owner reads the 8-week trends this often, per venue, through the peak. */
  readonly reportEveryMs: number;
  /** When every device reconnects at once, from the start of the peak. */
  readonly stormAtMs: number;
  /** Live connections per venue (the bar, room tablets, phones), all reconnecting in the storm. */
  readonly socketsPerVenue: number;
  /** The bar's fallback poll (the staff app's CHIME_CHECK_MS). */
  readonly barPollMs?: number;
  /** An order that hasn't rung by now has failed. */
  readonly ringTimeoutMs?: number;
  readonly log?: (line: string) => void;
  /** Presents a different test card per tab (setup's cardPresenter); without it, tabs share one. */
  readonly presentCard?: (
    venue: LoadVenue,
    reader: number,
    card: string,
    key: string,
  ) => Promise<void>;
}

export interface AlarmSample {
  readonly venue: string;
  readonly orderId: string;
  readonly ms: number;
  readonly via: "event" | "poll";
  readonly sentAt: number;
  readonly inStorm: boolean;
  readonly duringReport: boolean;
}

export interface Failure {
  readonly venue: string;
  readonly step: string;
  readonly what: string;
}

export interface LoadReport {
  readonly venues: number;
  readonly peakMs: number;
  readonly targetMs: number;
  readonly alarm: Summary & { readonly within: number; readonly viaPoll: number };
  readonly alarmInStorm: Summary & { readonly within: number };
  readonly alarmDuringReports: Summary & { readonly within: number };
  readonly slowest: readonly AlarmSample[];
  readonly reports: Summary;
  readonly payments: Summary;
  readonly counts: {
    readonly orders: number;
    readonly rounds: number;
    readonly tabs: number;
    readonly payments: number;
    readonly reports: number;
    readonly reconnects: number;
  };
  readonly failures: readonly Failure[];
  /** p95 under the target in all three windows, and nothing failed on our side. */
  readonly passed: boolean;
}

const STORM_WINDOW_MS = 10_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
/** A random gap with the given mean (a Poisson stream of orders). */
const gap = (mean: number) => -Math.log(1 - Math.random()) * mean;

class StepFailed extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

/** One at a time per reader: a reader takes one payment at once, as at the bar. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let done!: () => void;
    this.tail = new Promise<void>((r) => (done = r));
    await prev;
    try {
      return await fn();
    } finally {
      done();
    }
  }
}

interface Shared {
  readonly samples: AlarmSample[];
  readonly reportMs: number[];
  readonly paymentMs: number[];
  readonly failures: Failure[];
  readonly counts: {
    orders: number;
    rounds: number;
    tabs: number;
    payments: number;
    reports: number;
    reconnects: number;
  };
  readonly start: number;
  stormFrom: number | null;
  readonly reportsRunning: { n: number };
  readonly stopAt: number;
}

export async function runFridayPeak(cfg: LoadConfig, opts: LoadOptions): Promise<LoadReport> {
  const log = opts.log ?? (() => undefined);
  const start = Date.now();
  const shared: Shared = {
    samples: [],
    reportMs: [],
    paymentMs: [],
    failures: [],
    counts: { orders: 0, rounds: 0, tabs: 0, payments: 0, reports: 0, reconnects: 0 },
    start,
    stormFrom: null,
    reportsRunning: { n: 0 },
    stopAt: start + opts.peakMs,
  };
  const venues = await Promise.all(
    cfg.venues.map((v) => VenueRun.open(cfg.apiUrl, v, opts, shared)),
  );
  log(`load: ${venues.length} venues ready, peak for ${Math.round(opts.peakMs / 1000)} s`);
  const storm = (async () => {
    await sleep(start + opts.stormAtMs - Date.now());
    if (Date.now() >= shared.stopAt) return;
    shared.stormFrom = Date.now();
    log("load: reconnect storm, every device at once");
    await Promise.all(venues.map((v) => v.reconnectAll()));
  })();
  await Promise.all([...venues.map((v) => v.peak()), storm]);
  log("load: peak over; paying the rooms and closing the tabs");
  await Promise.all(venues.map((v) => v.settleUp()));
  for (const v of venues) v.close();

  const target = TARGETS.orderToAlarm.thresholdMs;
  const all = shared.samples.map((s) => s.ms);
  const inStorm = shared.samples.filter((s) => s.inStorm).map((s) => s.ms);
  const duringReports = shared.samples.filter((s) => s.duringReport).map((s) => s.ms);
  const sumWithin = (xs: number[]) => ({ ...summarize(xs), within: shareWithin(xs, target) });
  const alarm = {
    ...sumWithin(all),
    viaPoll: shared.samples.filter((s) => s.via === "poll").length,
  };
  const alarmInStorm = sumWithin(inStorm);
  const alarmDuringReports = sumWithin(duringReports);
  const under = (s: Summary) => s.p95 === null || s.p95 < target;
  return {
    venues: venues.length,
    peakMs: opts.peakMs,
    targetMs: target,
    alarm,
    alarmInStorm,
    alarmDuringReports,
    slowest: [...shared.samples].sort((a, b) => b.ms - a.ms).slice(0, 5),
    reports: summarize(shared.reportMs),
    payments: summarize(shared.paymentMs),
    counts: { ...shared.counts },
    failures: shared.failures,
    passed:
      alarm.count > 0 &&
      under(alarm) &&
      under(alarmInStorm) &&
      under(alarmDuringReports) &&
      shared.failures.length === 0,
  };
}

type Who = "device" | "staff" | "owner" | "guest" | "public";

interface Socket {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
  close(): void;
}
type SocketCtor = new (url: string) => Socket;

interface Room {
  readonly roomId: string;
  readonly checkId: string;
  cookie: string;
}

class VenueRun {
  private token = "";
  private sockets: Socket[] = [];
  /** Order id → when the bar saw it ring, and how. */
  private readonly rang = new Map<string, { at: number; via: "event" | "poll" }>();
  private readonly waiting = new Map<string, () => void>();
  private readonly rooms: Room[] = [];
  private readonly tabs: { id: string; checkId: string }[] = [];
  private readonly readerLocks: Mutex[];
  private consentVersion: string | null = null;

  private constructor(
    private readonly base: string,
    private readonly v: LoadVenue,
    private readonly opts: LoadOptions,
    private readonly shared: Shared,
    private readonly key: webcrypto.CryptoKey,
  ) {
    this.readerLocks = v.readers.map(() => new Mutex());
  }

  static async open(apiUrl: string, v: LoadVenue, opts: LoadOptions, shared: Shared) {
    const key = await webcrypto.subtle.importKey("jwk", v.deviceKey, DEVICE_KEY_ALGORITHM, false, [
      "sign",
    ]);
    const run = new VenueRun(apiUrl.replace(/\/+$/, ""), v, opts, shared, key);
    await run.prepare();
    return run;
  }

  private fail(step: string, e: unknown) {
    this.shared.failures.push({
      venue: this.v.slug,
      step,
      what: e instanceof Error ? e.message : String(e),
    });
  }

  private async call<T>(
    step: string,
    who: Who,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
    room?: Room,
  ): Promise<{ body: T; cookie: string | null }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (who === "device" || who === "staff")
      Object.assign(
        headers,
        await signDeviceRequest({
          deviceId: this.v.deviceId,
          privateKey: this.key,
          method,
          path,
          body: payload ?? "",
        }),
      );
    if (who === "staff") headers["authorization"] = `Bearer ${this.token}`;
    if (who === "owner") headers["authorization"] = `Bearer ${this.v.ownerToken}`;
    if (who === "guest" && room) headers["cookie"] = room.cookie;
    if (method === "POST" && (who === "staff" || who === "owner"))
      headers["idempotency-key"] ??= crypto.randomUUID();
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch (e) {
      throw new StepFailed(step, `network: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let code = "";
      try {
        const err = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
        code = `${err?.code ?? ""} (${err?.message ?? ""})`;
      } catch {
        // Not JSON: the status alone.
      }
      throw new StepFailed(
        step,
        `${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}: ${res.status} ${code}`.trim(),
      );
    }
    const set = res.headers.getSetCookie?.() ?? [];
    const roomCookie = set.find((c) => c.startsWith("west4_room="));
    return {
      body: (text === "" ? {} : JSON.parse(text)) as T,
      cookie: roomCookie ? roomCookie.split(";")[0]! : null,
    };
  }

  private async prepare(): Promise<void> {
    const v = this.v.venueId;
    const signedIn = await this.call<{ token?: string }>(
      "sign_in",
      "device",
      "POST",
      "/v1/auth/pin",
      {
        membership_id: this.v.bartender.membershipId,
        pin: this.v.bartender.pin,
        client: "shared",
      },
    );
    if (!signedIn.body.token) throw new StepFailed("sign_in", "no session token");
    this.token = signedIn.body.token;
    await this.connectAll();
    const seats = this.v.rooms.slice(0, this.opts.roomsPerVenue);
    for (const roomId of seats) {
      const seated = await this.call<{ check_id: string; room_code: string }>(
        "seat",
        "staff",
        "POST",
        `/v1/venues/${v}/rooms/${roomId}/sessions`,
        { party_size: 6, ids_checked: 0, minutes: 120 },
      );
      const joined = await this.call(
        "join",
        "public",
        "POST",
        `/v1/public/venues/${this.v.slug}/rooms/${roomId}/join`,
        { code: seated.body.room_code },
      );
      if (!joined.cookie) throw new StepFailed("join", "no room cookie");
      this.rooms.push({ roomId, checkId: seated.body.check_id, cookie: joined.cookie });
    }
    const consent = await this.call<{ version_id: string }>(
      "tab",
      "staff",
      "GET",
      `/v1/venues/${v}/tabs/consent`,
    );
    this.consentVersion = consent.body.version_id;
  }

  /** Every live connection of the venue; the first is the bar's, which hears the ring. */
  private async connectAll(): Promise<void> {
    const Ctor = (globalThis as { WebSocket?: SocketCtor }).WebSocket;
    if (!Ctor) throw new Error("this Node has no WebSocket");
    const wsBase = this.base.replace(/^http/, "ws");
    const opened: Promise<void>[] = [];
    for (let i = 0; i < this.opts.socketsPerVenue; i++) {
      const path = await signDeviceSocketPath({
        deviceId: this.v.deviceId,
        privateKey: this.key,
        path: `/v1/venues/${this.v.venueId}/events?locked=1`,
      });
      const ws = new Ctor(`${wsBase}${path}`);
      const bar = i === 0;
      opened.push(
        new Promise<void>((ready) => {
          ws.onmessage = (ev) => {
            let msg: { type?: string; id?: string };
            try {
              msg = JSON.parse(String(ev.data)) as { type?: string; id?: string };
            } catch {
              return;
            }
            if (msg.type === "hello" || msg.type === "caught_up") ready();
            if (bar && msg.type === "order.ringing" && msg.id) this.heard(msg.id, "event");
          };
          ws.onerror = () => ready();
          setTimeout(ready, 3_000);
        }),
      );
      this.sockets.push(ws);
    }
    await Promise.all(opened);
  }

  async reconnectAll(): Promise<void> {
    const old = this.sockets;
    this.sockets = [];
    for (const ws of old) {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
    this.shared.counts.reconnects += old.length;
    await this.connectAll();
  }

  close(): void {
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
  }

  private heard(orderId: string, via: "event" | "poll") {
    if (this.rang.has(orderId)) return;
    this.rang.set(orderId, { at: Date.now(), via });
    this.waiting.get(orderId)?.();
  }

  private live = () => Date.now() < this.shared.stopAt;

  async peak(): Promise<void> {
    const loops: Promise<void>[] = [
      ...this.rooms.map((room) => this.roomLoop(room)),
      this.barPoll(),
      this.roundLoop(),
      this.reportLoop(),
    ];
    for (let i = 0; i < this.opts.tabsPerVenue; i++) loops.push(this.openTab(i));
    await Promise.all(loops);
  }

  /** The bar's own poll, as the staff app's fallback: what's ringing or held right now. */
  private async barPoll(): Promise<void> {
    const every = this.opts.barPollMs ?? 5_000;
    while (this.live()) {
      await sleep(every);
      try {
        const r = await this.call<{ orders: { id: string }[] }>(
          "poll",
          "device",
          "GET",
          `/v1/venues/${this.v.venueId}/orders?status=ringing,held`,
        );
        for (const o of r.body.orders) this.heard(o.id, "poll");
      } catch (e) {
        this.fail("poll", e);
      }
    }
  }

  private async roomLoop(room: Room): Promise<void> {
    await sleep(Math.random() * this.opts.orderEveryMs);
    while (this.live()) {
      try {
        await this.order(room);
      } catch (e) {
        this.fail(e instanceof StepFailed ? e.step : "order", e);
      }
      await sleep(gap(this.opts.orderEveryMs));
    }
  }

  private async order(room: Room): Promise<void> {
    const sentAt = Date.now();
    const duringReport = this.shared.reportsRunning.n > 0;
    const placed = await this.call<{ order: { id: string } }>(
      "order",
      "guest",
      "POST",
      "/v1/public/room-session/orders",
      {
        client_order_id: `load-${crypto.randomUUID()}`,
        lines: [{ variant_id: this.v.sodaVariant, qty: 1, option_ids: [] }],
      },
      { traceparent: newTraceparent() },
      room,
    );
    this.shared.counts.orders += 1;
    const orderId = placed.body.order.id;
    if (!this.rang.has(orderId)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.ringTimeoutMs ?? 15_000);
        this.waiting.set(orderId, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.waiting.delete(orderId);
    }
    const heard = this.rang.get(orderId);
    if (!heard) throw new StepFailed("ring", "the bar never saw the order ring");
    const storm = this.shared.stormFrom;
    this.shared.samples.push({
      venue: this.v.slug,
      orderId,
      ms: heard.at - sentAt,
      via: heard.via,
      sentAt,
      inStorm: storm !== null && sentAt >= storm - 1_000 && sentAt < storm + STORM_WINDOW_MS,
      duringReport: duringReport || this.shared.reportsRunning.n > 0,
    });
    const v = this.v.venueId;
    // The alarm closes the order's trace (M8-16), and the bartender accepts: sold at Accept.
    await this.call("ring", "device", "POST", `/v1/venues/${v}/orders/${orderId}/rang`);
    await this.call("accept", "staff", "POST", `/v1/venues/${v}/orders/${orderId}/accept`, {});
  }

  private async roundLoop(): Promise<void> {
    while (this.live()) {
      await sleep(gap(this.opts.roundEveryMs));
      if (!this.live()) break;
      const checks = [...this.rooms.map((r) => r.checkId), ...this.tabs.map((t) => t.checkId)];
      const checkId = checks[Math.floor(Math.random() * checks.length)];
      if (!checkId) continue;
      try {
        await this.call(
          "round",
          "staff",
          "POST",
          `/v1/venues/${this.v.venueId}/checks/${checkId}/orders`,
          {
            client_order_id: `load-round-${crypto.randomUUID()}`,
            lines: [{ variant_id: this.v.sodaVariant, qty: 2 }],
          },
        );
        this.shared.counts.rounds += 1;
      } catch (e) {
        this.fail("round", e);
      }
    }
  }

  private async reportLoop(): Promise<void> {
    await sleep(Math.random() * this.opts.reportEveryMs);
    while (this.live()) {
      const t = Date.now();
      this.shared.reportsRunning.n += 1;
      try {
        await this.call("report", "owner", "GET", `/v1/venues/${this.v.venueId}/reports/sales`);
        this.shared.reportMs.push(Date.now() - t);
        this.shared.counts.reports += 1;
      } catch (e) {
        this.fail("report", e);
      } finally {
        this.shared.reportsRunning.n -= 1;
      }
      await sleep(this.opts.reportEveryMs);
    }
  }

  /** Presents Stripe's test card on a reader and waits for the payment to settle. */
  private async tapAndWait(
    step: string,
    readerId: string,
    poll: () => Promise<"done" | "waiting" | string>,
    present?: () => Promise<void>,
  ): Promise<void> {
    const v = this.v.venueId;
    // The reader's action is sent after the request's transaction commits (never inside it), so
    // it can land a moment after the response: a card presented before then finds "No action in
    // progress". A guest holds the card out until the reader asks for it, so the harness waits
    // for the action (up to 10 s) rather than counting that as a failure. Nothing is charged twice:
    // presenting a card to an idle reader does nothing.
    const presentOnce = present
      ? async () => {
          try {
            await present();
          } catch (e) {
            throw new StepFailed(
              step,
              `presenting the card: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      : async () => {
          await this.call(
            step,
            "staff",
            "POST",
            `/v1/venues/${v}/readers/${readerId}/test-card`,
            {},
          );
        };
    const presentBy = Date.now() + 10_000;
    for (;;) {
      try {
        await presentOnce();
        break;
      } catch (e) {
        const idle = e instanceof Error && e.message.includes("No action in progress");
        if (!idle || Date.now() >= presentBy) throw e;
        await sleep(200);
      }
    }
    const deadline = Date.now() + 25_000;
    for (;;) {
      const state = await poll();
      if (state === "done") return;
      if (state !== "waiting") throw new StepFailed(step, `ended ${state}`);
      if (Date.now() >= deadline) throw new StepFailed(step, "still waiting after 25 s");
      await sleep(500);
    }
  }

  private async openTab(i: number): Promise<void> {
    const v = this.v.venueId;
    const r = i % this.v.readers.length;
    const readerId = this.v.readers[r]!;
    try {
      await this.readerLocks[r]!.run(async () => {
        const opened = await this.call<{ id: string }>(
          "tab",
          "staff",
          "POST",
          `/v1/venues/${v}/tabs`,
          {
            reader_id: readerId,
            consent_text_version: this.consentVersion,
            name: `Load tab ${i + 1}`,
          },
        );
        const o = opened.body.id;
        let tab: { id: string; check_id: string } | null = null;
        const present = this.opts.presentCard
          ? () => this.opts.presentCard!(this.v, r, TEST_CARDS[i % TEST_CARDS.length]!, `${o}`)
          : undefined;
        await this.tapAndWait(
          "tab",
          readerId,
          async () => {
            const s = await this.call<{
              state: string;
              payment: { state: string };
              tab: { id: string; check_id: string } | null;
            }>("tab", "staff", "POST", `/v1/venues/${v}/tabs/openings/${o}/check-status`);
            if (s.body.tab) {
              tab = s.body.tab;
              return "done";
            }
            return ["declined", "failed", "canceled", "unknown"].includes(s.body.payment.state)
              ? s.body.payment.state
              : "waiting";
          },
          present,
        );
        const t = tab as { id: string; check_id: string } | null;
        if (!t) throw new StepFailed("tab", "the opening named no tab");
        // A card already on a tab opens nothing new: the opening names that tab (as at the bar).
        if (this.tabs.some((x) => x.id === t.id)) return;
        this.tabs.push({ id: t.id, checkId: t.check_id });
        // The first round: a tab is opened to order.
        await this.call("round", "staff", "POST", `/v1/venues/${v}/checks/${t.check_id}/orders`, {
          client_order_id: `load-round-${crypto.randomUUID()}`,
          lines: [{ variant_id: this.v.sodaVariant, qty: 2 }],
        });
        this.shared.counts.rounds += 1;
        this.shared.counts.tabs += 1;
      });
    } catch (e) {
      this.fail("tab", e);
    }
  }

  /** After the peak: each room pays what it owes by card; each tab closes with no tip. */
  async settleUp(): Promise<void> {
    const v = this.v.venueId;
    const pays = this.rooms.map(async (room, i) => {
      const r = i % this.v.readers.length;
      const readerId = this.v.readers[r]!;
      try {
        await this.readerLocks[r]!.run(async () => {
          const check = await this.call<{ amount_due_cents: number }>(
            "pay",
            "staff",
            "GET",
            `/v1/venues/${v}/checks/${room.checkId}`,
          );
          if (!(check.body.amount_due_cents > 0)) return;
          const t = Date.now();
          const tapped = await this.call<{ id: string }>(
            "pay",
            "staff",
            "POST",
            `/v1/venues/${v}/checks/${room.checkId}/payments`,
            { method: "tap", amount_cents: check.body.amount_due_cents, reader_id: readerId },
          );
          const paymentId = tapped.body.id;
          await this.tapAndWait("pay", readerId, async () => {
            await this.call(
              "pay",
              "staff",
              "POST",
              `/v1/venues/${v}/payments/${paymentId}/check-status`,
              {},
            );
            const p = await this.call<{ state: string }>(
              "pay",
              "staff",
              "GET",
              `/v1/venues/${v}/payments/${paymentId}`,
            );
            if (p.body.state === "paid") return "done";
            return ["declined", "failed", "canceled", "unknown"].includes(p.body.state)
              ? p.body.state
              : "waiting";
          });
          this.shared.paymentMs.push(Date.now() - t);
          this.shared.counts.payments += 1;
        });
      } catch (e) {
        this.fail("pay", e);
      }
    });
    const closes = this.tabs.map(async (tab) => {
      try {
        const closed = await this.call<{ state: string }>(
          "close_tab",
          "staff",
          "POST",
          `/v1/venues/${v}/tabs/${tab.id}/close`,
          { tip: "none", reader_id: null },
        );
        // The capture runs a moment after the answer (Stripe's own time): wait for it, as the screen does.
        let state = closed.body.state;
        const deadline = Date.now() + 25_000;
        while (state === "capturing" || state === "raising") {
          if (Date.now() >= deadline)
            throw new StepFailed("close_tab", `still ${state} after 25 s`);
          await sleep(500);
          state = (
            await this.call<{ state: string }>(
              "close_tab",
              "staff",
              "POST",
              `/v1/venues/${v}/tabs/${tab.id}/close/check-status`,
            )
          ).body.state;
        }
        if (state !== "captured") throw new StepFailed("close_tab", `the tab closed ${state}`);
        this.shared.counts.payments += 1;
      } catch (e) {
        this.fail("close_tab", e);
      }
    });
    await Promise.all([...pays, ...closes]);
  }
}

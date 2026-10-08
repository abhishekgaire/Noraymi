import type { webcrypto } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import {
  closureOn,
  enqueue,
  readSetting,
  withVenue,
  type JobHandler,
  type Queryable,
  type Sweep,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import {
  DEVICE_KEY_ALGORITHM,
  TARGETS,
  newTraceparent,
  signDeviceRequest,
  signDeviceSocketPath,
  type Temporal,
} from "@west4/shared";
import { telemetry } from "../telemetry/index.js";
import { setAutoStatus } from "../telemetry/status.js";
import { clearPages, raisePage } from "./paging.js";
import { syntheticSlot, type LiveVenueHours } from "./synthetic-schedule.js";

/**
 * The synthetic check (M8-18; spec 13 · Watching production): every 5 minutes during opening hours
 * a job plays one room order and one reader payment on our own test venue, through the public API
 * exactly as the room page, the bar computer and a bartender do: a synthetic bar device (a paired
 * bar computer in training mode, whose key the worker holds) signs a bartender in with a PIN, seats
 * a practice walk-in, a guest joins with the room code and orders, the device waits for the bar's
 * alarm on the live event channel (the bar's 5-second poll as the fallback) and reports it (which
 * closes the order's trace for the order-to-alarm target), the bartender accepts it, and a tap on
 * a simulated reader is paid with Stripe's test card. Everything is practice (M7-03/M7-04), so it
 * runs on the sandbox and never touches live money or the live webhook endpoints, and it happens at
 * a venue of its own, behind the venue wall, with the `synthetic.test_venue` flag on.
 *
 * A failed step pages us (rule `synthetic-check`, its runbook) on that run; a passing run clears
 * it. Room ordering's part of the status page follows the ordering steps.
 */
export const SYNTHETIC_KIND = "synthetic.check";
export const SYNTHETIC_FLAG = "synthetic.test_venue";
export const SYNTHETIC_SWEEP_EVERY_MS = 30_000;
/** As often as the bar computer's fallback poll (CHIME_CHECK_MS in the staff app). */
export const BAR_POLL_MS = 5_000;

export const syntheticConfigSchema = z
  .object({
    /** Where the API answers, as the room page and the bar reach it. */
    api_url: z.string().url(),
    venue_id: z.string().uuid(),
    venue_slug: z.string().min(1),
    device_id: z.string().uuid(),
    /** The synthetic bar device's private key (ECDSA P-256, as a JWK). */
    device_key: z.record(z.string(), z.unknown()),
    membership_id: z.string().uuid(),
    pin: z.string().regex(/^\d{4,6}$/),
    room_id: z.string().uuid(),
    /** A simulated reader of the venue (practice). */
    reader_id: z.string().uuid(),
    /** Something without alcohol to order. */
    variant_id: z.string().uuid(),
  })
  .strict();
export type SyntheticConfig = z.infer<typeof syntheticConfigSchema>;

/** SYNTHETIC_CHECK, a JSON secret written by `synthetic:setup`. Unset: the check is off. */
export function loadSyntheticConfig(
  env: Record<string, string | undefined> = process.env,
): SyntheticConfig | null {
  const raw = env["SYNTHETIC_CHECK"];
  if (raw === undefined || raw.trim() === "") return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("SYNTHETIC_CHECK is not JSON");
  }
  const parsed = syntheticConfigSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(
      `SYNTHETIC_CHECK: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  return parsed.data;
}

export type SyntheticStep =
  "sign_in" | "seat" | "join" | "order" | "ring" | "accept" | "tap" | "test_card" | "paid";

/** Which part of the night a failed step belongs to. */
export const STEP_PART: Record<SyntheticStep, "setup" | "ordering" | "payments"> = {
  sign_in: "setup",
  seat: "setup",
  join: "ordering",
  order: "ordering",
  ring: "ordering",
  accept: "ordering",
  tap: "payments",
  test_card: "payments",
  paid: "payments",
};

export interface SyntheticResult {
  readonly ok: boolean;
  readonly failedStep: SyntheticStep | null;
  readonly error: string | null;
  /** From sending the order to the bar device seeing it ring, on the worker's own clock. */
  readonly orderToAlarmMs: number | null;
  /** How the ring reached the device: the live event or the fallback poll. */
  readonly ringVia: "event" | "poll" | null;
  /** From the tap to the payment showing paid. */
  readonly paymentMs: number | null;
}

/** The smallest WebSocket the check needs (Node 22's global one, or a test's). */
export interface SocketLikeCtor {
  new (url: string): {
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    close(): void;
  };
}

export interface SyntheticDeps {
  readonly fetch?: typeof fetch;
  readonly WebSocket?: SocketLikeCtor | null;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly ringTimeoutMs?: number;
  readonly paymentTimeoutMs?: number;
  readonly barPollMs?: number;
  readonly paymentPollMs?: number;
}

class StepFailed extends Error {
  constructor(
    readonly step: SyntheticStep,
    message: string,
  ) {
    super(message);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One run of the check. Never throws: a failure is the result, with its step. */
export async function runSyntheticCheck(
  cfg: SyntheticConfig,
  deps: SyntheticDeps = {},
): Promise<SyntheticResult> {
  const doFetch = deps.fetch ?? fetch;
  const nowMs = deps.nowMs ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const Socket =
    deps.WebSocket === undefined
      ? ((globalThis as { WebSocket?: SocketLikeCtor }).WebSocket ?? null)
      : deps.WebSocket;
  const base = cfg.api_url.replace(/\/+$/, "");
  const v = cfg.venue_id;
  const key = await crypto.subtle.importKey(
    "jwk",
    cfg.device_key as webcrypto.JsonWebKey,
    DEVICE_KEY_ALGORITHM,
    false,
    ["sign"],
  );
  let token: string | null = null;
  let cookie: string | null = null;

  type Who = "device" | "staff" | "guest" | "public";
  const call = async <T>(
    step: SyntheticStep,
    who: Who,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<T> => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (who === "device" || who === "staff")
      Object.assign(
        headers,
        await signDeviceRequest({
          deviceId: cfg.device_id,
          privateKey: key,
          method,
          path,
          body: payload ?? "",
        }),
      );
    if (who === "staff" && token) headers["authorization"] = `Bearer ${token}`;
    if (who === "guest" && cookie) headers["cookie"] = cookie;
    if (method === "POST" && who === "staff") headers["idempotency-key"] ??= crypto.randomUUID();
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch (e) {
      throw new StepFailed(step, `network: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let code = String(res.status);
      try {
        code = `${res.status} ${(JSON.parse(text) as { error?: { code?: string } }).error?.code ?? ""}`;
      } catch {
        // Not JSON: the status alone.
      }
      throw new StepFailed(
        step,
        `${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}: ${code.trim()}`,
      );
    }
    if (who === "public" || who === "guest") {
      const set = res.headers.getSetCookie?.() ?? [];
      const room = set.find((c) => c.startsWith("west4_room="));
      if (room) cookie = room.split(";")[0]!;
    }
    return (text === "" ? {} : JSON.parse(text)) as T;
  };

  let sessionId: string | null = null;
  let paymentId: string | null = null;
  let orderToAlarmMs: number | null = null;
  let ringVia: "event" | "poll" | null = null;
  let paymentMs: number | null = null;
  try {
    // 1. A bartender signs in on the synthetic bar device.
    const signedIn = await call<{ token?: string }>("sign_in", "device", "POST", "/v1/auth/pin", {
      membership_id: cfg.membership_id,
      pin: cfg.pin,
      client: "shared",
    });
    if (!signedIn.token) throw new StepFailed("sign_in", "no session token");
    token = signedIn.token;

    // 2. A practice walk-in in the test room: its own check and room code.
    const seated = await call<{ session_id: string; check_id: string; room_code: string }>(
      "seat",
      "staff",
      "POST",
      `/v1/venues/${v}/rooms/${cfg.room_id}/sessions`,
      { party_size: 1, ids_checked: 0, minutes: 15 },
    );
    sessionId = seated.session_id;

    // 3. A guest's phone joins with the code.
    await call(
      "join",
      "public",
      "POST",
      `/v1/public/venues/${cfg.venue_slug}/rooms/${cfg.room_id}/join`,
      {
        code: seated.room_code,
      },
    );
    if (!cookie) throw new StepFailed("join", "no room cookie");

    // 4. The bar device listens for the ring before the order goes in.
    const ring = await listenForRing(Socket, base, cfg, key);
    let placed: { order: { id: string } };
    const sentAt = nowMs();
    try {
      placed = await call<{ order: { id: string } }>(
        "order",
        "guest",
        "POST",
        "/v1/public/room-session/orders",
        {
          client_order_id: `synthetic-${crypto.randomUUID()}`,
          lines: [{ variant_id: cfg.variant_id, qty: 1, option_ids: [] }],
        },
        { traceparent: newTraceparent() },
      );
    } catch (e) {
      ring.close();
      throw e;
    }
    const orderId = placed.order.id;

    // 5. The ring: the live event, or the bar's own poll if the event never comes.
    const deadline = sentAt + (deps.ringTimeoutMs ?? 15_000);
    const pollEvery = deps.barPollMs ?? BAR_POLL_MS;
    let nextPoll = sentAt + pollEvery;
    try {
      while (ringVia === null) {
        if (ring.seen.has(orderId)) {
          ringVia = "event";
          orderToAlarmMs = ring.seen.get(orderId)! - sentAt;
          break;
        }
        const t = nowMs();
        if (t >= deadline) throw new StepFailed("ring", "the bar device never saw the order ring");
        if (t >= nextPoll) {
          nextPoll = t + pollEvery;
          const r = await call<{ orders: { id: string }[] }>(
            "ring",
            "device",
            "GET",
            `/v1/venues/${v}/orders?status=ringing,held`,
          );
          if (r.orders.some((o) => o.id === orderId)) {
            ringVia = "poll";
            orderToAlarmMs = nowMs() - sentAt;
            break;
          }
        }
        await ring.next(Math.min(nextPoll, deadline) - nowMs());
      }
    } finally {
      ring.close();
    }
    // The alarm closes the order's trace: the order-to-alarm target counts it (M8-16).
    await call("ring", "device", "POST", `/v1/venues/${v}/orders/${orderId}/rang`);

    // 6. The bartender accepts it: sold at Accept.
    await call("accept", "staff", "POST", `/v1/venues/${v}/orders/${orderId}/accept`, {});

    // 7. A tap on the simulated reader for what's due, paid with Stripe's test card.
    const check = await call<{ amount_due_cents: number }>(
      "tap",
      "staff",
      "GET",
      `/v1/venues/${v}/checks/${seated.check_id}`,
    );
    if (!(check.amount_due_cents > 0)) throw new StepFailed("tap", "nothing due on the check");
    const tapAt = nowMs();
    const tapped = await call<{ id: string; training?: boolean }>(
      "tap",
      "staff",
      "POST",
      `/v1/venues/${v}/checks/${seated.check_id}/payments`,
      { method: "tap", amount_cents: check.amount_due_cents, reader_id: cfg.reader_id },
    );
    paymentId = tapped.id;
    if (tapped.training !== true) throw new StepFailed("tap", "the payment wasn't practice");
    await call(
      "test_card",
      "staff",
      "POST",
      `/v1/venues/${v}/readers/${cfg.reader_id}/test-card`,
      {},
    );
    const payDeadline = tapAt + (deps.paymentTimeoutMs ?? 25_000);
    for (;;) {
      await call("paid", "staff", "POST", `/v1/venues/${v}/payments/${paymentId}/check-status`, {});
      const p = await call<{ state: string }>(
        "paid",
        "staff",
        "GET",
        `/v1/venues/${v}/payments/${paymentId}`,
      );
      if (p.state === "paid") break;
      if (["declined", "failed", "canceled", "unknown"].includes(p.state))
        throw new StepFailed("paid", `the payment ended ${p.state}`);
      if (nowMs() >= payDeadline) throw new StepFailed("paid", `still ${p.state}`);
      await sleep(deps.paymentPollMs ?? 1_000);
    }
    paymentId = null;
    paymentMs = nowMs() - tapAt;
    return { ok: true, failedStep: null, error: null, orderToAlarmMs, ringVia, paymentMs };
  } catch (e) {
    const failed =
      e instanceof StepFailed
        ? e
        : new StepFailed("sign_in", e instanceof Error ? e.message : String(e));
    return {
      ok: false,
      failedStep: failed.step,
      error: failed.message,
      orderToAlarmMs,
      ringVia,
      paymentMs,
    };
  } finally {
    // Leave nothing open: a stuck practice payment is cancelled, the practice session ends.
    if (token) {
      if (paymentId)
        await call(
          "paid",
          "staff",
          "POST",
          `/v1/venues/${v}/payments/${paymentId}/cancel`,
          {},
        ).catch(() => undefined);
      if (sessionId)
        await call("seat", "staff", "POST", `/v1/venues/${v}/sessions/${sessionId}/end`, {}).catch(
          () => undefined,
        );
      await call("sign_in", "staff", "POST", "/v1/auth/logout", {}).catch(() => undefined);
    }
  }
}

interface RingListener {
  /** Each ringing order the socket told us about, with when (worker clock, ms). */
  readonly seen: Map<string, number>;
  /** Waits up to `ms`, returning early when an event arrives. */
  next(ms: number): Promise<void>;
  close(): void;
}

/**
 * The bar device's live channel (M1-09): the same signed socket a locked bar computer opens, which
 * carries ring state. No socket (none in this runtime, or it won't open): only the poll is left.
 */
async function listenForRing(
  Socket: SocketLikeCtor | null,
  base: string,
  cfg: SyntheticConfig,
  key: DeviceKey,
): Promise<RingListener> {
  const seen = new Map<string, number>();
  let wake: (() => void) | null = null;
  const next = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          wake = null;
          resolve();
        },
        Math.max(0, ms),
      );
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  if (!Socket) return { seen, next, close: () => undefined };
  const path = await signDeviceSocketPath({
    deviceId: cfg.device_id,
    privateKey: key,
    path: `/v1/venues/${cfg.venue_id}/events?locked=1`,
  });
  let ws: InstanceType<SocketLikeCtor>;
  try {
    ws = new Socket(`${base.replace(/^http/, "ws")}${path}`);
  } catch {
    return { seen, next, close: () => undefined };
  }
  let ready: () => void = () => undefined;
  const opened = new Promise<void>((r) => (ready = r));
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type?: string; id?: string };
      if (msg.type === "hello" || msg.type === "caught_up") ready();
      if (msg.type === "order.ringing" && msg.id && !seen.has(msg.id)) {
        seen.set(msg.id, Date.now());
        wake?.();
      }
    } catch {
      // Not ours to judge: the poll still runs.
    }
  };
  ws.onerror = () => ready();
  // Up to a second for the socket's hello, so the order can't ring before we listen.
  await Promise.race([opened, new Promise((r) => setTimeout(r, 1_000))]);
  return {
    seen,
    next,
    close: () => {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    },
  };
}

type DeviceKey = Parameters<typeof signDeviceRequest>[0]["privateKey"];

export const SYNTHETIC_PAGE_KEY = "synthetic-check";

/** What a run means for us: a page on a failure (cleared by the next pass), room ordering's status. */
export async function applySyntheticResult(
  pool: pg.Pool,
  venueId: string,
  r: SyntheticResult,
  now: Temporal.Instant,
): Promise<{ paged: boolean }> {
  const t = telemetry();
  t.count("synthetic_runs", 1, { venue: venueId, ok: r.ok, step: r.failedStep ?? "none" });
  if (r.orderToAlarmMs !== null)
    t.observe("synthetic_order_to_alarm_ms", r.orderToAlarmMs, {
      venue: venueId,
      via: r.ringVia ?? "none",
      slow: r.orderToAlarmMs >= TARGETS.orderToAlarm.thresholdMs,
    });
  if (r.paymentMs !== null) t.observe("synthetic_payment_ms", r.paymentMs, { venue: venueId });
  const part = r.failedStep ? STEP_PART[r.failedStep] : null;
  await setAutoStatus(
    pool,
    "ordering",
    part === "ordering" ? "degraded" : "operational",
    null,
    now.toString(),
  ).catch(() => false);
  if (r.ok) {
    await clearPages(pool, "synthetic-check", [], now);
    return { paged: false };
  }
  const made = await raisePage(
    pool,
    {
      rule: "synthetic-check",
      key: SYNTHETIC_PAGE_KEY,
      summary: `The synthetic check failed at ${r.failedStep} (${part}) at venue ${venueId}: ${r.error ?? ""}`,
    },
    now,
  );
  return { paged: made?.opened ?? false };
}

/** Whether a venue is our own test venue: only there may the check run. */
export async function isTestVenue(c: Queryable, venueId: string): Promise<boolean> {
  const r = await c.query<{ on: boolean }>(
    `select "on" from venue_flags where venue_id = $1 and flag = $2`,
    [venueId, SYNTHETIC_FLAG],
  );
  return r.rows[0]?.on === true;
}

/** The job: runs the check on the test venue, then pages or clears. */
export function makeSyntheticHandler(
  pool: pg.Pool,
  cfg: SyntheticConfig,
  deps: SyntheticDeps = {},
  log?: (line: string) => void,
): JobHandler {
  return async (ctx) => {
    if (
      ctx.job.venue_id !== cfg.venue_id ||
      !(await ctx.step((c) => isTestVenue(c, cfg.venue_id)))
    ) {
      log?.(`synthetic: venue ${ctx.job.venue_id} isn't the test venue; nothing run`);
      return;
    }
    const r = await runSyntheticCheck(cfg, deps);
    const { paged } = await applySyntheticResult(pool, cfg.venue_id, r, ctx.clock.now());
    log?.(
      r.ok
        ? `synthetic: ok · order to alarm ${r.orderToAlarmMs} ms (${r.ringVia}) · paid in ${r.paymentMs} ms`
        : `synthetic: failed at ${r.failedStep}: ${r.error}${paged ? " · paged" : ""}`,
    );
  };
}

/** Every live venue's hours now, and whether the configured test venue is flagged. */
export async function syntheticVenues(
  pool: pg.Pool,
  testVenueId: string,
  now: Temporal.Instant,
): Promise<{ live: LiveVenueHours[]; testVenueReady: boolean }> {
  const venues = await pool.query<{ id: string; time_zone: string; day_cutover: string }>(
    "select id, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues_for_scheduler()",
  );
  const live: LiveVenueHours[] = [];
  let testVenueReady = false;
  for (const v of venues.rows) {
    await withVenue(pool, { venueId: v.id, requestId: "synthetic" }, async (c) => {
      if (await isTestVenue(c, v.id)) {
        if (v.id === testVenueId) testVenueReady = true;
        return;
      }
      const date = businessDate(now, v.time_zone, v.day_cutover).businessDate;
      const [hours, closure] = await Promise.all([
        readSetting(c, v.id, "hours", date),
        closureOn(c, v.id, date.toString()),
      ]);
      live.push({
        time: { timeZone: v.time_zone, dayCutover: v.day_cutover },
        hours: hours?.value ?? null,
        closure,
      });
    });
  }
  return { live, testVenueReady };
}

/** The scheduler's part: one job per 5-minute slot inside the live venues' hours. */
export async function scheduleSynthetic(
  pool: pg.Pool,
  cfg: SyntheticConfig,
  now: Temporal.Instant,
): Promise<string | null> {
  const { live, testVenueReady } = await syntheticVenues(pool, cfg.venue_id, now);
  if (!testVenueReady) return null;
  const slot = syntheticSlot(live, now);
  if (!slot) return null;
  return withVenue(pool, { venueId: cfg.venue_id, requestId: "synthetic" }, (c) =>
    enqueue(c, {
      venueId: cfg.venue_id,
      kind: SYNTHETIC_KIND,
      pool: "normal",
      runAt: now,
      dedupeKey: `synthetic:${slot.toString()}`,
      maxAttempts: 1,
    }),
  );
}

export function syntheticSweep(
  pool: pg.Pool,
  cfg: SyntheticConfig,
  log?: (line: string) => void,
): Sweep {
  return {
    name: "synthetic.schedule",
    everyMs: SYNTHETIC_SWEEP_EVERY_MS,
    run: async (now) => {
      const id = await scheduleSynthetic(pool, cfg, now);
      if (id) log?.(`synthetic: run ${id} queued`);
    },
  };
}

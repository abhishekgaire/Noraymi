import type { StripeSettings } from "./settings.js";

/**
 * The token bucket in front of Stripe (M8-21; spec 13 · Capacity). Stripe answers 429 above its
 * rate (100 requests a second live, 25 in test mode), and a Friday with every venue peaking, or
 * every swept slip captured at once, could get there. Each call takes a token before it's sent;
 * with none left it waits for the next one, so a burst is spread out instead of refused. Tokens
 * come back at `ratePerSecond`, and up to `burst` are kept. Per process: the API's tasks and the
 * worker each have one, so the rates leave room for a few of each.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly ratePerSecond: number,
    readonly burst: number,
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!(ratePerSecond > 0) || !(burst >= 1)) throw new Error("a bucket needs a rate and a burst");
    this.tokens = burst;
    this.last = now();
  }

  /** Waits for a token, first come first served. Resolves with how long it waited, in ms. */
  take(): Promise<number> {
    const started = this.now();
    const turn = this.queue.then(async () => {
      for (;;) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await this.sleep(Math.ceil(((1 - this.tokens) * 1000) / this.ratePerSecond));
      }
    });
    this.queue = turn;
    return turn.then(() => this.now() - started);
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) * this.ratePerSecond) / 1000);
    this.last = t;
  }
}

/** Requests a second: under Stripe's live 100 and test 25; the fake's is generous. */
export function stripeRate(settings: StripeSettings): { ratePerSecond: number; burst: number } {
  if (settings.mode === "fake") return { ratePerSecond: 200, burst: 200 };
  return settings.livemode ? { ratePerSecond: 80, burst: 80 } : { ratePerSecond: 20, burst: 20 };
}

const buckets = new Map<string, TokenBucket>();

/** One bucket per Stripe (live, test, the sandbox, the fake) in this process. */
export function stripeBucket(settings: StripeSettings): TokenBucket {
  const key = `${settings.mode}|${settings.apiBase}|${settings.livemode}|${settings.sandbox ?? false}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    const { ratePerSecond, burst } = stripeRate(settings);
    bucket = new TokenBucket(ratePerSecond, burst);
    buckets.set(key, bucket);
  }
  return bucket;
}

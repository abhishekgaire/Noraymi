import { FAKE_STRIPE_PORT } from "../settings.js";
import { FakeStripe } from "./index.js";

/**
 * `pnpm --filter @west4/api stripe:fake`: the fake Stripe on port 12111,
 * sending webhooks to the local API (STRIPE_FAKE_HOOKS overrides where).
 * Local runs and the smoke tests only; it never touches real money.
 */
const hooks = process.env["STRIPE_FAKE_HOOKS"] ?? "http://127.0.0.1:3000/v1/hooks/stripe";
const port = Number(process.env["STRIPE_FAKE_PORT"] ?? FAKE_STRIPE_PORT);
const fake = new FakeStripe({
  webhooks: {
    readers: `${hooks}/readers`,
    connect: `${hooks}/connect`,
    platform: `${hooks}/platform`,
    training: `${hooks}/training`,
  },
  webhookDelayMs: 200,
});
const base = await fake.start(port, "127.0.0.1");
console.warn(`fake Stripe on ${base}, webhooks to ${hooks}/…`);
const stop = () => void fake.stop().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

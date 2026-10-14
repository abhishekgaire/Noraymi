import { PLAN_LOOKUP_KEYS, ROOM_LOOKUP_KEY } from "../billing.js";
import { FAKE_STRIPE_KEYS } from "../settings.js";

/**
 * The plans' Prices on the fake Stripe, for the local demo's `--onboard` (Your plan, step 2).
 * Made-up test amounts, nothing like the real plans' (those live only in our real Stripe account,
 * D94): without them the plan step has nothing to show. The fake keeps its objects in memory, so a
 * fresh fake has none; a Price already there under its lookup key is left alone.
 */
export const FAKE_PLAN_AMOUNTS_CENTS: Readonly<Record<string, number>> = {
  [PLAN_LOOKUP_KEYS.bar]: 1900,
  [PLAN_LOOKUP_KEYS.rooms]: 2900,
  [PLAN_LOOKUP_KEYS.rooms_kitchen]: 3300,
  [ROOM_LOOKUP_KEY]: 300,
};

/** Makes each missing Price; returns the lookup keys it made. Throws when the fake isn't up. */
export async function ensureFakePlanPrices(apiBase: string): Promise<string[]> {
  const auth = { authorization: `Bearer ${FAKE_STRIPE_KEYS.billing}` };
  const made: string[] = [];
  for (const [lookupKey, cents] of Object.entries(FAKE_PLAN_AMOUNTS_CENTS)) {
    const have = await fetch(
      `${apiBase}/v1/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}`,
      { headers: auth },
    );
    if (!have.ok) throw new Error(`the fake Stripe answered ${have.status}`);
    if (((await have.json()) as { data: unknown[] }).data.length > 0) continue;
    const res = await fetch(`${apiBase}/v1/prices`, {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `demo-onboard-${lookupKey}-${Date.now()}`,
      },
      body: new URLSearchParams({
        currency: "usd",
        unit_amount: String(cents),
        lookup_key: lookupKey,
      }).toString(),
    });
    if (!res.ok) throw new Error(`the fake Stripe refused ${lookupKey}: ${await res.text()}`);
    made.push(lookupKey);
  }
  return made;
}

import type { Queryable } from "./tenancy.js";

/**
 * Stripe accounts and their status (M4-01; Stripe setup 1, 2 and 7). Inside a
 * venue transaction: the venue's account id comes only from its
 * organization's row, which row-level security shows only for the current
 * venue, so a request as venue B can never read West 4's id.
 */
export async function stripeAccountOf(c: Queryable, venueId: string): Promise<string | null> {
  const r = await c.query<{ stripe_account_id: string | null }>(
    `select o.stripe_account_id from venues v join organizations o on o.id = v.org_id where v.id = $1`,
    [venueId],
  );
  return r.rows[0]?.stripe_account_id ?? null;
}

/** The venues of a Stripe account (`event.account`), through the definer function. */
export async function venuesOfStripeAccount(c: Queryable, account: string): Promise<string[]> {
  const r = await c.query<{ id: string }>("select resolve_stripe_account($1) as id", [account]);
  return r.rows.map((x) => x.id);
}

export interface StripeIntegration {
  readonly status: string;
  readonly account_id: string | null;
  readonly card_payments: string;
  readonly needs: string[];
  readonly checked_at: string | null;
}

export async function stripeIntegration(
  c: Queryable,
  venueId: string,
): Promise<StripeIntegration | null> {
  const r = await c.query<{
    status: string;
    external_id: string | null;
    config: { card_payments?: string; needs?: string[]; checked_at?: string };
  }>(
    "select status, external_id, config from integrations where venue_id = $1 and kind = 'stripe'",
    [venueId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    status: row.status,
    account_id: row.external_id,
    card_payments: row.config.card_payments ?? "pending",
    needs: row.config.needs ?? [],
    checked_at: row.config.checked_at ?? null,
  };
}

/** What Stripe last said about the account: connected once card payments are active. */
export async function saveStripeIntegration(
  c: Queryable,
  venueId: string,
  input: { accountId: string; cardPayments: string; needs: readonly string[]; at: string },
): Promise<void> {
  const connected = input.cardPayments === "active";
  await c.query(
    `insert into integrations (venue_id, kind, status, external_id, config, connected_at)
       values ($1, 'stripe', $2, $3, $4, case when $2 = 'connected' then $5::timestamptz end)
       on conflict (venue_id, kind) do update set status = excluded.status, external_id = excluded.external_id,
         config = excluded.config,
         connected_at = coalesce(integrations.connected_at, excluded.connected_at)`,
    [
      venueId,
      connected ? "connected" : "pending",
      input.accountId,
      JSON.stringify({
        card_payments: input.cardPayments,
        needs: input.needs,
        checked_at: input.at,
      }),
      input.at,
    ],
  );
}

/** Admin → Connections: each integration's kind and status. */
export async function integrationStatuses(
  c: Queryable,
  venueId: string,
): Promise<{ kind: string; status: string; connected_at: string | null }[]> {
  const r = await c.query<{ kind: string; status: string; connected_at: string | null }>(
    `select kind, status, to_json(connected_at) #>> '{}' as connected_at from integrations
      where venue_id = $1 order by kind`,
    [venueId],
  );
  return r.rows;
}

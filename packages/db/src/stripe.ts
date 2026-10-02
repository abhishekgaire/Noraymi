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

/** Stores a Stripe event once (M4-03), before its venue is set: through the definer function. */
export async function ingestStripeEvent(
  c: Queryable,
  input: {
    eventId: string;
    type: string;
    endpoint: string;
    account: string | null;
    payload: unknown;
  },
): Promise<{ id: string; venue_id: string | null; first: boolean; processed: boolean }> {
  const r = await c.query<{
    id: string;
    venue_id: string | null;
    first: boolean;
    processed: boolean;
  }>("select * from ingest_stripe_event($1, $2, $3, $4, $5)", [
    input.eventId,
    input.type,
    input.endpoint,
    input.account,
    JSON.stringify(input.payload),
  ]);
  return r.rows[0]!;
}

export interface StripeEventRow {
  readonly id: string;
  readonly event_id: string;
  readonly type: string;
  readonly endpoint: string | null;
  readonly account: string | null;
  readonly payload: Record<string, unknown>;
  readonly processed_at: string | null;
}

/** A stored event of this venue, locked while its job applies it. */
export async function stripeEventRow(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<StripeEventRow | null> {
  const r = await c.query<StripeEventRow>(
    `select id, event_id, type, endpoint, account, payload, to_json(processed_at) #>> '{}' as processed_at
       from webhook_events where venue_id = $1 and id = $2 and provider = 'stripe' for update`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

export async function markStripeEventProcessed(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<void> {
  await c.query("update webhook_events set processed_at = now() where venue_id = $1 and id = $2", [
    venueId,
    id,
  ]);
}

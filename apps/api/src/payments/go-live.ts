import { stripeAccountOf, withVenue, type Queryable } from "@west4/db";
import type pg from "pg";
import { ApiError } from "../http/errors.js";
import { retrieveAccount } from "../stripe/accounts.js";
import type { StripeClient } from "../stripe/client.js";

/**
 * The go-live checklist (M4-29; milestones · M4; Stripe setup steps 3 and 11):
 * the merchant category on West 4's Stripe account matches the one we expect
 * (read from the account), and each owner and manager has a Stripe Dashboard
 * login that can take payments and a phone that runs Tap to Pay, both
 * confirmed by the owner with who and when (Stripe can't list Dashboard users).
 * Bar tabs & quick sale stay off until the merchant category passes, and the
 * Console reads the same rows.
 */
export type PersonCheck = "dashboard_login" | "tap_to_pay";

export async function goLive(c: Queryable, venueId: string) {
  const rows = await c.query<{
    key: string;
    status: string;
    expected: string | null;
    found: string | null;
    confirmed_by: string | null;
    confirmed_at: string | null;
    confirmed_by_name: string | null;
  }>(
    `select s.key, s.status, s.expected, s.found, s.confirmed_by, to_json(s.confirmed_at) #>> '{}' as confirmed_at,
            u.name as confirmed_by_name
       from setup_checks s left join users u on u.id = s.confirmed_by where s.venue_id = $1`,
    [venueId],
  );
  const byKey = new Map(rows.rows.map((r) => [r.key, r]));
  const people = await c.query<{ user_id: string; name: string; role: string }>(
    `select m.user_id, u.name, m.role from memberships m join users u on u.id = m.user_id
      where m.venue_id = $1 and m.role in ('owner', 'manager') and m.status = 'active' order by m.role desc, u.name`,
    [venueId],
  );
  const merchant = byKey.get("merchant_category");
  const person = (userId: string, check: PersonCheck) => {
    const r = byKey.get(`${check}:${userId}`);
    return {
      confirmed: r?.status === "passed",
      by: r?.status === "passed" ? r.confirmed_by_name : null,
      at: r?.status === "passed" ? r.confirmed_at : null,
    };
  };
  const list = people.rows.map((p) => ({
    user_id: p.user_id,
    name: p.name,
    role: p.role,
    dashboard_login: person(p.user_id, "dashboard_login"),
    tap_to_pay: person(p.user_id, "tap_to_pay"),
  }));
  const merchantPasses = merchant?.status === "passed";
  return {
    merchant_category: {
      expected: merchant?.expected ?? null,
      found: merchant?.found ?? null,
      status: merchant?.status ?? "pending",
    },
    people: list,
    passes:
      merchantPasses && list.every((p) => p.dashboard_login.confirmed && p.tap_to_pay.confirmed),
  };
}

/** Reads the account's merchant category from Stripe (outside any transaction) and records the check. */
export async function refreshMerchantCategory(
  deps: { pool: pg.Pool; stripe: StripeClient },
  venueId: string,
): Promise<void> {
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: "go-live" }, work);
  const account = await inVenue((c) => stripeAccountOf(c, venueId));
  if (!account) return;
  const found = (await retrieveAccount(deps.stripe, account)).configuration?.merchant?.mcc ?? null;
  await inVenue(async (c) => {
    await c.query(
      `insert into setup_checks (venue_id, key, found) values ($1, 'merchant_category', $2)
       on conflict (venue_id, key) do update set found = excluded.found`,
      [venueId, found],
    );
    await settleMerchant(c, venueId);
  });
}

async function settleMerchant(c: Queryable, venueId: string) {
  await c.query(
    `update setup_checks set status = case
        when expected is null or found is null then 'pending'
        when expected = found then 'passed' else 'failed' end
      where venue_id = $1 and key = 'merchant_category'`,
    [venueId],
  );
}

/** The category we expect for this venue, as the owner enters it (never a made-up default). */
export async function setExpectedCategory(c: Queryable, venueId: string, mcc: string | null) {
  await c.query(
    `insert into setup_checks (venue_id, key, expected) values ($1, 'merchant_category', $2)
     on conflict (venue_id, key) do update set expected = excluded.expected`,
    [venueId, mcc],
  );
  await settleMerchant(c, venueId);
}

/** The owner confirms (or takes back) a person's Dashboard login or Tap to Pay phone. */
export async function confirmPerson(
  c: Queryable,
  venueId: string,
  input: { userId: string; check: PersonCheck; confirmed: boolean; by: string; at: string },
) {
  const member = await c.query(
    "select 1 from memberships where venue_id = $1 and user_id = $2 and role in ('owner', 'manager') and status = 'active'",
    [venueId, input.userId],
  );
  if (!member.rows[0]) throw new ApiError("not_found", "no such owner or manager here");
  await c.query(
    `insert into setup_checks (venue_id, key, status, confirmed_by, confirmed_at) values ($1, $2, $3, $4, $5)
     on conflict (venue_id, key) do update set status = excluded.status, confirmed_by = excluded.confirmed_by,
       confirmed_at = excluded.confirmed_at`,
    [
      venueId,
      `${input.check}:${input.userId}`,
      input.confirmed ? "passed" : "pending",
      input.confirmed ? input.by : null,
      input.confirmed ? input.at : null,
    ],
  );
}

/** The module guard (M4-29): Bar tabs & quick sale stay off until the merchant category passes. */
export async function merchantCategoryPasses(c: Queryable, venueId: string): Promise<boolean> {
  const r = await c.query<{ status: string }>(
    "select status from setup_checks where venue_id = $1 and key = 'merchant_category'",
    [venueId],
  );
  return r.rows[0]?.status === "passed";
}

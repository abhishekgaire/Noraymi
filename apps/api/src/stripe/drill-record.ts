import pg from "pg";
import { loadConfig } from "../config.js";

/**
 * The live drill's record (M4-30; docs/runbooks/live-payment-drill.md):
 * `pnpm --filter @west4/api drill:record -- --date 2026-10-09 [--venue west4karaoke]`
 * prints, as Markdown, every card payment taken on the readers that night with
 * who rang it, when, the amount, the reader, Stripe's PaymentIntent id, how it
 * settled, and each refund with its Stripe refund id. Paste it into
 * docs/drills/<date>.md with who ran the drill. Read-only.
 */
async function main(): Promise<void> {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const date = arg("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("usage: drill:record -- --date YYYY-MM-DD [--venue slug]");
  const slug = arg("venue") ?? "west4karaoke";
  const pool = new pg.Pool({
    connectionString: process.env["DATABASE_URL"] ?? loadConfig().databaseUrl,
  });
  try {
    const rows = await pool.query<{
      id: string;
      at: string;
      amount_cents: string;
      status: string;
      stripe_pi_id: string | null;
      reader: string | null;
      attempts: number;
      refunds: string | null;
    }>(
      `select p.id, to_char(p.created_at at time zone v.time_zone, 'YYYY-MM-DD HH24:MI:SS') as at,
              p.amount_cents, p.status, p.stripe_pi_id,
              (select d.name from payment_attempts a join devices d on d.venue_id = a.venue_id and d.stripe_reader_id = a.reader_id
                where a.venue_id = p.venue_id and a.payment_id = p.id order by a.attempt_no desc limit 1) as reader,
              (select count(*)::int from payment_attempts a where a.venue_id = p.venue_id and a.payment_id = p.id) as attempts,
              (select string_agg(r.amount_cents || ' ' || r.status || coalesce(' ' || r.stripe_refund_id, ''), '; ' order by r.n)
                 from refunds r where r.venue_id = p.venue_id and r.payment_id = p.id) as refunds
         from payments p join venues v on v.id = p.venue_id
        where v.slug = $1 and p.business_date = $2 and p.method = 'card_present'
        order by p.created_at`,
      [slug, date],
    );
    const money = (c: number) =>
      `$${Math.floor(c / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;
    const out = [
      `# Live payment drill · ${slug} · night of ${date}`,
      "",
      "Ran by: _(name)_ · Witnessed by: _(name)_ · Drill flag set at _(time)_ and cleared at _(time)_",
      "",
      "| When | Reader | Amount | Status | Attempts | PaymentIntent | Refunds (cents, status, Stripe id) |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...rows.rows.map(
        (r) =>
          `| ${r.at} | ${r.reader ?? "?"} | ${money(Number(r.amount_cents))} | ${r.status} | ${r.attempts} | ${r.stripe_pi_id ?? "none"} | ${r.refunds ?? "none"} |`,
      ),
      "",
      `${rows.rows.length} card payments. Check each PaymentIntent in Stripe's live Dashboard: one charge each, refunded.`,
    ];
    process.stdout.write(`${out.join("\n")}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

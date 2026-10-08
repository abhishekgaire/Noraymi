import type pg from "pg";
import type { Queryable } from "@west4/db";
import { Temporal } from "@west4/shared";
import type { Mailer } from "../email/mailer.js";
import type { TextSender } from "../texts/sender.js";
import { ALERT_RULES, ESCALATE_AFTER_MINUTES, alertRule, type AlertRuleId } from "./alert-rules.js";

/**
 * Pages and the on-call rota (M8-17; spec 13 · On call). A page goes to the first responder at
 * once and, if nobody has acknowledged it within 10 minutes, to the second. Vendor-neutral: the
 * page is sent as an email to the responder's Console address and, when the rota has a phone for
 * them, as a text, through the same mailer and text sender the rest of the platform uses. Each send
 * is claimed in the database first, then made outside any transaction with its claim's key as the
 * idempotency key, so a retry is the same message.
 */
export type Slot = "first" | "second";
export const SLOTS: readonly Slot[] = ["first", "second"];

export interface RaisePage {
  readonly rule: AlertRuleId;
  readonly key: string;
  readonly summary: string;
  readonly severity?: "page" | "ticket";
  readonly test?: boolean;
}

export interface PageRow {
  id: string;
  rule: string;
  key: string;
  severity: "page" | "ticket";
  summary: string;
  runbook: string;
  opened_at: string;
  acked_at: string | null;
  acked_by: string | null;
  cleared_at: string | null;
  test: boolean;
}

const PAGE_COLUMNS = `id, rule, key, severity, summary, runbook,
  to_json(opened_at) #>> '{}' as opened_at, to_json(acked_at) #>> '{}' as acked_at, acked_by,
  to_json(cleared_at) #>> '{}' as cleared_at, test`;

/**
 * Opens a page, unless one is already live for its key (or, for a rule that clears on
 * acknowledgement, unless that key ever paged). Returns the page and whether this call opened it.
 */
export async function raisePage(
  q: Queryable,
  p: RaisePage,
  now: Temporal.Instant,
): Promise<{ page: PageRow; opened: boolean } | null> {
  const r = alertRule(p.rule);
  if (!r || r.audience !== "us") throw new Error(`${p.rule} doesn't page us`);
  if (r.clears === "ack") {
    const ever = await q.query<PageRow>(
      `select ${PAGE_COLUMNS} from pages where key = $1 limit 1`,
      [p.key],
    );
    if (ever.rows[0]) return { page: ever.rows[0], opened: false };
  }
  const made = await q.query<PageRow>(
    `insert into pages (rule, key, severity, summary, runbook, opened_at, test)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (key) where cleared_at is null do nothing
     returning ${PAGE_COLUMNS}`,
    [
      p.rule,
      p.key,
      p.severity ?? "page",
      p.summary.slice(0, 300),
      r.runbook,
      now.toString(),
      p.test ?? false,
    ],
  );
  if (made.rows[0]) return { page: made.rows[0], opened: true };
  const live = await q.query<PageRow>(
    `select ${PAGE_COLUMNS} from pages where key = $1 and cleared_at is null`,
    [p.key],
  );
  return live.rows[0] ? { page: live.rows[0], opened: false } : null;
}

/**
 * Clears the live pages of a condition rule whose key the check no longer finds. `scope` limits it
 * to keys with that prefix, so a sweep that only looked at some keys clears only those.
 */
export async function clearPages(
  q: Queryable,
  rule: AlertRuleId,
  stillFiring: readonly string[],
  now: Temporal.Instant,
  scope = "",
): Promise<number> {
  const r = alertRule(rule);
  if (!r || r.clears !== "condition") return 0;
  const done = await q.query(
    `update pages set cleared_at = $4
      where rule = $1 and cleared_at is null and not test
        and starts_with(key, $3) and not (key = any($2::text[]))`,
    [rule, stillFiring, scope, now.toString()],
  );
  return done.rowCount ?? 0;
}

/** Clears the one live page with this key (a CloudWatch alarm back to OK). */
export async function clearKey(q: Queryable, key: string, now: Temporal.Instant): Promise<number> {
  const done = await q.query(
    "update pages set cleared_at = $2 where key = $1 and cleared_at is null and not test",
    [key, now.toString()],
  );
  return done.rowCount ?? 0;
}

/** Acknowledges a page: escalation stops; a page about one event is over. Null if already acked. */
export async function ackPage(
  q: Queryable,
  pageId: string,
  staffId: string,
  now: Temporal.Instant,
): Promise<PageRow | null> {
  const done = await q.query<PageRow>(
    `update pages set acked_at = $3, acked_by = $2,
            cleared_at = case when rule = any($4::text[]) then coalesce(cleared_at, $3) else cleared_at end
      where id = $1 and acked_at is null
      returning ${PAGE_COLUMNS}`,
    [pageId, staffId, now.toString(), clearsOnAck()],
  );
  return done.rows[0] ?? null;
}

const clearsOnAck = () => ALERT_RULES.filter((r) => r.clears === "ack").map((r) => r.id);

export interface RotaEntry {
  slot: Slot;
  staff_id: string;
  name: string;
  email: string;
  phone: string | null;
}

export async function readRota(q: Queryable): Promise<RotaEntry[]> {
  const rows = await q.query<RotaEntry>(
    `select r.slot, r.console_staff_id as staff_id, s.name, s.email, r.phone
       from oncall_rota r join console_staff s on s.id = r.console_staff_id
      where s.active order by r.slot`,
  );
  return rows.rows;
}

/** Puts one of our Console staff in a slot (by their email), with an optional phone for texts. */
export async function setRota(
  q: Queryable,
  slot: Slot,
  staffEmail: string,
  phone: string | null,
  by: string,
): Promise<RotaEntry> {
  const staff = await q.query<{ id: string }>(
    "select id from console_staff where lower(email) = lower($1) and active",
    [staffEmail],
  );
  const id = staff.rows[0]?.id;
  if (!id) throw new Error(`no active Console staff with the email ${staffEmail}`);
  await q.query(
    `insert into oncall_rota (slot, console_staff_id, phone, updated_by) values ($1, $2, $3, $4)
     on conflict (slot) do update set console_staff_id = excluded.console_staff_id,
       phone = excluded.phone, updated_by = excluded.updated_by, updated_at = now()`,
    [slot, id, phone, by],
  );
  return (await readRota(q)).find((r) => r.slot === slot)!;
}

/** What the Console and the CLI say when a slot is empty. */
export const ROTA_HINT =
  "Nobody is on call yet. Set both slots with pnpm --filter @west4/api oncall:set -- --slot first --email <Console staff email> [--phone <+1…>], then --slot second.";

export interface PagerDeps {
  readonly mailer: Mailer;
  readonly texts: TextSender;
  /** The From address of the page's email. */
  readonly from: string;
  /** Where the Console is, for the link to acknowledge; null leaves the link out. */
  readonly consoleUrl: string | null;
}

/** The slots a page is due at by `now`: the first at once; the second after 10 minutes unacknowledged, or at once when the first slot is empty. */
export function dueSlots(
  openedAt: Temporal.Instant,
  now: Temporal.Instant,
  rota: readonly Pick<RotaEntry, "slot">[],
): Slot[] {
  const has = (s: Slot) => rota.some((r) => r.slot === s);
  const late =
    now.epochMilliseconds - openedAt.epochMilliseconds >= ESCALATE_AFTER_MINUTES * 60_000;
  const out: Slot[] = [];
  if (has("first")) out.push("first");
  if (has("second") && (late || !has("first"))) out.push("second");
  return out;
}

export interface NotifyResult {
  readonly sent: { pageId: string; slot: Slot; channel: "email" | "text" }[];
  readonly failed: number;
  readonly rotaEmpty: boolean;
}

/**
 * Sends every open, unacknowledged page to the slots it is due at. Never inside a transaction:
 * the claim and the mark are their own statements, the send sits between them.
 */
export async function notifyPages(
  pool: pg.Pool,
  deps: PagerDeps,
  now: Temporal.Instant,
  log?: (line: string) => void,
): Promise<NotifyResult> {
  const open = await pool.query<PageRow>(
    `select ${PAGE_COLUMNS} from pages where severity = 'page' and acked_at is null order by opened_at`,
  );
  const rota = await readRota(pool);
  const sent: NotifyResult["sent"] = [];
  let failed = 0;
  if (open.rows.length > 0 && rota.length < 2) log?.(`paging: ${ROTA_HINT}`);
  for (const page of open.rows) {
    for (const slot of dueSlots(Temporal.Instant.from(page.opened_at), now, rota)) {
      const who = rota.find((r) => r.slot === slot)!;
      const channels: ("email" | "text")[] = who.phone ? ["email", "text"] : ["email"];
      for (const channel of channels) {
        const key = `page:${page.id}:${slot}:${channel}`;
        await pool.query(
          `insert into page_notifications (page_id, slot, channel, idempotency_key, claimed_at)
           values ($1, $2, $3, $4, $5) on conflict do nothing`,
          [page.id, slot, channel, key, now.toString()],
        );
        const pending = await pool.query(
          "select 1 from page_notifications where idempotency_key = $1 and sent_at is null",
          [key],
        );
        if (pending.rowCount === 0) continue;
        try {
          await send(deps, page, slot, channel, who, key);
          await pool.query(
            "update page_notifications set sent_at = $2, last_error = null where idempotency_key = $1",
            [key, now.toString()],
          );
          sent.push({ pageId: page.id, slot, channel });
        } catch (e) {
          failed += 1;
          await pool.query(
            "update page_notifications set last_error = $2 where idempotency_key = $1",
            [key, (e as Error).message.slice(0, 500)],
          );
          log?.(`paging: ${channel} to the ${slot} responder failed for page ${page.id}`);
        }
      }
    }
  }
  return { sent, failed, rotaEmpty: rota.length === 0 };
}

async function send(
  deps: PagerDeps,
  page: PageRow,
  slot: Slot,
  channel: "email" | "text",
  who: RotaEntry,
  key: string,
): Promise<void> {
  const escalated = slot === "second" ? "Not acknowledged in 10 minutes · " : "";
  const ack = deps.consoleUrl ? `${deps.consoleUrl.replace(/\/$/, "")}/#pages` : "the Console";
  const subject = `${page.test ? "[TEST] " : ""}${escalated}${page.summary}`;
  const body = `${subject}\nRunbook: ${page.runbook}\nAcknowledge in ${ack}`;
  if (channel === "text") {
    await deps.texts.send({ to: who.phone!, body, idempotencyKey: key });
    return;
  }
  await deps.mailer.send({
    to: who.email,
    from: deps.from,
    subject: `Page: ${subject}`,
    text: body,
    html: `<p>${escapeHtml(subject)}</p><p>Runbook: ${escapeHtml(page.runbook)}</p><p>Acknowledge in ${escapeHtml(ack)}</p>`,
    messageId: `<${key.replace(/:/g, ".")}@pages.west4>`,
  });
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function listPages(q: Queryable, limit = 50): Promise<PageRow[]> {
  const rows = await q.query<PageRow>(
    `select ${PAGE_COLUMNS} from pages
      order by (acked_at is null) desc, opened_at desc limit $1`,
    [limit],
  );
  return rows.rows;
}

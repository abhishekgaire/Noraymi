import type { Queryable } from "@west4/db";
import type { Locale, Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { orderItemsFor, type StaffLine } from "../orders/place.js";
import { billParts } from "./bill.js";
import type { ReceiptLine } from "./model.js";

/**
 * Guest screen (P-18; module guest_screen, off by default): the check being rung up at one
 * register, shown to the guest on the bar computer's second monitor (a desktop-app window) or a
 * paired guest display; idle, the venue's name.
 *
 * The register says what it shows (`guest_screens`, one row per register, replaced whole on every
 * change, its version bumped), and the screen reads it here. A screen only ever reads its own
 * register's row, and each answer carries one check worked out from scratch, so it never shows
 * another check or mixes two. The amounts are the printed bill's (P-01): the receipt model, an open
 * check worked out now by packages/rules, with the cash price when the cash discount is on. The
 * person's unsent drinks on that check (or the quick sale) show under "Being rung up", priced from
 * the menu as a round would be.
 */

/** The computers the bar POS runs on, the only ones a guest screen follows. */
const REGISTER_KINDS = ["bar_computer", "front_desk"] as const;

/** A register that hasn't said anything for this long (closed, crashed) shows the venue's name. */
export const GUEST_SCREEN_STALE_MS = 3 * 60_000;

export interface GuestScreenCheck {
  readonly id: string;
  readonly number: string;
  /** The room, or the tab's name. */
  readonly where: string | null;
  readonly training: boolean;
  readonly lines: readonly ReceiptLine[];
  readonly totals: readonly ReceiptLine[];
  readonly payments: readonly ReceiptLine[];
  readonly total_cents: number;
  readonly due_cents: number;
  /** With the cash discount on (U-02): the cash price of the total and of what's left; else null. */
  readonly cash_total_cents: number | null;
  readonly cash_due_cents: number | null;
}

export interface GuestScreenUnsent {
  readonly name: string;
  readonly qty: number;
  readonly options: readonly string[];
  readonly amount_cents: number;
}

export type GuestScreenAnswer =
  | { readonly fp: string; readonly unchanged: true }
  | {
      readonly fp: string;
      readonly unchanged: false;
      readonly venue: string;
      readonly register: { readonly id: string; readonly name: string } | null;
      /** A paired screen with several computers to follow and none chosen in Admin. */
      readonly needs_register: boolean;
      readonly check: GuestScreenCheck | null;
      readonly unsent: readonly GuestScreenUnsent[];
      readonly unsent_cents: number;
    };

/**
 * What the register now shows: a check (null: nothing, the venue's name) and whether the person's
 * unsent drinks on it show too. Null when the device isn't a live bar or front-desk computer (a
 * phone, a browser that isn't paired): it drives no screen.
 */
export async function showOnGuestScreen(
  c: Queryable,
  venueId: string,
  input: {
    readonly deviceId: string;
    readonly checkId: string | null;
    readonly membershipId: string | null;
    readonly draft: boolean;
    readonly at: string;
  },
): Promise<{ version: number } | null> {
  const device = await c.query(
    `select 1 from devices where venue_id = $1 and id = $2 and revoked_at is null
        and kind = any($3::text[])`,
    [venueId, input.deviceId, REGISTER_KINDS],
  );
  if (device.rowCount === 0) return null;
  if (input.checkId) {
    const check = await c.query("select 1 from checks where venue_id = $1 and id = $2", [
      venueId,
      input.checkId,
    ]);
    if (check.rowCount === 0) throw new ApiError("not_found", "no such check");
  }
  const draft = input.draft && input.membershipId !== null;
  const r = await c.query<{ version: string }>(
    `insert into guest_screens (venue_id, device_id, check_id, membership_id, draft, updated_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (venue_id, device_id) do update
       set check_id = excluded.check_id, membership_id = excluded.membership_id,
           draft = excluded.draft, updated_at = excluded.updated_at,
           version = guest_screens.version + 1
     returning version::text`,
    [venueId, input.deviceId, input.checkId, draft ? input.membershipId : null, draft, input.at],
  );
  return { version: Number(r.rows[0]!.version) };
}

/**
 * The register a screen follows. A bar computer's own window follows itself; a paired guest
 * display follows the computer Admin chose for it, else the venue's only bar computer.
 */
export async function registerFor(
  c: Queryable,
  venueId: string,
  who: { readonly display: string } | { readonly register: string },
): Promise<{ register: { id: string; name: string } | null; needsRegister: boolean }> {
  const live = await c.query<{ id: string; name: string; kind: string }>(
    `select id, name, kind from devices
      where venue_id = $1 and revoked_at is null and not sandbox and kind = any($2::text[])
      order by name, id`,
    [venueId, REGISTER_KINDS],
  );
  if ("register" in who) {
    const own = live.rows.find((d) => d.id === who.register);
    return { register: own ? { id: own.id, name: own.name } : null, needsRegister: false };
  }
  const follows = (
    await c.query<{ follows_device_id: string | null }>(
      "select follows_device_id from devices where venue_id = $1 and id = $2",
      [venueId, who.display],
    )
  ).rows[0]?.follows_device_id;
  const chosen = follows ? live.rows.find((d) => d.id === follows) : undefined;
  if (chosen) return { register: { id: chosen.id, name: chosen.name }, needsRegister: false };
  const bars = live.rows.filter((d) => d.kind === "bar_computer");
  if (bars.length === 1)
    return { register: { id: bars[0]!.id, name: bars[0]!.name }, needsRegister: false };
  return { register: null, needsRegister: live.rows.length > 0 };
}

/**
 * The screen's answer for one register. `since` is the fingerprint of the screen's last answer:
 * while nothing the register said (nor the person's unsent drinks) changed, the answer is just
 * `unchanged`, so the screen can ask twice a second for little.
 */
export async function guestScreenView(
  c: Queryable,
  venueId: string,
  target: { register: { id: string; name: string } | null; needsRegister: boolean },
  input: { readonly now: Temporal.Instant; readonly locale: Locale; readonly since?: string },
): Promise<GuestScreenAnswer> {
  const row = target.register
    ? (
        await c.query<{
          check_id: string | null;
          membership_id: string | null;
          draft: boolean;
          version: string;
          updated_ms: string;
          draft_version: number | null;
          draft_lines: unknown[] | null;
        }>(
          `select g.check_id, g.membership_id, g.draft, g.version::text,
                  (extract(epoch from g.updated_at) * 1000)::bigint::text as updated_ms,
                  d.version as draft_version, d.lines as draft_lines
             from guest_screens g
             left join order_drafts d on g.draft and d.venue_id = g.venue_id
                  and d.membership_id = g.membership_id and d.check_id is not distinct from g.check_id
            where g.venue_id = $1 and g.device_id = $2`,
          [venueId, target.register.id],
        )
      ).rows[0]
    : undefined;
  const stale =
    !row || input.now.epochMilliseconds - Number(row.updated_ms) > GUEST_SCREEN_STALE_MS;
  const live = stale ? undefined : row;
  const fp = [
    input.locale,
    target.register?.id ?? (target.needsRegister ? "choose" : "none"),
    live ? `${live.version}.${live.draft_version ?? 0}` : "idle",
  ].join(":");
  if (input.since === fp) return { fp, unchanged: true };

  const venue = (
    await c.query<{ name: string }>("select name from venues where id = $1", [venueId])
  ).rows[0]!.name;
  let check: GuestScreenCheck | null = null;
  if (live?.check_id) {
    const b = await billParts(c, venueId, live.check_id, input);
    check = {
      id: live.check_id,
      number: b.m.number,
      where: b.m.room ?? b.tab,
      training: b.m.training,
      lines: b.m.lines,
      totals: b.m.totals,
      payments: b.m.payments,
      total_cents: b.m.total_cents,
      due_cents: b.m.amount_due_cents,
      cash_total_cents: b.cashTotalCents,
      cash_due_cents: b.cashDueCents,
    };
  }
  const unsent: GuestScreenUnsent[] = [];
  for (const line of (live?.draft_lines ?? []) as StaffLine[]) {
    // A drink that can't be rung any more (86'd, off the menu) can't be sent either: it's left off.
    const items = await orderItemsFor(c, venueId, [line], input.now).catch(() => null);
    if (!items || items.length === 0) continue;
    const each = items.reduce(
      (sum, i) => sum + i.unitCents + i.options.reduce((s, o) => s + o.price_delta_cents, 0),
      0,
    );
    unsent.push({
      name: items[0]!.name,
      qty: line.qty,
      options: [
        ...items[0]!.options.map((o) => o.name),
        ...items.slice(1).flatMap((i) => (i.component ? [i.component.name] : [i.name])),
      ],
      amount_cents: each * line.qty,
    });
  }
  return {
    fp,
    unchanged: false,
    venue,
    register: target.register,
    needs_register: target.needsRegister,
    check,
    unsent,
    unsent_cents: unsent.reduce((s, u) => s + u.amount_cents, 0),
  };
}

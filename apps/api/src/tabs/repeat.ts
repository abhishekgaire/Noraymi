import { draftFor, emitEvent, menuTree, saveDraft, type Queryable } from "@west4/db";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { alcoholNow } from "../orders/alcohol.js";

/**
 * Repeat round (M6-03; Staff screens and the bar POS · rule 5; API ·
 * `POST /tabs/{t}/repeat-round`): the tab's last round, copied into the
 * caller's unsent drinks for the tab, with its options. Anything 86'd tonight,
 * any alcohol outside the window or on a cut-off tab is left out and named.
 * Nothing is sent: the bartender still taps Send.
 */
export type LeftOutReason = "out" | "window_closed" | "cut_off";

interface DraftLine {
  variant_id: string;
  qty: number;
  option_ids: string[];
}

const same = (a: DraftLine, b: DraftLine) =>
  a.variant_id === b.variant_id &&
  a.option_ids.length === b.option_ids.length &&
  a.option_ids.every((o) => b.option_ids.includes(o));

export async function repeatRound(
  c: Queryable,
  venueId: string,
  tabId: string,
  who: { membershipId: string; userId: string; deviceId: string | null },
  now: Temporal.Instant,
) {
  const tab = (
    await c.query<{ check_id: string; cut_off_at: string | null; state: string }>(
      "select check_id, to_json(cut_off_at) #>> '{}' as cut_off_at, state from tabs where venue_id = $1 and id = $2",
      [venueId, tabId],
    )
  ).rows[0];
  if (!tab) throw new ApiError("not_found", "no such tab");
  if (tab.state !== "open") throw new ApiError("invalid_request", "this tab isn't open");
  type Rung = {
    item_id: string | null;
    variant_id: string | null;
    qty: number;
    name_snapshot: string;
    alcohol: boolean;
    options: { group: string; name: string }[] | null;
  };
  const last = (
    await c.query<{ id: string }>(
      `select id from orders where venue_id = $1 and check_id = $2 and status <> 'cancelled'
        order by placed_at desc, id desc limit 1`,
      [venueId, tab.check_id],
    )
  ).rows[0];
  let items: Rung[];
  if (last)
    items = (
      await c.query<Rung>(
        `select item_id, variant_id, qty, name_snapshot, alcohol, options from order_items
          where venue_id = $1 and order_id = $2 order by sort, id`,
        [venueId, last.id],
      )
    ).rows;
  else {
    // Drinks put on the tab without an order (the seed's tabs, M6-27): the last round is the
    // drinks rung at the latest time, matched to the menu by name, with their usual options.
    const rows = (
      await c.query<{ description: string; qty: string }>(
        `select l.description, l.qty from check_lines l
          where l.venue_id = $1 and l.check_id = $2 and l.kind = 'item'
            and l.added_at = (select max(added_at) from check_lines
                               where venue_id = $1 and check_id = $2 and kind = 'item')
            and not exists (select 1 from check_lines r where r.venue_id = l.venue_id and r.reverses_id = l.id)
          order by l.id`,
        [venueId, tab.check_id],
      )
    ).rows;
    items = rows.map((r) => ({
      item_id: null,
      variant_id: null,
      qty: Math.max(1, Math.round(Number(r.qty))),
      name_snapshot: r.description,
      alcohol: false,
      options: null,
    }));
  }
  if (items.length === 0)
    throw new ApiError("invalid_request", "there's no round on this tab yet", {
      details: { reason: "no_round" },
    });
  const menu = (await menuTree(c, venueId, new Date(now.epochMilliseconds).toISOString())).flatMap(
    (cat) => cat.items,
  );
  const windowClosed = (await alcoholNow(c, venueId, now)).state === "closed";
  const cutOff = tab.cut_off_at !== null;

  const added: DraftLine[] = [];
  const leftOut: { name: string; reason: LeftOutReason }[] = [];
  for (const it of items) {
    const item =
      menu.find((m) => m.id === it.item_id) ??
      (it.item_id === null
        ? menu.find(
            (m) =>
              m.name === it.name_snapshot ||
              m.variants.some((v) => `${m.name} · ${v.name}` === it.name_snapshot),
          )
        : undefined);
    const variant =
      item?.variants.find((v) => v.id === it.variant_id) ??
      (it.variant_id === null
        ? (item?.variants.find((v) => `${item.name} · ${v.name}` === it.name_snapshot) ??
          (item?.variants.length === 1 ? item.variants[0] : undefined))
        : undefined);
    const alcohol = it.alcohol || (item?.alcohol ?? false);
    if (alcohol && (windowClosed || cutOff)) {
      leftOut.push({ name: it.name_snapshot, reason: windowClosed ? "window_closed" : "cut_off" });
      continue;
    }
    // An option is matched by its group and name, as the order kept them.
    const options =
      it.options === null
        ? (item?.groups.flatMap((g) => g.options.filter((o) => o.is_default)) ?? [])
        : it.options.map((o) =>
            item?.groups.find((g) => g.name === o.group)?.options.find((x) => x.name === o.name),
          );
    if (
      !item ||
      !variant ||
      !item.shown ||
      item.out_tonight ||
      variant.out_tonight ||
      options.some((o) => !o || o.out_tonight)
    ) {
      leftOut.push({ name: it.name_snapshot, reason: "out" });
      continue;
    }
    const line: DraftLine = {
      variant_id: variant.id,
      qty: it.qty,
      option_ids: options.map((o) => o!.id),
    };
    const i = added.findIndex((l) => same(l, line));
    if (i >= 0) added[i] = { ...added[i]!, qty: Math.min(99, added[i]!.qty + line.qty) };
    else added.push(line);
  }

  // Into the caller's unsent drinks for the tab, next to anything already rung.
  const draft = await draftFor(c, venueId, who.membershipId, tab.check_id);
  const lines = ((draft?.lines ?? []) as DraftLine[]).map((l) => ({
    ...l,
    option_ids: l.option_ids ?? [],
  }));
  for (const line of added) {
    const i = lines.findIndex((l) => same(l, line));
    if (i >= 0) lines[i] = { ...lines[i]!, qty: Math.min(99, lines[i]!.qty + line.qty) };
    else lines.push(line);
  }
  const version = await saveDraft(c, venueId, {
    membershipId: who.membershipId,
    checkId: tab.check_id,
    deviceId: who.deviceId,
    lines,
    version: draft?.version ?? 0,
    at: now.toString(),
  });
  if (version === null)
    throw new ApiError("version_conflict", "another screen saved these drinks first", {
      retryable: true,
    });
  await emitEvent(c, {
    venueId,
    type: "draft.updated",
    entityId: tab.check_id,
    entityVersion: version,
    audience: "user",
    userId: who.userId,
  });
  return { check_id: tab.check_id, lines, version, added: added.length, left_out: leftOut };
}

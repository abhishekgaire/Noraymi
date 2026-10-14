import {
  emitEvent,
  queueMenuPdf,
  readSetting,
  setModuleState,
  statesOf,
  venueModules,
  type Queryable,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import {
  KITCHEN_DEFAULTS,
  kitchenMissing,
  missingNeeds,
  t,
  type Clock,
  type KitchenMissing,
  type KitchenSettings,
  type MessageKey,
  type ModuleId,
  type Temporal,
} from "@west4/shared";

/**
 * Kitchen & food, the module part (spec 16 · The Kitchen module; K-01): the
 * `kitchen` settings in force tonight, what the switch still needs (a paired
 * kitchen printer and the allergy notice), and the open work that keeps it on.
 */

/** The venue's `kitchen` key for tonight's business date, or the spec's defaults until one is saved. */
export async function kitchenSettings(
  c: Queryable,
  venueId: string,
  clock: Clock,
): Promise<KitchenSettings> {
  const v = await c.query<{ time_zone: string; day_cutover: string }>(
    "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
    [venueId],
  );
  if (!v.rows[0]) return KITCHEN_DEFAULTS;
  const date = businessDate(clock.now(), v.rows[0].time_zone, v.rows[0].day_cutover).businessDate;
  return (await readSetting(c, venueId, "kitchen", date))?.value ?? KITCHEN_DEFAULTS;
}

/**
 * A kitchen printer is a printer device with station `kitchen`, not revoked or switched off: a cloud
 * printer, a printer cabled to a bar computer (W-03) or a network printer a bar computer relays
 * (W-04; D127).
 */
export async function hasKitchenPrinter(c: Queryable, venueId: string): Promise<boolean> {
  const r = await c.query(
    `select 1 from devices
      where venue_id = $1 and kind = 'printer' and station = 'kitchen'
        and revoked_at is null and disabled_at is null
      limit 1`,
    [venueId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function kitchenNeeds(
  c: Queryable,
  venueId: string,
  clock: Clock,
): Promise<KitchenMissing[]> {
  const settings = await kitchenSettings(c, venueId, clock);
  return kitchenMissing({
    kitchenPrinter: await hasKitchenPrinter(c, venueId),
    allergyNotice: settings.allergyNotice !== null,
  });
}

/** "Kitchen · needs a kitchen printer and the allergy notice", naming only what's missing. */
export function kitchenNeedsText(missing: readonly KitchenMissing[]): string {
  const parts = missing.map((m) => t("en", `kitchen.needs.${m}` as MessageKey));
  return t("en", "kitchen.needs", { list: parts.join(t("en", "kitchen.needs.and")) });
}

/**
 * Off is refused while a kitchen order is ringing, asked to wait or being made (spec 16 · What it
 * hides). An accepted food order stays "being made" until a runner picks it up.
 */
export async function kitchenOrdersOpen(c: Queryable, venueId: string): Promise<string | null> {
  const r = await c.query<{ n: number }>(
    `select count(distinct o.id)::int as n from orders o
       join order_items i on i.venue_id = o.venue_id and i.order_id = o.id
      where o.venue_id = $1 and i.station = 'kitchen' and o.status in ('ringing', 'held', 'accepted', 'ready')`,
    [venueId],
  );
  const n = r.rows[0]?.n ?? 0;
  return n > 0 ? t("en", "kitchen.refused.ordersOpen", { n }) : null;
}

/** Whether Kitchen & food is on (or stopping, which still serves what's open): off routes nothing to the kitchen. */
export async function kitchenOn(c: Queryable, venueId: string): Promise<boolean> {
  const r = await c.query<{ state: string }>(
    "select state from venue_modules where venue_id = $1 and module_id = 'kitchen'",
    [venueId],
  );
  return (r.rows[0]?.state ?? "off") !== "off";
}

/**
 * The menus follow the kitchen (K-08): after a save of the `kitchen` key or the module switching,
 * the room page and the room tablet refetch the menu (menu.changed) and the menu PDF renders again
 * a few seconds later, so the allergy notice is on all four menus within a minute.
 */
export async function menusFollowKitchen(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<void> {
  await queueMenuPdf(c, venueId, now.add({ seconds: 5 }).toString());
  await emitEvent(c, { venueId, type: "menu.changed", entityId: venueId });
}

/** The allergy notice every menu shows (K-08): only while the module is on and the notice is set. */
export async function menuAllergyNotice(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<{ en: string; es: string } | null> {
  if (!(await kitchenOn(c, venueId))) return null;
  return (await kitchenSettings(c, venueId, { now: () => now })).allergyNotice;
}

/**
 * On once ready (D129): every module the owner chose before its own needs were in place turns on
 * as soon as they are: Kitchen & food once it has a kitchen printer and the allergy notice (and Bar
 * screen & tickets, which it needs, is on). Called after anything that can complete those needs (a
 * `kitchen` settings save, a printer added) and at Finish setup. A module whose needs are still
 * missing stays off and wanted. Returns what it switched on.
 */
export async function switchOnWanted(
  c: Queryable,
  venueId: string,
  clock: Clock,
): Promise<ModuleId[]> {
  const rows = await venueModules(c, venueId);
  const wanted = rows.filter((r) => r.wanted && r.allowed && r.state === "off");
  if (wanted.length === 0) return [];
  const states = statesOf(rows);
  const on: ModuleId[] = [];
  for (const r of wanted) {
    if (missingNeeds(states, r.module_id).length > 0) continue;
    if (r.module_id === "kitchen" && (await kitchenNeeds(c, venueId, clock)).length > 0) continue;
    await setModuleState(c, venueId, r.module_id, "on", undefined);
    if (r.module_id === "kitchen") await menusFollowKitchen(c, venueId, clock.now());
    on.push(r.module_id);
  }
  if (on.length > 0)
    await emitEvent(c, {
      venueId,
      type: "settings.changed",
      entityId: "modules",
      entityVersion: 0,
    });
  return on;
}

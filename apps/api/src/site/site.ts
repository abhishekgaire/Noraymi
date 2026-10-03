import {
  closureOn,
  listRooms,
  menuTree,
  readSetting,
  rulePackFor,
  statesOf,
  venueModules,
  type Queryable,
} from "@west4/db";
import { allInCents, businessDate, hoursFor, openNow, percent, roomFor } from "@west4/rules";
import { siteContentSchema, Temporal, type ModuleId, type SiteContent } from "@west4/shared";
import { ApiError } from "../http/errors.js";

/**
 * The guest site (M5-01; Scope and architecture · Guest web; screens Main,
 * Rooms, Parties): the newest published `site_versions` content, plus every
 * live fact from its one place: hours and "Open now" from `hours` and
 * `closures` on the venue's clock, prices from `prices` with the gratuity and
 * the rule pack's tax, room sizes from the rooms, the menu's price ranges, the
 * phone number, and which sections the modules leave on.
 */
const pctOf = (rate: number) => {
  const [whole, frac = ""] = String(rate).split(".");
  const digits = (whole! + frac.padEnd(2, "0")).replace(/^0+(?=\d)/, "");
  const point = digits.length - Math.max(0, frac.length - 2);
  const out = frac.length > 2 ? `${digits.slice(0, point)}.${digits.slice(point)}` : digits;
  return out.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
};

export async function publishedContent(c: Queryable, venueId: string): Promise<SiteContent | null> {
  const r = await c.query<{ content: unknown }>(
    `select content from site_versions where venue_id = $1 and status = 'published'
      order by version desc limit 1`,
    [venueId],
  );
  return r.rows[0] ? siteContentSchema.parse(r.rows[0].content) : null;
}

export async function siteView(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  options: { guests?: number; hours?: number } = {},
) {
  const states = statesOf(await venueModules(c, venueId));
  const on = (id: ModuleId) => states[id] === "on";
  if (!on("website")) throw new ApiError("not_found", "this venue's site is off");
  const content = await publishedContent(c, venueId);
  if (!content) throw new ApiError("not_found", "this venue has no published site yet");
  const venue = (
    await c.query<{
      name: string;
      slug: string;
      address: Record<string, string> | null;
      time_zone: string;
      day_cutover: string;
      rule_pack_id: string | null;
    }>(
      `select name, slug, address, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover, rule_pack_id
         from venues where id = $1`,
      [venueId],
    )
  ).rows[0]!;
  const tonight = businessDate(now, venue.time_zone, venue.day_cutover).businessDate;
  const [hours, prices, pay, phone, website, closure, pack] = [
    await readSetting(c, venueId, "hours", tonight),
    await readSetting(c, venueId, "prices", tonight),
    await readSetting(c, venueId, "pay", tonight),
    await readSetting(c, venueId, "phone", tonight),
    await readSetting(c, venueId, "website", tonight),
    await closureOn(c, venueId, tonight.toString()),
    await rulePackFor(c, venue.rule_pack_id ?? "us-ny-new-york-county", tonight),
  ];
  if (!hours || !prices || !pay) throw new ApiError("internal", "the venue's settings aren't set");

  // Open now, from the venue's hours and tonight's closure, on the venue's clock (never the device's).
  const h = hoursFor(
    { timeZone: venue.time_zone, dayCutover: venue.day_cutover },
    tonight,
    hours.value,
    closure
      ? { date: closure.date, kind: closure.kind, opens: closure.opens, closes: closure.closes }
      : null,
  );
  const isOpen = openNow(h, now);

  // Prices in the venue's wording: "plus tax and a 20% gratuity", or all in.
  const rate = prices.value.rate;
  const perPersonCents = rate.mode === "perPerson" ? rate.perPersonCents : null;
  const gratuityPct = pay.value.gratuity.auto === "off" ? 0 : pay.value.gratuity.pct;
  const taxRatePct = pack ? pctOf(pack.pack.salesTax.rate) : "0";
  const wording = website?.value.priceWording ?? "plusTaxAndGratuity";
  const vip = prices.value.vip;
  const shown = (cents: number) =>
    wording === "allIn" ? allInCents(cents, taxRatePct, gratuityPct) : cents;

  // Room sizes, and tonight's billable minimum (Fridays and Saturdays 4 at West 4).
  const rooms = (await listRooms(c, venueId)).filter((r) => !r.archived_at);
  const tiers = [...new Set(rooms.map((r) => r.size_tier))].map((tier) => {
    const of = rooms.filter((r) => r.size_tier === tier);
    return {
      tier,
      rooms: of.length,
      capacityMin: Math.min(...of.map((r) => r.capacity_min)),
      capacityMax: Math.max(...of.map((r) => r.capacity_max)),
      vip: of.some((r) => r.is_vip),
    };
  });
  const weekend = tonight.dayOfWeek === 5 || tonight.dayOfWeek === 6;
  const minGuestsTonight = weekend
    ? prices.value.minGuests.friSat
    : prices.value.minGuests.weeknight;
  const guests = Math.min(Math.max(options.guests ?? minGuestsTonight, 1), 60);
  const fit =
    perPersonCents === null
      ? null
      : roomFor({
          guests,
          tiers,
          minGuestsTonight,
          perPersonCents,
          vip: vip ? { hourlyCents: vip.hourlyCents, fromGuests: vip.fromGuests } : null,
        });

  // The parties page's rough cost: room time for the hours, tax on it, the gratuity, all in.
  const estHours = Math.min(Math.max(Math.round(options.hours ?? 2), 1), 8);
  const estimate = fit
    ? (() => {
        const roomTime = fit.hourlyCents * estHours;
        const tax = percent(roomTime, taxRatePct);
        const gratuity = percent(roomTime, gratuityPct);
        return {
          hours: estHours,
          room_time_cents: roomTime,
          tax_cents: tax,
          gratuity_cents: gratuity,
          total_cents: roomTime + tax + gratuity,
        };
      })()
    : null;

  // The menu's price ranges, from the same menu list the menu page and the room page read.
  const menu = await menuTree(c, venueId, now.toString(), { shownOnly: true });
  const ranges = menu
    .map((cat) => {
      const all = cat.items.flatMap((i) => i.variants.map((v) => v.price_cents));
      return all.length
        ? { name: cat.name, fromCents: Math.min(...all), toCents: Math.max(...all) }
        : null;
    })
    .filter((x): x is { name: string; fromCents: number; toCents: number } => x !== null);
  const packages = on("packages")
    ? (
        await c.query<{ name: string; price_cents: number; hourly: boolean }>(
          `select name, price_cents, hourly from packages where venue_id = $1 and shown
            and not private_function_only order by price_cents, name`,
          [venueId],
        )
      ).rows
    : [];

  return {
    venue: {
      name: venue.name,
      slug: venue.slug,
      address: venue.address
        ? {
            line1: venue.address["line1"] ?? null,
            city: venue.address["city"] ?? null,
            region: venue.address["region"] ?? venue.address["state"] ?? null,
            postal_code: venue.address["postal_code"] ?? null,
          }
        : null,
      time_zone: venue.time_zone,
    },
    content: {
      ...content,
      // "Sing at the bar" waits behind its flag, and the bar's module.
      singAtTheBar: on("bar_mode") && content.singAtTheBar.live ? content.singAtTheBar : null,
    },
    now: now.toString(),
    business_date: tonight.toString(),
    hours: {
      open_now: isOpen,
      closed_tonight: h.closed,
      opens: h.opens?.toString() ?? null,
      closes: h.closes?.toString() ?? null,
      weekly: hours.value.weekly,
    },
    phone: phone?.value.callNumber ?? null,
    prices: {
      wording,
      gratuity_pct: gratuityPct,
      per_person_cents: perPersonCents === null ? null : shown(perPersonCents),
      vip: vip ? { hourly_cents: shown(vip.hourlyCents), from_guests: vip.fromGuests } : null,
    },
    rooms: {
      tiers,
      min_guests_tonight: minGuestsTonight,
      guests,
      fit: fit
        ? {
            tier: fit.tier.tier,
            billable_guests: fit.billableGuests,
            hourly_cents: shown(fit.hourlyCents),
          }
        : null,
    },
    estimate,
    tax_pct: taxRatePct,
    menu: ranges,
    packages,
    songs: { count: content.songbook.songCount, search: false },
    modules: {
      booking: on("online_booking"),
      waitlist: on("waitlist"),
      rooms: on("rooms"),
      packages: on("packages"),
    },
  };
}

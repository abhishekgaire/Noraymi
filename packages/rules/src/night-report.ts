/**
 * The night's sales, tax and gratuity (M7-13; Money rules 8, 9, 11 and 16):
 * the X report while the night runs and the Z report at its close, worked out
 * from the night's check lines as written, never as a percent of sales. Drinks
 * are split into room checks and bar tabs; the gratuity is the sum of the
 * gratuity lines on the checks that carry one (at West 4, room checks); tax is
 * grouped by jurisdiction and rate with its taxable base. Practice checks never
 * reach this function (the caller reads the live views).
 */
export interface ReportLine {
  readonly check_id: string;
  readonly check_kind: "room" | "bar" | "quick" | "fee";
  readonly kind: string;
  readonly amount_cents: number;
  readonly tax_category: string | null;
  readonly jurisdiction_code: string | null;
  readonly tax_rate: string | null;
  readonly taxable_base_cents: number | null;
  readonly description: string;
  /** An item that is a package sold to a room. */
  readonly is_package?: boolean;
}

export interface SalesReport {
  readonly sales: {
    readonly room_time_cents: number;
    readonly drinks_room_checks_cents: number;
    readonly drinks_bar_tabs_cents: number;
    /** Food (K-10): items with tax category food, rooms and bar together; a package's food is in packages. */
    readonly food_cents: number;
    readonly packages_cents: number;
    readonly songs_cents: number;
    readonly damage_cents: number;
    readonly kept_deposits_cents: number;
    readonly min_spend_cents: number;
    readonly card_surcharge_cents: number;
    readonly fees_cents: number;
    readonly comps_cents: number;
    readonly voids_cents: number;
    readonly discounts_cents: number;
    readonly refunds_cents: number;
    readonly net_cents: number;
  };
  readonly tax: readonly {
    readonly jurisdiction: string;
    readonly rate: string;
    readonly taxable_base_cents: number;
    readonly tax_cents: number;
  }[];
  readonly tax_cents: number;
  readonly gratuity: {
    readonly total_cents: number;
    readonly by_check: Readonly<Record<string, number>>;
    readonly bar_tabs_cents: number;
    readonly refunded_cents: number;
  };
  readonly counts: { readonly rooms: number; readonly bar_tabs: number };
}

/** A refund's share of the gratuity, as M4-21 writes it. */
const GRATUITY_REFUND = "Refund · Gratuity";
/** Moves between checks net to zero across the night; they're not sales. */
const MOVES = new Set(["transfer_in", "transfer_out"]);

export function salesReport(lines: readonly ReportLine[]): SalesReport {
  let roomTime = 0;
  let drinksRoom = 0;
  let drinksBar = 0;
  let food = 0;
  let packages = 0;
  let songs = 0;
  let damage = 0;
  let kept = 0;
  let minSpend = 0;
  let surcharge = 0;
  let fees = 0;
  let comps = 0;
  let voids = 0;
  let discounts = 0;
  let refunds = 0;
  let gratuityRefunded = 0;
  const byCheck: Record<string, number> = {};
  let barGratuity = 0;
  const tax = new Map<string, { jurisdiction: string; rate: string; base: number; tax: number }>();
  const rooms = new Set<string>();
  const bars = new Set<string>();
  for (const l of lines) {
    if (l.check_kind === "room") rooms.add(l.check_id);
    else if (l.check_kind === "bar" || l.check_kind === "quick") bars.add(l.check_id);
    const a = l.amount_cents;
    switch (l.kind) {
      case "room_time":
        roomTime += a;
        break;
      case "item":
        if (l.is_package) packages += a;
        else if (l.tax_category === "food") food += a;
        else if (l.check_kind === "room") drinksRoom += a;
        else drinksBar += a;
        break;
      case "song":
        songs += a;
        break;
      case "damage":
        damage += a;
        break;
      case "forfeit":
        kept += a;
        break;
      case "fee":
        if (l.check_kind === "fee") kept += a;
        else fees += a;
        break;
      case "min_spend":
        minSpend += a;
        break;
      case "card_surcharge":
        surcharge += a;
        break;
      case "comp":
        comps += a;
        break;
      case "void":
        voids += a;
        break;
      case "discount":
      case "cash_discount":
        discounts += a;
        break;
      case "refund":
        if (l.description === GRATUITY_REFUND) gratuityRefunded += a;
        else refunds += a;
        break;
      case "gratuity":
        if (l.check_kind === "room") byCheck[l.check_id] = (byCheck[l.check_id] ?? 0) + a;
        else barGratuity += a;
        break;
      case "tax": {
        const key = `${l.jurisdiction_code ?? ""}|${l.tax_rate ?? ""}`;
        const t = tax.get(key) ?? {
          jurisdiction: l.jurisdiction_code ?? "",
          rate: l.tax_rate ?? "",
          base: 0,
          tax: 0,
        };
        t.base += l.taxable_base_cents ?? 0;
        t.tax += a;
        tax.set(key, t);
        break;
      }
      default:
        if (!MOVES.has(l.kind)) fees += a;
    }
  }
  const net =
    roomTime +
    drinksRoom +
    drinksBar +
    food +
    packages +
    songs +
    damage +
    kept +
    minSpend +
    surcharge +
    fees +
    comps +
    voids +
    discounts +
    refunds;
  const taxRows = [...tax.values()]
    .sort((x, y) => (x.jurisdiction + x.rate < y.jurisdiction + y.rate ? -1 : 1))
    .map((t) => ({
      jurisdiction: t.jurisdiction,
      rate: t.rate,
      taxable_base_cents: t.base,
      tax_cents: t.tax,
    }));
  const roomGratuity = Object.values(byCheck).reduce((s, c) => s + c, 0);
  return {
    sales: {
      room_time_cents: roomTime,
      drinks_room_checks_cents: drinksRoom,
      drinks_bar_tabs_cents: drinksBar,
      food_cents: food,
      packages_cents: packages,
      songs_cents: songs,
      damage_cents: damage,
      kept_deposits_cents: kept,
      min_spend_cents: minSpend,
      card_surcharge_cents: surcharge,
      fees_cents: fees,
      comps_cents: comps,
      voids_cents: voids,
      discounts_cents: discounts,
      refunds_cents: refunds,
      net_cents: net,
    },
    tax: taxRows,
    tax_cents: taxRows.reduce((s, t) => s + t.tax_cents, 0),
    gratuity: {
      total_cents: roomGratuity + barGratuity + gratuityRefunded,
      by_check: byCheck,
      bar_tabs_cents: barGratuity,
      refunded_cents: gratuityRefunded,
    },
    counts: { rooms: rooms.size, bar_tabs: bars.size },
  };
}

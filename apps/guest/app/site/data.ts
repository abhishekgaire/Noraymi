import { notFound } from "next/navigation";
import { cents, formatMoney, type SiteContent, type SiteSection } from "@west4/shared";

/**
 * The guest site's data (M5-01): one server-side read of
 * `GET /v1/public/venues/{slug}/site`, rendered on the server so every page
 * carries its content with JavaScript off. Times are the venue's, never the
 * device's.
 */
export interface SiteView {
  readonly venue: {
    readonly name: string;
    readonly slug: string;
    readonly address: {
      readonly line1: string | null;
      readonly city: string | null;
      readonly region: string | null;
      readonly postal_code: string | null;
    } | null;
    readonly time_zone: string;
  };
  readonly content: Omit<SiteContent, "singAtTheBar"> & {
    readonly singAtTheBar: SiteContent["singAtTheBar"] | null;
  };
  readonly now: string;
  readonly business_date: string;
  readonly hours: {
    readonly open_now: boolean;
    readonly closed_tonight: boolean;
    readonly opens: string | null;
    readonly closes: string | null;
    readonly weekly: readonly { day: number; opens: string; closes: string }[];
  };
  readonly phone: string | null;
  readonly prices: {
    readonly wording: "plusTaxAndGratuity" | "allIn";
    readonly gratuity_pct: number;
    readonly per_person_cents: number | null;
    readonly vip: { readonly hourly_cents: number; readonly from_guests: number } | null;
  };
  readonly rooms: {
    readonly tiers: readonly {
      tier: string;
      rooms: number;
      capacityMin: number;
      capacityMax: number;
      vip: boolean;
    }[];
    readonly min_guests_tonight: number;
    readonly guests: number;
    readonly fit: { tier: string; billable_guests: number; hourly_cents: number } | null;
  };
  readonly estimate: {
    readonly hours: number;
    readonly room_time_cents: number;
    readonly tax_cents: number;
    readonly gratuity_cents: number;
    readonly total_cents: number;
  } | null;
  readonly tax_pct: string;
  readonly menu: readonly { name: string; fromCents: number; toCents: number }[];
  readonly packages: readonly { name: string; price_cents: number; hourly: boolean }[];
  readonly songs: { readonly count: number | null; readonly search: boolean };
  readonly sections: Readonly<Record<SiteSection, boolean>>;
  readonly photos: readonly { url: string; alt: string; place: "hero" | "rooms" | "parties" }[];
  readonly modules: {
    readonly booking: boolean;
    readonly waitlist: boolean;
    readonly rooms: boolean;
    readonly packages: boolean;
  };
}

const api = (process.env["API_URL"] ?? "http://localhost:3000").replace(/\/+$/, "");

export async function fetchSite(
  slug: string,
  query: { guests?: string | undefined; hours?: string | undefined } = {},
): Promise<SiteView> {
  const params = new URLSearchParams();
  if (query.guests && /^\d{1,2}$/.test(query.guests)) params.set("guests", query.guests);
  if (query.hours && /^\d$/.test(query.hours)) params.set("hours", query.hours);
  const r = await fetch(
    `${api}/v1/public/venues/${encodeURIComponent(slug)}/site${params.size ? `?${params}` : ""}`,
    { cache: "no-store" },
  );
  if (r.status === 404) notFound();
  if (!r.ok) throw new Error(`the site couldn't load (${r.status})`);
  return (await r.json()) as SiteView;
}

/** The venue the bare domain shows (staging and local run one venue's site at "/"). */
export const defaultSlug = () => process.env["SITE_VENUE"] ?? "west4karaoke";

/** "$10", or "$12.89" when there are cents. */
export const money = (c: number) => formatMoney("en", cents(c)).replace(/\.00$/, "");

/** "+12122550011" → "(212) 255-0011". */
export const phoneLabel = (e164: string) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
};

/** "4 AM" on the hour, "11:30 PM" otherwise, in the venue's zone. */
export const clockWords = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(iso))
    .replace(":00 ", " ");

/** "16:00" → "4 PM". */
export const hhmmWords = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 || h === 24 ? "AM" : "PM"}`;
};

/** The guest menu (M5-03): the same list the room page and the PDF read. */
export interface GuestMenu {
  readonly categories: readonly {
    readonly id: string;
    readonly name: string;
    readonly items: readonly {
      readonly id: string;
      readonly name: string;
      readonly description: string | null;
      readonly out_tonight: boolean;
      readonly variants: readonly {
        readonly id: string;
        readonly name: string;
        readonly price_cents: number;
        readonly out_tonight: boolean;
      }[];
      readonly groups: readonly {
        readonly id: string;
        readonly name: string;
        readonly options: readonly {
          readonly id: string;
          readonly name: string;
          readonly price_delta_cents: number;
          readonly out_tonight: boolean;
        }[];
      }[];
    }[];
  }[];
  readonly packages: readonly { name: string; price_cents: number; hourly: boolean }[];
  readonly happy_hours: readonly {
    readonly name: string;
    readonly days: readonly number[];
    readonly from_min: number | null;
    readonly to_min: number | null;
    readonly pct_off: number | null;
    readonly price_cents: number | null;
    readonly qty: number;
    readonly items: readonly string[];
  }[];
}

export async function fetchMenu(slug: string): Promise<GuestMenu> {
  const r = await fetch(`${api}/v1/public/venues/${encodeURIComponent(slug)}/menu`, {
    cache: "no-store",
  });
  if (r.status === 404) notFound();
  if (!r.ok) throw new Error(`the menu couldn't load (${r.status})`);
  return (await r.json()) as GuestMenu;
}

/** A link to the current menu PDF, or null before the first one is rendered. */
export async function fetchMenuPdf(slug: string): Promise<string | null> {
  const r = await fetch(`${api}/v1/public/venues/${encodeURIComponent(slug)}/menu/pdf`, {
    cache: "no-store",
  }).catch(() => null);
  if (!r?.ok) return null;
  return ((await r.json()) as { url: string }).url;
}

/** Minutes from midnight (past 1440 into the next morning) → "4 PM". */
export const minuteWords = (min: number) => {
  const m = min % 1440;
  return hhmmWords(
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
  );
};

/** The quote a booking shows before paying (M5-07). */
export interface Quote {
  readonly business_date: string;
  readonly min_guests: number;
  readonly billable_guests: number;
  readonly minutes: number;
  readonly room_time_cents: number;
  readonly tax_cents: number;
  readonly gratuity_cents: number;
  readonly total_cents: number;
  readonly deposit_cents: number;
}

export interface Availability {
  readonly business_date: string;
  readonly today: string;
  readonly guests: number;
  readonly hours: number;
  readonly min_guests: number;
  readonly billable_guests: number;
  readonly limits: { min_hours: number; max_hours: number; max_guests: number };
  readonly price_wording: "plusTaxAndGratuity" | "allIn";
  readonly tax_pct: string;
  readonly gratuity_pct: number;
  readonly closed: boolean;
  readonly too_big: boolean;
  readonly slots: readonly {
    start: string;
    time: string;
    zone: string;
    offset: string;
    free: boolean;
    size_tier: string | null;
  }[];
  readonly quote: Quote | null;
}

/** null when Online booking & deposits is off. */
export async function fetchAvailability(
  slug: string,
  q: { date?: string | undefined; guests: number; hours?: number | undefined },
): Promise<Availability | null> {
  const params = new URLSearchParams({ guests: String(q.guests) });
  if (q.date) params.set("date", q.date);
  if (q.hours) params.set("hours", String(q.hours));
  const r = await fetch(
    `${api}/v1/public/venues/${encodeURIComponent(slug)}/availability?${params}`,
    { cache: "no-store" },
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`availability couldn't load (${r.status})`);
  return (await r.json()) as Availability;
}

export interface HeldBooking {
  readonly id: string;
  readonly status: "pending" | "lapsed" | "cancelled" | "confirmed" | string;
  readonly party_size: number;
  readonly size_tier: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly time_zone: string;
  readonly pending_until: string | null;
  readonly seconds_left: number | null;
  readonly more_time_left: number;
  readonly refund_cutoff_at: string | null;
  /** "Thu 11:00 PM", the refund cut-off in the venue's time zone (M5-08). */
  readonly cutoff_words: string | null;
  readonly guest: { name: string; phone: string | null; email: string | null } | null;
  /** M5-10: the deposit paid, and a late payment refunded in full because the room had gone. */
  readonly deposit_paid_cents: number;
  readonly late_refund: { amount_cents: number; status: string } | null;
  readonly policy: { id: string; version: number; text: string; hash: string } | null;
  readonly accepted: { policy_version_id: string; at: string } | null;
  /** The marketing box's exact words; null while Marketing texts is off. */
  readonly marketing_box: { id: string; text: string } | null;
  readonly price_wording: "plusTaxAndGratuity" | "allIn";
  readonly tax_pct: string;
  readonly gratuity_pct: number;
  readonly quote: Quote;
}

export async function fetchHold(token: string): Promise<HeldBooking | null> {
  const r = await fetch(`${api}/v1/public/bookings/${encodeURIComponent(token)}/hold`, {
    cache: "no-store",
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`the booking couldn't load (${r.status})`);
  return (await r.json()) as HeldBooking;
}

/** "Fri, Sep 25" for a business date. */
export const dateWords = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));

/** The query the Pick form sends, checked; the party starts at tonight's billable minimum. */
export function pickQuery(
  q: { date?: string; guests?: string; hours?: string },
  defaultGuests: number,
) {
  const guests = Number(q.guests);
  const hours = Number(q.hours);
  return {
    date: q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : undefined,
    guests: Number.isInteger(guests) && guests >= 1 && guests <= 500 ? guests : defaultGuests,
    hours: Number.isInteger(hours * 2) && hours > 0 && hours <= 24 ? hours : undefined,
  };
}

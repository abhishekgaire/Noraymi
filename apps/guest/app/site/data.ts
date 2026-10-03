import { notFound } from "next/navigation";
import { cents, formatMoney, type SiteContent } from "@west4/shared";

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

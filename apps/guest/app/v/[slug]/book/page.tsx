import { BookPage } from "../../../site/book";
import { fetchAvailability, fetchSite, pickQuery } from "../../../site/data";

/** A venue's Book page, the Pick step (M5-07). */
export const dynamic = "force-dynamic";

export default async function VenueBook({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string; guests?: string; hours?: string }>;
}) {
  const { slug } = await params;
  const q = await searchParams;
  const site = await fetchSite(slug);
  const pick = await fetchAvailability(slug, pickQuery(q, site.rooms.min_guests_tonight));
  return <BookPage site={site} base={`/v/${slug}`} path={`/v/${slug}/book`} pick={pick} />;
}

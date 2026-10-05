import { BookPage } from "../site/book";
import { defaultSlug, fetchAvailability, fetchSite, pickQuery } from "../site/data";

/** The bare domain's Book page (M5-07). */
export const dynamic = "force-dynamic";

export default async function Book({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; guests?: string; hours?: string }>;
}) {
  const slug = defaultSlug();
  const site = await fetchSite(slug);
  const pick = await fetchAvailability(
    slug,
    pickQuery(await searchParams, site.rooms.min_guests_tonight),
  );
  return <BookPage site={site} base={`/v/${slug}`} path="/book" pick={pick} />;
}

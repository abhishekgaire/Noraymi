import { Parties } from "../../../site/parties";
import { fetchSite } from "../../../site/data";

/** A venue's private parties page (M5-01). */
export const dynamic = "force-dynamic";

export default async function VenueParties({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ guests?: string; hours?: string }>;
}) {
  const { slug } = await params;
  const { guests, hours } = await searchParams;
  const site = await fetchSite(slug, { guests: guests ?? "12", hours });
  return <Parties site={site} base={`/v/${slug}`} path={`/v/${slug}/parties`} />;
}

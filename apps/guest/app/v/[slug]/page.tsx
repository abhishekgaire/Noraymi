import { Home } from "../../site/home";
import { fetchSite } from "../../site/data";

/** A venue's home page (M5-01), rendered on every request from the venue's published site. */
export const dynamic = "force-dynamic";

export default async function VenueHome({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ guests?: string }>;
}) {
  const { slug } = await params;
  const { guests } = await searchParams;
  const site = await fetchSite(slug, { guests });
  return <Home site={site} base={`/v/${slug}`} path={`/v/${slug}`} />;
}

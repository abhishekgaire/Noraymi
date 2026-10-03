import { Parties } from "../../../site/parties";
import { notFound } from "next/navigation";
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
  // Admin → Website can hide the page (M5-02).
  if (!site.sections.parties) notFound();
  return <Parties site={site} base={`/v/${slug}`} path={`/v/${slug}/parties`} />;
}

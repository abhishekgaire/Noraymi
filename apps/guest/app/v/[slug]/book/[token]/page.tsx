import { notFound } from "next/navigation";
import { HeldPage } from "../../../../site/held";
import { fetchHold, fetchSite } from "../../../../site/data";

/** A held booking (M5-07), by its link. */
export const dynamic = "force-dynamic";

export default async function VenueHeld({
  params,
}: {
  params: Promise<{ slug: string; token: string }>;
}) {
  const { slug, token } = await params;
  const [site, held] = await Promise.all([fetchSite(slug), fetchHold(token)]);
  if (!held) notFound();
  return <HeldPage site={site} base={`/v/${slug}`} token={token} held={held} />;
}

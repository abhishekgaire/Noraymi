import { Home } from "./site/home";
import { defaultSlug, fetchSite } from "./site/data";

/** The bare domain shows the venue it serves (SITE_VENUE; West 4 on staging and locally). */
export const dynamic = "force-dynamic";

export default async function Root({
  searchParams,
}: {
  searchParams: Promise<{ guests?: string }>;
}) {
  const { guests } = await searchParams;
  const slug = defaultSlug();
  const site = await fetchSite(slug, { guests });
  return <Home site={site} base={`/v/${slug}`} path="/" />;
}

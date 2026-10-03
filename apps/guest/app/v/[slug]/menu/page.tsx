import { MenuPage } from "../../../site/menu";
import { fetchMenu, fetchMenuPdf, fetchSite } from "../../../site/data";

/** A venue's menu page (M5-03). */
export const dynamic = "force-dynamic";

export default async function VenueMenu({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [site, menu, pdf] = await Promise.all([
    fetchSite(slug),
    fetchMenu(slug),
    fetchMenuPdf(slug),
  ]);
  return <MenuPage site={site} menu={menu} pdf={pdf} base={`/v/${slug}`} />;
}

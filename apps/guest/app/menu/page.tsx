import { MenuPage } from "../site/menu";
import { defaultSlug, fetchMenu, fetchMenuPdf, fetchSite } from "../site/data";

/** The bare domain's menu page (M5-03). */
export const dynamic = "force-dynamic";

export default async function Menu() {
  const slug = defaultSlug();
  const [site, menu, pdf] = await Promise.all([
    fetchSite(slug),
    fetchMenu(slug),
    fetchMenuPdf(slug),
  ]);
  return <MenuPage site={site} menu={menu} pdf={pdf} base={`/v/${slug}`} />;
}

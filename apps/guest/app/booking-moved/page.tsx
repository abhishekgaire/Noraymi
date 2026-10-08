import { t } from "@west4/shared";
import { SiteFooter, SiteHeader } from "../site/home";
import { defaultSlug, fetchSite, phoneLabel } from "../site/data";

/**
 * Where an old site's manage-booking link lands (M9-09): its token can't carry
 * over, so the guest calls West 4. No new text is sent; the 14 texts are fixed.
 */
export const dynamic = "force-dynamic";

export default async function BookingMoved() {
  const slug = defaultSlug();
  const site = await fetchSite(slug);
  const base = `/v/${slug}`;
  return (
    <>
      <SiteHeader site={site} base={base} />
      <main className="guest site">
        <h1>{t("en", "site.moved.title")}</h1>
        {site.phone ? (
          <>
            <p>{t("en", "site.moved.body")}</p>
            <p>
              <a className="button" href={`tel:${site.phone}`}>
                {phoneLabel(site.phone)}
              </a>
            </p>
          </>
        ) : (
          <p>{t("en", "site.moved.noPhone")}</p>
        )}
      </main>
      <SiteFooter site={site} base={base} />
    </>
  );
}

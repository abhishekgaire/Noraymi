/** The part of a menu category the PDF prints: the guest menu's list (menu/guest-menu.ts). */
interface PdfCategory {
  readonly name: string;
  readonly items: readonly {
    readonly name: string;
    readonly description: string | null;
    readonly variants: readonly { readonly name: string; readonly price_cents: number }[];
    readonly groups: readonly {
      readonly name: string;
      readonly options: readonly { readonly name: string; readonly price_delta_cents: number }[];
    }[];
  }[];
}

/**
 * The menu PDF (M3-05; spec 01 · Files and PDFs; spec 12 · 14): the same
 * list the room page reads, as HTML first, printed by Chromium to a tagged
 * PDF (real text, headings and reading order). Hidden items are left out by
 * the caller; 86 lasts one night, so it doesn't change the PDF (flagged).
 */
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (cents: number) =>
  `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

export function menuHtml(
  venueName: string,
  categories: readonly PdfCategory[],
  packages: readonly { name: string; price_cents: number; hourly: boolean }[] = [],
  /** The allergy notice from Admin → Kitchen (K-08), both languages; null while it isn't shown. */
  allergyNotice: { readonly en: string; readonly es: string } | null = null,
): string {
  const sections = categories
    .filter((c) => c.items.length > 0)
    .map((c) => {
      const items = c.items
        .map((item) => {
          const prices =
            item.variants.length === 1
              ? money(item.variants[0]!.price_cents)
              : item.variants.map((v) => `${escape(v.name)} ${money(v.price_cents)}`).join(" · ");
          const choices = item.groups
            .map(
              (g) =>
                `${escape(g.name)}: ${g.options
                  .map((o) =>
                    o.price_delta_cents > 0
                      ? `${escape(o.name)} +${money(o.price_delta_cents)}`
                      : escape(o.name),
                  )
                  .join(", ")}`,
            )
            .join(". ");
          return `<li><p class="line"><span class="name">${escape(item.name)}</span> <span class="price">${prices}</span></p>${
            item.description ? `<p class="desc">${escape(item.description)}</p>` : ""
          }${choices ? `<p class="choices">${choices}</p>` : ""}</li>`;
        })
        .join("");
      return `<section><h2>${escape(c.name)}</h2><ul>${items}</ul></section>`;
    })
    .join("");
  // Packages, with Packages & specials on and the promotion checks passing (M5-03).
  const packs = packages.length
    ? `<section><h2>Packages</h2><ul>${packages
        .map(
          (p) =>
            `<li><p class="line"><span class="name">${escape(p.name)}</span> <span class="price">${money(p.price_cents)}${p.hourly ? " an hour" : ""}</span></p></li>`,
        )
        .join("")}</ul></section>`
    : "";
  // The allergy notice (K-08; spec 16 · The allergy notice): the owner's words only, never ours,
  // in English and then Spanish, at the top of the menu.
  const notice = allergyNotice
    ? `<aside class="allergy" aria-label="Allergy notice"><p>${escape(allergyNotice.en)}</p><p lang="es">${escape(allergyNotice.es)}</p></aside>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(venueName)} · Menu</title>
<style>
  body { font-family: "Noto Sans", Helvetica, Arial, sans-serif; color: #111; margin: 0; font-size: 11pt; }
  h1 { font-size: 22pt; margin: 0 0 12pt; }
  h2 { font-size: 15pt; margin: 14pt 0 6pt; border-bottom: 1px solid #999; }
  ul { list-style: none; padding: 0; margin: 0; columns: 2; column-gap: 24pt; }
  li { break-inside: avoid; margin: 0 0 5pt; }
  p { margin: 0; }
  .line { display: flex; justify-content: space-between; gap: 8pt; }
  .price { white-space: nowrap; }
  .desc, .choices { font-size: 9pt; color: #333; }
  .allergy { border: 1.5pt solid #111; padding: 6pt 8pt; margin: 0 0 10pt; font-size: 10pt; }
  .allergy p + p { margin-top: 4pt; }
</style></head><body><main><h1>${escape(venueName)} · Menu</h1>${notice}${sections}${packs}</main></body></html>`;
}

/** Prints HTML to a tagged PDF with Chromium; MENU_PDF_CHROMIUM names a system Chromium (the API image). */
export async function htmlToPdf(
  html: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Uint8Array> {
  const { chromium } = await import("playwright-core");
  const executablePath = env["MENU_PDF_CHROMIUM"];
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "Letter",
      margin: { top: "0.6in", bottom: "0.6in", left: "0.6in", right: "0.6in" },
      printBackground: true,
      tagged: true,
      outline: true,
    });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}

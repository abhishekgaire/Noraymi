import pg from "pg";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Temporal } from "@west4/shared";
import { guestMenu } from "./guest-menu.js";
import { htmlToPdf, menuHtml } from "./pdf.js";

/**
 * The menu PDF's text as the job would print it at `now` (M5-03): the same
 * guest menu list, the same HTML, the same Chromium print, then pdf.js reads
 * the words back. The end-to-end comparison test uses it to check the PDF
 * against the menu page and the room page's menu route.
 */
export async function menuPdfText(databaseUrl: string, slug: string, now: string) {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const venue = (
      await db.query<{ id: string; name: string }>("select id, name from venues where slug = $1", [
        slug,
      ])
    ).rows[0];
    if (!venue) throw new Error(`no venue ${slug}`);
    const menu = await guestMenu(db, venue.id, Temporal.Instant.from(now));
    const bytes = await htmlToPdf(menuHtml(venue.name, menu.categories, menu.packages));
    const doc = await getDocument({ data: bytes }).promise;
    let text = "";
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      text += content.items.map((i) => ("str" in i ? `${i.str} ` : "")).join("");
    }
    return text.replace(/\s+/g, " ");
  } finally {
    await db.end();
  }
}

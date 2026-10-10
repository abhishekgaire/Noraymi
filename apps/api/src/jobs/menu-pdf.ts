import { DeleteObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { emitEvent, type JobContext, type JobHandler } from "@west4/db";
import { guestMenu } from "../menu/guest-menu.js";
import { htmlToPdf, menuHtml } from "../menu/pdf.js";

/**
 * The menu PDF job (M3-05), in the bulk pool. Every menu save queues it a few
 * seconds out unless one is already waiting, so a burst of saves renders once,
 * and it renders the menu as it stands when it runs. The PDF is a `menu_pdf`
 * file, kept until the next one replaces it; the old one is marked removed
 * and its object deleted. Rendering and storage happen outside any
 * transaction.
 */
export const MENU_PDF_KIND = "menu.pdf";

export function makeMenuPdfHandler(
  s3: S3Client,
  bucket: string,
  render: (html: string) => Promise<Uint8Array> = htmlToPdf,
): JobHandler {
  return async ({ job, clock, step }: JobContext) => {
    const now = clock.now();
    const { name, menu } = await step(async (c) => {
      const v = await c.query<{ name: string }>("select name from venues where id = $1", [
        job.venue_id,
      ]);
      if (!v.rows[0]) throw new Error(`venue ${job.venue_id} not visible`);
      return {
        name: v.rows[0].name,
        // The same list the menu page and the room page read (M5-03).
        menu: await guestMenu(c, job.venue_id, now),
      };
    });
    const pdf = await render(menuHtml(name, menu.categories, menu.packages, menu.allergy_notice));
    const key = `${job.venue_id}/menu_pdf/${job.id}.pdf`;
    await s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: pdf, ContentType: "application/pdf" }),
    );
    const replaced = await step(async (c) => {
      const made = await c.query<{ id: string }>(
        `insert into files (venue_id, kind, storage_key, content_type, bytes, uploaded_at, attached_at)
           values ($1, 'menu_pdf', $2, 'application/pdf', $3, $4, $4)
           on conflict (storage_key) do update set attached_at = excluded.attached_at
           returning id`,
        [job.venue_id, key, pdf.byteLength, now.toString()],
      );
      const fileId = made.rows[0]!.id;
      const old = await c.query<{ storage_key: string }>(
        `update files set removed_at = $3
          where venue_id = $1 and kind = 'menu_pdf' and id <> $2 and removed_at is null
          returning storage_key`,
        [job.venue_id, fileId, now.toString()],
      );
      await emitEvent(c, { venueId: job.venue_id, type: "menu.pdf_ready", entityId: fileId });
      return old.rows.map((r) => r.storage_key);
    });
    for (const old of replaced) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: old })).catch(() => {});
    }
  };
}

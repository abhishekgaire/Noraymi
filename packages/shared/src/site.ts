import { z } from "zod";

/**
 * A guest site's content (M5-01; Data model · site_versions): the venue's own
 * words for each section. Live facts (hours, prices, the menu, the phone
 * number, room sizes) are never stored here; the site reads them from their
 * one place. Sections a module hides are left out whatever the content says.
 */
const line = z.string().min(1).max(400);
export const siteContentSchema = z
  .object({
    hero: z.object({ headline: z.string().min(1).max(80), lead: line }).strict(),
    numbers: z.array(z.object({ value: z.string().min(1).max(12), text: line }).strict()).max(6),
    songbook: z
      .object({ heading: z.string().min(1).max(80), songCount: z.number().int().min(0).nullable() })
      .strict(),
    singAtTheBar: z
      .object({
        heading: z.string().min(1).max(80),
        lead: line,
        /** The venue flag: the section waits until the singer's queue page ships (M6). */
        live: z.boolean(),
      })
      .strict(),
    houseRules: z.array(line).max(8),
    findUs: z
      .object({
        directions: line,
        social: z.array(z.object({ label: z.string(), handle: z.string() }).strict()).max(6),
      })
      .strict(),
    rooms: z.object({ heading: z.string().min(1).max(80), lead: line }).strict(),
    parties: z
      .object({
        headline: z.string().min(1).max(80),
        lead: line,
        hosts: z
          .array(
            z
              .object({ title: z.string().min(1).max(60), tag: z.string().max(30), text: line })
              .strict(),
          )
          .max(8),
        notes: z.array(line).max(8),
        packagesNote: line.nullable(),
      })
      .strict(),
  })
  .strict();
export type SiteContent = z.infer<typeof siteContentSchema>;

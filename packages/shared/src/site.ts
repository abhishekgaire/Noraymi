import { z } from "zod";
import type { ModuleId } from "./modules.js";

/**
 * The sections Admin → Website can show or hide (M5-02), and the module each
 * one needs. A section whose module is off stays hidden whatever the content
 * says, and Admin can't switch it on.
 */
export const SITE_SECTIONS = {
  numbers: null,
  songbook: null,
  singAtTheBar: "bar_mode",
  menu: null,
  houseRules: null,
  rooms: "rooms",
  findUs: null,
  parties: null,
  packages: "packages",
} as const satisfies Record<string, ModuleId | null>;
export type SiteSection = keyof typeof SITE_SECTIONS;
export const SITE_SECTION_IDS = Object.keys(SITE_SECTIONS) as SiteSection[];

/** Where a photo shows. Every photo carries alt text (Security and data retention 14). */
export const SITE_PHOTO_PLACES = ["hero", "rooms", "parties"] as const;
export const sitePhotoSchema = z
  .object({
    file_id: z.string().uuid(),
    alt: z.string().trim().min(1, "a photo needs alt text").max(200),
    place: z.enum(SITE_PHOTO_PLACES),
  })
  .strict();
export type SitePhoto = z.infer<typeof sitePhotoSchema>;

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
    /** The sections Admin turned off (M5-02); every other section shows when its module is on. */
    hidden: z.array(z.enum(SITE_SECTION_IDS as [SiteSection, ...SiteSection[]])).default([]),
    photos: z.array(sitePhotoSchema).max(12).default([]),
  })
  .strict();
export type SiteContent = z.infer<typeof siteContentSchema>;

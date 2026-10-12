import { z } from "zod";

/**
 * The venue's own facts in Admin → Venue and Set up your venue's step 1 (O-03; spec 17 · Step
 * details 1): the name guests see, the organization's legal name and the street address. The
 * address confirms the rule pack and time zone the Console set and never changes them: phase 1 has
 * New York's rule pack only, so an address outside New York City is refused ("contact us").
 */
export const venueAddressSchema = z
  .object({
    line1: z.string().trim().min(1).max(120),
    line2: z.string().trim().max(120).nullable().optional(),
    city: z.string().trim().min(1).max(80),
    state: z.string().trim().toUpperCase().length(2),
    postal_code: z
      .string()
      .trim()
      .regex(/^\d{5}(-\d{4})?$/, "a 5-digit ZIP code"),
  })
  .strict();
export type VenueAddress = z.infer<typeof venueAddressSchema>;

export const venueProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    legal_name: z.string().trim().min(1).max(160),
    address: venueAddressSchema.nullable(),
  })
  .strict();
export type VenueProfile = z.infer<typeof venueProfileSchema>;

/**
 * New York City's ZIP codes by their first three digits: Manhattan 100 to 102, Staten Island 103,
 * the Bronx 104, Queens 110 to 114 and 116, Brooklyn 112. Cautious default (O-03): the rule pack
 * is New York's, so only a city address is taken here; anything else is a Console job.
 */
const NYC_ZIP3 = new Set([
  "100",
  "101",
  "102",
  "103",
  "104",
  "110",
  "111",
  "112",
  "113",
  "114",
  "116",
]);

/** Null when the address is in New York City; otherwise why it's refused. */
export function addressOutsideNewYork(address: VenueAddress): "outside_new_york" | null {
  if (address.state.toUpperCase() !== "NY") return "outside_new_york";
  return NYC_ZIP3.has(address.postal_code.slice(0, 3)) ? null : "outside_new_york";
}

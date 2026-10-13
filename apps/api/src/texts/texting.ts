import { latestSetting, type Queryable } from "@west4/db";
import { TEXTING_DEFAULTS, type TextingKind, type TextingSettings } from "@west4/shared";

/**
 * The venue's texting switches (D124; spec 11 · Texting switch): the venue-wide Texting switch and
 * the switches of the texts that have no template (staff codes, the order-waiting alert, the
 * singer's code, staff replies). A venue that never saved the key texts as before. STOP and HELP
 * replies never ask here: they're answered while a number is connected, whatever the switches say.
 */
export async function textingOf(c: Queryable, venueId: string): Promise<TextingSettings> {
  const saved = await latestSetting(c, venueId, "texting");
  return saved?.value ?? TEXTING_DEFAULTS;
}

/** Whether texting is on, and, with a kind, whether that text is on too. */
export async function textingAllows(
  c: Queryable,
  venueId: string,
  kind?: TextingKind,
): Promise<boolean> {
  const t = await textingOf(c, venueId);
  if (!t.on) return false;
  return kind === undefined ? true : t[kind];
}

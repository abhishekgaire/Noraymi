import { addCheckLine, emitEvent, readSetting, type Queryable } from "@west4/db";
import { Temporal } from "@west4/shared";
import { attachFile } from "../files/storage.js";
import { ApiError } from "../http/errors.js";

/**
 * The damage fee (M2-21; spec 10 · Damage fee): `prices.damageFeeCents`
 * ($150.00 at West 4) on a room check, only with a photo and a reason. The
 * photo is attached, so the 24-hour cleanup of unattached uploads keeps it.
 * The line's tax category is `damage`: taxed, and kept out of the gratuity
 * base when M4 works those out.
 */
export async function addDamageFee(
  c: Queryable,
  venueId: string,
  checkId: string,
  input: { fileId: string; reason: string; userId: string; now: Temporal.Instant },
): Promise<number> {
  const check = (
    await c.query<{ status: string; kind: string; business_date: string }>(
      "select status, kind, business_date::text from checks where venue_id = $1 and id = $2 for update",
      [venueId, checkId],
    )
  ).rows[0];
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.status !== "open") throw new ApiError("invalid_request", "the check isn't open");
  if (check.kind !== "room")
    throw new ApiError("invalid_request", "a damage fee goes on a room check");
  const file = (
    await c.query<{ kind: string }>(
      "select kind from files where venue_id = $1 and id = $2 and removed_at is null",
      [venueId, input.fileId],
    )
  ).rows[0];
  if (file?.kind !== "damage_photo")
    throw new ApiError("invalid_request", "a damage fee needs a damage photo");
  const prices = await readSetting(
    c,
    venueId,
    "prices",
    Temporal.PlainDate.from(check.business_date),
  );
  const fee = prices?.value.damageFeeCents ?? null;
  if (!fee)
    throw new ApiError("invalid_request", "the damage fee isn't set in Admin → Hours & prices");
  await attachFile(c, venueId, input.fileId, input.now);
  const id = await addCheckLine(c, venueId, checkId, {
    kind: "damage",
    description: "Damage fee",
    qty: 1,
    unitCents: fee,
    amountCents: fee,
    taxCategory: "damage",
    businessDate: check.business_date,
    reason: input.reason,
    addedBy: input.userId,
    addedAt: input.now.toString(),
    fileId: input.fileId,
  });
  await emitEvent(c, { venueId, type: "check.updated", entityId: checkId, entityVersion: 0 });
  return id;
}

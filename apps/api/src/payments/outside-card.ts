import {
  allocate,
  amountDue,
  checkIsTraining,
  emitEvent,
  insertPayment,
  moduleOn,
  type Queryable,
} from "@west4/db";
import { outsideCardNoteOk } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { roomOfCheck } from "../rooms/guest-bill.js";
import { settleCheck, type Settled } from "../rooms/present.js";
import { takeOverHold } from "../tabs/pay.js";
import { claimShare } from "./splits.js";

/**
 * Paid on an outside card machine (F-10; D126; spec 07 · Outside card machine): staff charged the
 * venue's own non-Stripe machine and record it here: the amount and the tip in cents, who recorded
 * it, and an optional note of a last 4 or an approval code (never a card number). It is captured
 * when recorded and closes the check like any tender: no hold, no on-reader tip, no drawer, no
 * Stripe and nothing for the reconciler. Refused while the switch is off.
 */
export interface OutsideCardTaken {
  readonly paymentId: string;
  readonly settled: Settled;
  readonly replaced: { readonly tabId: string; readonly holdId: string | null } | null;
}

export async function takeOutsideCard(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    amountCents: number;
    tipCents: number;
    note: string | null;
    shareId?: string | null;
    /** A bar tab's hold this replaces: left out of what's due. */
    leaveOut?: string | null;
    userId: string;
    businessDate: string;
    training?: boolean;
    now: Temporal.Instant;
  },
): Promise<OutsideCardTaken> {
  if (!(await moduleOn(c, venueId, "outside_card")))
    throw new ApiError("module_off", "the outside card machine is off at this venue", {
      details: { reason: "outside_card_off" },
    });
  const note = input.note?.trim() || null;
  if (!outsideCardNoteOk(note))
    throw new ApiError(
      "invalid_request",
      "the note takes a last 4 or an approval code, never a card number",
      { details: { reason: "card_number" } },
    );
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0)
    throw new ApiError("invalid_request", "the amount is a whole number of cents above zero");
  const claimed = input.shareId
    ? await claimShare(c, venueId, input.checkId, input.shareId, input.amountCents, "paid")
    : null;
  if (!claimed) {
    const due = await amountDue(c, input.checkId, input.leaveOut ?? null);
    if (input.amountCents > due)
      throw new ApiError("invalid_request", "that's more than what's owed", {
        details: { reason: "over", due_cents: due },
      });
  }
  const training = input.training || (await checkIsTraining(c, venueId, input.checkId));
  const paymentId = await insertPayment(c, venueId, {
    method: "outside_card",
    status: "captured",
    businessDate: input.businessDate,
    amountCents: input.amountCents,
    tipCents: input.tipCents,
    takenBy: input.userId,
    outsideNote: note,
    training,
  });
  await allocate(c, venueId, {
    paymentId,
    checkId: input.checkId,
    amountCents: input.amountCents,
    state: "captured",
    shareId: input.shareId ?? null,
    leaveOut: claimed?.leaveOut ?? input.leaveOut ?? null,
  });
  const replaced = await takeOverHold(c, venueId, input.checkId, input.now);
  const settled = await settleCheck(c, venueId, input.checkId, input.now);
  const roomId = await roomOfCheck(c, venueId, input.checkId);
  await emitEvent(c, { venueId, type: "payment.updated", entityId: paymentId, roomId });
  await emitEvent(c, { venueId, type: "check.updated", entityId: input.checkId, roomId });
  return { paymentId, settled, replaced };
}

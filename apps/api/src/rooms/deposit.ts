import {
  addCheckLine,
  allocate,
  depositsOn,
  insertCheck,
  releaseAllocation,
  type Queryable,
} from "@west4/db";
import { depositVsCheck } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { settleCheck } from "./present.js";

/**
 * The deposit against the final check (M4-09; Money rules 11; money case
 * deposit_larger_than_check_forfeit). Run by every finalize: the deposit
 * covers the check up to its total (tax and gratuity included, ambiguity A6),
 * and anything over becomes a `forfeit` line on a `fee` check with the next
 * check number, paid from the deposit. Allocations never change amount, so
 * a change releases the deposit's allocations and writes them again; the
 * fee check's forfeit lines add up to what's kept now (a later revision that
 * takes more of the deposit writes a negative forfeit line).
 */
export async function settleDeposit(
  c: Queryable,
  venueId: string,
  checkId: string,
  input: { totalCents: number; userId: string; now: Temporal.Instant },
): Promise<{ appliedCents: number; forfeitCents: number; feeCheckId: string | null }> {
  const onCheck = await depositsOn(c, venueId, checkId);
  const check = (
    await c.query<{
      booking_id: string | null;
      business_date: string;
      room_session_id: string | null;
    }>(
      "select booking_id, business_date::text, room_session_id from checks where venue_id = $1 and id = $2",
      [venueId, checkId],
    )
  ).rows[0]!;
  if (!check.booking_id) return { appliedCents: 0, forfeitCents: 0, feeCheckId: null };
  const fee = (
    await c.query<{ id: string }>(
      "select id from checks where venue_id = $1 and booking_id = $2 and kind = 'fee' and status <> 'void' order by opened_at limit 1",
      [venueId, check.booking_id],
    )
  ).rows[0];
  const onFee = fee ? await depositsOn(c, venueId, fee.id) : [];
  const deposit = [...onCheck, ...onFee].reduce((s, a) => s + a.amount_cents, 0);
  if (deposit === 0) return { appliedCents: 0, forfeitCents: 0, feeCheckId: fee?.id ?? null };
  const want = depositVsCheck({ depositCents: deposit, checkTotalCents: input.totalCents });
  const kept = onFee.reduce((s, a) => s + a.amount_cents, 0);
  if (kept === want.forfeitLineCents)
    return {
      appliedCents: want.depositAppliedCents,
      forfeitCents: kept,
      feeCheckId: fee?.id ?? null,
    };

  // Each deposit payment's money, in order: the room check first, up to its total, then the fee check.
  const payments = new Map<string, number>();
  for (const a of [...onCheck, ...onFee])
    payments.set(a.payment_id, (payments.get(a.payment_id) ?? 0) + a.amount_cents);
  for (const a of [...onCheck, ...onFee]) await releaseAllocation(c, venueId, a.allocation_id);

  let feeId = fee?.id ?? null;
  if (want.forfeitLineCents > 0 && !feeId) {
    // No Stripe call happens in this transaction, so the number is taken here: the next in sequence.
    const n = await c.query<{ number: string }>(
      "update venue_counters set next = next + 1 where venue_id = $1 and name = 'check' returning next - 1 as number",
      [venueId],
    );
    feeId = await insertCheck(c, {
      venueId,
      number: Number(n.rows[0]!.number),
      kind: "fee",
      businessDate: check.business_date,
      bookingId: check.booking_id,
      openedBy: input.userId,
      openedAt: input.now.toString(),
    });
  }
  if (feeId && want.forfeitLineCents !== kept)
    await addCheckLine(c, venueId, feeId, {
      kind: "forfeit",
      description: "Deposit kept",
      qty: 1,
      unitCents: want.forfeitLineCents - kept,
      amountCents: want.forfeitLineCents - kept,
      taxCategory: "fee",
      businessDate: check.business_date,
      addedBy: input.userId,
      addedAt: input.now.toString(),
    });
  let toRoom: number = want.depositAppliedCents;
  for (const [paymentId, amount] of payments) {
    const room = Math.min(amount, toRoom);
    toRoom -= room;
    if (room > 0)
      await allocate(c, venueId, {
        paymentId,
        checkId,
        amountCents: room,
        state: "captured",
        followsLines: true,
      });
    if (amount - room > 0 && feeId)
      await allocate(c, venueId, {
        paymentId,
        checkId: feeId,
        amountCents: amount - room,
        state: "captured",
        followsLines: true,
      });
  }
  if (feeId) await settleCheck(c, venueId, feeId, input.now);
  return {
    appliedCents: want.depositAppliedCents,
    forfeitCents: want.forfeitLineCents,
    feeCheckId: feeId,
  };
}

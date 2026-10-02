import {
  addToStaffBank,
  allocate,
  drawerOfDevice,
  emitEvent,
  insertDrawerMove,
  insertPayment,
  insertPrintJob,
  paymentById,
  staffBank,
  type Queryable,
} from "@west4/db";
import { changeDue } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { settleCheck, type Settled } from "../rooms/present.js";
import { claimShare } from "./splits.js";

/**
 * Cash (M4-13; Money rules 15; Payment flows · Cash). Taken at a screen
 * paired to a drawer, it goes into that drawer's open session, with a sale
 * move naming who took it and where, and the drawer opens through its
 * printer's kick port. Taken on a staff phone (or any screen without a
 * drawer), it goes into that person's staff bank for the business date and no
 * drawer opens. The payment is captured when inserted and never changes; a
 * corrected amount handed over is a payment event's detail.
 */
export interface CashTaken {
  readonly paymentId: string;
  readonly changeCents: number;
  readonly loggedTo: { readonly name: string; readonly drawer: string | null };
  readonly settled: Settled;
}

export async function takeCash(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    amountCents: number;
    tenderedCents: number;
    tipCents: number;
    shareId?: string | null;
    userId: string;
    deviceId: string | null;
    businessDate: string;
    training?: boolean;
    now: Temporal.Instant;
  },
): Promise<CashTaken> {
  const change = changeDue({
    owedCents: input.amountCents,
    tipCents: input.tipCents,
    tenderedCents: input.tenderedCents,
  });
  if (change === null)
    throw new ApiError("invalid_request", "that's less than what's owed", {
      details: { reason: "short" },
    });
  const at = input.now.toString();
  // A split's share (M4-14): cash pays it at once.
  if (input.shareId)
    await claimShare(c, venueId, input.checkId, input.shareId, input.amountCents, "paid");
  const drawer = input.deviceId ? await drawerOfDevice(c, venueId, input.deviceId) : null;
  const inDrawer = drawer?.session_id ? drawer : null;
  const bankId = inDrawer ? null : await staffBank(c, venueId, input.userId, input.businessDate);
  const paymentId = await insertPayment(c, venueId, {
    method: "cash",
    status: "captured",
    businessDate: input.businessDate,
    amountCents: input.amountCents,
    tipCents: input.tipCents,
    tenderedCents: input.tenderedCents,
    changeCents: change,
    drawerSessionId: inDrawer?.session_id ?? null,
    staffBankId: bankId,
    training: input.training ?? false,
  });
  await allocate(c, venueId, {
    paymentId,
    checkId: input.checkId,
    amountCents: input.amountCents,
    state: "captured",
    shareId: input.shareId ?? null,
  });
  // The cash that stays: the amount and the tip (the change went back to the guest).
  await insertDrawerMove(c, venueId, {
    drawerSessionId: inDrawer?.session_id ?? null,
    staffBankId: bankId,
    kind: "sale",
    amountCents: input.amountCents + input.tipCents,
    paymentId,
    takenBy: input.userId,
    deviceId: input.deviceId,
    at,
  });
  if (inDrawer && !input.training && inDrawer.printer_device_id)
    // The kick through the receipt printer's port: a network printer's job carries it; a USB printer's
    // goes through the desktop app's print host.
    await insertPrintJob(c, venueId, {
      kind: "drawer",
      station: inDrawer.station ?? "bar",
      deviceId: inDrawer.printer_device_id,
      payload: { reason: "cash", payment_id: paymentId, drawer_id: inDrawer.id },
      createdAt: at,
    });
  if (bankId) await addToStaffBank(c, venueId, bankId, input.amountCents + input.tipCents);
  const settled = await settleCheck(c, venueId, input.checkId, input.now);
  await emitEvent(c, { venueId, type: "payment.updated", entityId: paymentId });
  const name =
    (
      await c.query<{ name: string }>(
        "select split_part(name, ' ', 1) as name from users where id = $1",
        [input.userId],
      )
    ).rows[0]?.name ?? "";
  return {
    paymentId,
    changeCents: change,
    loggedTo: { name, drawer: inDrawer?.name ?? null },
    settled,
  };
}

/** "Wrong amount? Fix the change": the payment stays as it is; the corrected figures are an event's detail. */
export async function fixChange(
  c: Queryable,
  venueId: string,
  input: { paymentId: string; tenderedCents: number; userId: string; at: string },
): Promise<{ changeCents: number }> {
  const p = await paymentById(c, venueId, input.paymentId, true);
  if (!p || p.method !== "cash") throw new ApiError("not_found", "no such cash payment");
  const change = changeDue({
    owedCents: p.amount_cents,
    tipCents: p.tip_cents,
    tenderedCents: input.tenderedCents,
  });
  if (change === null)
    throw new ApiError("invalid_request", "that's less than what's owed", {
      details: { reason: "short" },
    });
  await c.query(
    `insert into payment_events (venue_id, payment_id, from_status, to_status, source, detail, at)
     values ($1, $2, $3, $3, 'api', $4, $5)`,
    [
      venueId,
      input.paymentId,
      p.status,
      JSON.stringify({
        fixed: "change",
        tendered_cents: input.tenderedCents,
        change_cents: change,
        by: input.userId,
      }),
      input.at,
    ],
  );
  return { changeCents: change };
}

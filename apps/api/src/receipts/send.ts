import { createHmac } from "node:crypto";
import {
  insertPrintJob,
  insertReceipt,
  payTokenHash,
  receiptByHash,
  venueForReceiptToken,
  webReceiptOf,
  withVenue,
  type Queryable,
} from "@west4/db";
import { Temporal, cents, formatMoney } from "@west4/shared";
import type pg from "pg";
import { ApiError } from "../http/errors.js";
import { enqueueEmail } from "../jobs/send-email.js";
import type { EmailSettings } from "../email/settings.js";
import { queueText } from "../texts/queue.js";
import type { VenueTextSettings } from "../texts/venue.js";
import { receiptModel, receiptText, type ReceiptModel } from "./model.js";

/**
 * Sending receipts (M4-19; Data model · receipts; Security 9): each print,
 * text, email or web link is a `receipts` row with a link token. The token is
 * 128 bits or more, stored hashed, and derived from the row's id with the
 * server's secret, so the same link can be shown again without keeping the
 * token. It expires after 30 days (the ticket's cautious default, as long as
 * Twilio keeps the text).
 */
export const RECEIPT_DAYS = 30;

export interface ReceiptDeps {
  /** The server's secret (AUTH_SECRET_KEY): the link tokens are derived from it. */
  readonly secret: Buffer;
  /** Where the public receipt page is served (the guest site). */
  readonly guestAppUrl: string | null;
  readonly texts: Pick<VenueTextSettings, "allowList">;
  readonly email: Pick<EmailSettings, "allowList">;
}

export function receiptToken(secret: Buffer, receiptId: string): string {
  return createHmac("sha256", secret)
    .update(`receipt:${receiptId}`)
    .digest("base64url")
    .slice(0, 24);
}

const linkOf = (deps: ReceiptDeps, token: string) =>
  deps.guestAppUrl ? `${deps.guestAppUrl}/receipt/${token}` : null;

async function newReceipt(
  c: Queryable,
  venueId: string,
  deps: ReceiptDeps,
  input: {
    checkId: string;
    channel: "print" | "text" | "email" | "web";
    paymentId?: string | null;
    sentBy: string | null;
    now: Temporal.Instant;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const token = receiptToken(deps.secret, id);
  await insertReceipt(c, venueId, {
    id,
    checkId: input.checkId,
    paymentId: input.paymentId ?? null,
    tokenHash: payTokenHash(token),
    channel: input.channel,
    sentAt: input.now.toString(),
    expiresAt: input.now.add({ hours: 24 * RECEIPT_DAYS }).toString(),
    sentBy: input.sentBy,
  });
  return token;
}

/** The check's web receipt link, made once when first asked for: what a paid bill shows. */
export async function webReceiptLink(
  c: Queryable,
  venueId: string,
  checkId: string,
  deps: ReceiptDeps,
  now: Temporal.Instant,
): Promise<string | null> {
  const existing = await webReceiptOf(c, venueId, checkId);
  if (existing) return linkOf(deps, receiptToken(deps.secret, existing.id));
  await newReceipt(c, venueId, deps, { checkId, channel: "web", sentBy: null, now });
  const made = await webReceiptOf(c, venueId, checkId);
  return made ? linkOf(deps, receiptToken(deps.secret, made.id)) : null;
}

export type ReceiptChannel =
  | { readonly channel: "print"; readonly station: string }
  | { readonly channel: "text"; readonly to: string }
  | { readonly channel: "email"; readonly to: string };

/** Text, Email or Print: the same receipt, its row and link, and the print job, text or email. */
export async function sendReceipt(
  c: Queryable,
  venueId: string,
  deps: ReceiptDeps,
  input: {
    checkId: string;
    to: ReceiptChannel;
    paymentId?: string | null;
    sentBy: string | null;
    now: Temporal.Instant;
  },
): Promise<{ model: ReceiptModel; link: string | null }> {
  const model = await receiptModel(c, venueId, input.checkId);
  if (!model) throw new ApiError("not_found", "no such check");
  // A practice receipt prints TRAINING and is never texted or emailed (M7-03).
  if (model.training && input.to.channel !== "print")
    throw new ApiError("forbidden", "a practice receipt is never texted or emailed", {
      details: { reason: "training" },
    });
  const token = await newReceipt(c, venueId, deps, {
    checkId: input.checkId,
    channel: input.to.channel,
    paymentId: input.paymentId ?? null,
    sentBy: input.sentBy,
    now: input.now,
  });
  const link = linkOf(deps, token);
  const lines = receiptText(model);
  if (input.to.channel === "print") {
    await insertPrintJob(c, venueId, {
      checkId: input.checkId,
      kind: "receipt",
      station: input.to.station,
      payload: { lines },
      createdAt: input.now.toString(),
    });
  } else if (input.to.channel === "text") {
    if (!link) throw new ApiError("invalid_request", "the receipt page has no address here yet");
    await queueText(
      c,
      venueId,
      {
        templateKey: "receipt",
        to: input.to.to,
        params: { amount: formatMoney("en", cents(model.total_cents)), link },
        guestId: null,
        context: null,
        sentBy: input.sentBy,
        now: input.now,
        training: model.training,
      },
      deps.texts,
    );
  } else {
    if (!link) throw new ApiError("invalid_request", "the receipt page has no address here yet");
    await enqueueEmail(c, deps.email, {
      venueId,
      to: input.to.to,
      locale: "en",
      template: "receipt",
      data: { venueName: model.venue, number: model.number, lines, link, training: model.training },
      runAt: input.now,
    });
  }
  return { model, link };
}

/** The public receipt page's answer: the receipt, or not found for a wrong or expired token. */
export async function publicReceipt(
  pool: pg.Pool,
  token: string,
  now: Temporal.Instant,
): Promise<ReceiptModel> {
  const notFound = () => new ApiError("not_found", "this receipt link isn't valid");
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw notFound();
  const hash = payTokenHash(token);
  const venueId = await venueForReceiptToken(pool, hash);
  if (!venueId) throw notFound();
  return withVenue(pool, { venueId, requestId: "receipt-link" }, async (c) => {
    const row = await receiptByHash(c, venueId, hash);
    if (!row || Temporal.Instant.compare(Temporal.Instant.from(row.expires_at), now) <= 0)
      throw notFound();
    const model = await receiptModel(c, venueId, row.check_id);
    if (!model) throw notFound();
    return model;
  });
}

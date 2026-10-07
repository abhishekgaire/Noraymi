import type { Clock } from "@west4/shared";
import type pg from "pg";
import type { JobHandler, Schedule, Sweep } from "@west4/db";
import type { S3Settings } from "../s3.js";
import type { Mailer } from "../email/mailer.js";
import type { EmailSettings } from "../email/settings.js";
import { EMAIL_SEND_KIND, makeSendEmailHandler } from "./send-email.js";
import { deviceWatchSweep } from "./device-watch.js";
import { readerHealthSweep } from "./reader-health.js";
import { routerWatchSweep } from "./router-watch.js";
import { drawerSweep } from "../routes/drawers.js";
import { STRIPE_EVENT_KIND, makeStripeEventHandler } from "../stripe/webhooks.js";
import { makePaymentHandlers } from "../payments/run.js";
import { RECONCILE_KIND, makeReconcileHandler, reconcileSweep } from "../payments/reconcile.js";
import "../payments/webhooks.js";
import "../payments/payouts.js";
import type { StripeClient } from "../stripe/client.js";
import { holdSweep } from "./hold-sweep.js";
import { wrapUpSweep } from "./wrap-up-sweep.js";
import { TEXT_TRIGGER_KIND, makeTextTriggerHandler, textTriggerSweep } from "../texts/triggers.js";
import { waitlistOfferSweep } from "../rooms/waitlist.js";
import { sweepUnattachedFiles } from "../files/storage.js";
import { makeS3 } from "../s3.js";
import { PUSH_SEND_KIND, makePushSendHandler } from "../push/send-push.js";
import type { PushSender } from "../push/sender.js";
import { SINGER_PUSH_KIND, makeSingerPushHandler } from "../songs/alerts.js";
import { TEXT_SEND_KIND, makeSendTextHandler } from "./send-text.js";
import type { TextSender } from "../texts/sender.js";
import type { VenueTextClient, VenueTextSettings } from "../texts/venue.js";
import { MESSAGE_SEND_KIND } from "../texts/queue.js";
import { makeSendMessageHandler } from "./send-message.js";
import { AUDIT_EXPORT_KIND, auditExportSchedule, makeAuditExportHandler } from "./audit-export.js";
import { MENU_PDF_KIND, makeMenuPdfHandler } from "./menu-pdf.js";
import { printWatchSweep } from "../routes/print.js";
import { escalationSweep } from "../orders/escalation.js";
import { alcoholStopSweep } from "../orders/four-am.js";
import { clearOutSweep } from "../rooms/clear-out.js";
import { holdWatchSweep } from "../tabs/expiry.js";
import { tabCutOffSweep } from "../tabs/walkout.js";
import { vendorHealthSweep } from "./vendor-health.js";
import {
  LICENSE_REMINDER_KIND,
  licenseReminderSchedule,
  makeLicenseReminderHandler,
} from "../licenses/licenses.js";
import { RETENTION_KIND, makeRetentionHandler, retentionSchedule } from "./retention.js";
import { ERASE_KIND, makeEraseHandler } from "./erase.js";
import {
  EVENTS_CLEANUP_KIND,
  eventsCleanupHandler,
  eventsCleanupSchedule,
} from "./events-cleanup.js";
import {
  IDEMPOTENCY_CLEANUP_KIND,
  idempotencyCleanupHandler,
  idempotencyCleanupSchedule,
} from "./idempotency-cleanup.js";

/**
 * Every job kind the workers know, by pool, and every daily schedule.
 * Captures and readers are critical, texts are normal, exports and
 * retention are bulk. Later tickets add to these.
 */
export interface HandlerDeps {
  /** Stripe's events (M4-03): the pool their jobs read and write with, and the client to read objects again. */
  readonly stripe?: {
    readonly pool: pg.Pool;
    readonly client: StripeClient;
    readonly clock: Clock;
    /** For the pay link texted after a declined card on file (M4-17). */
    readonly payAppUrl?: string | null;
    readonly texts?: Pick<VenueTextSettings, "allowList">;
  };
  readonly s3: S3Settings;
  readonly mailer: Mailer;
  readonly email: EmailSettings;
  readonly push: PushSender;
  readonly texts: TextSender;
  /** Guest texts from each venue's subaccount (M2-09). */
  readonly venueTexts?: {
    readonly client: VenueTextClient;
    readonly settings: Pick<VenueTextSettings, "publicApiUrl" | "allowList">;
    readonly secretKey: Buffer;
  };
}

export function makeHandlers({
  s3,
  mailer,
  email,
  push,
  texts,
  venueTexts,
  stripe,
}: HandlerDeps): Record<"critical" | "normal" | "bulk", Record<string, JobHandler>> {
  const stripeEvents = stripe
    ? { [STRIPE_EVENT_KIND]: makeStripeEventHandler(stripe.pool, stripe.client) }
    : {};
  return {
    // Card payments (M4-05): the run and the polling while a result is unknown.
    critical: {
      ...stripeEvents,
      ...(stripe
        ? makePaymentHandlers({
            pool: stripe.pool,
            stripe: stripe.client,
            clock: stripe.clock,
            payAppUrl: stripe.payAppUrl ?? null,
            texts: stripe.texts ?? { allowList: null },
          })
        : {}),
      // The reconciler (M4-12): unknown results and PaymentIntents with no row, every 5 minutes.
      ...(stripe
        ? {
            [RECONCILE_KIND]: makeReconcileHandler({
              pool: stripe.pool,
              stripe: stripe.client,
              clock: stripe.clock,
            }),
          }
        : {}),
    },
    normal: {
      ...stripeEvents,
      [EMAIL_SEND_KIND]: makeSendEmailHandler(mailer, email),
      [PUSH_SEND_KIND]: makePushSendHandler(push),
      [SINGER_PUSH_KIND]: makeSingerPushHandler(push),
      [TEXT_SEND_KIND]: makeSendTextHandler(texts),
      ...(venueTexts
        ? {
            [MESSAGE_SEND_KIND]: makeSendMessageHandler(
              venueTexts.client,
              venueTexts.settings,
              venueTexts.secretKey,
            ),
            [TEXT_TRIGGER_KIND]: makeTextTriggerHandler(venueTexts.settings),
          }
        : {}),
      // Erasing a guest or a singer on request (M8-13): cards at Stripe, bodies at Twilio.
      [ERASE_KIND]: makeEraseHandler({
        ...(stripe ? { stripe: stripe.client } : {}),
        ...(venueTexts
          ? { texts: { client: venueTexts.client, secretKey: venueTexts.secretKey } }
          : {}),
      }),
    },
    bulk: {
      [AUDIT_EXPORT_KIND]: makeAuditExportHandler(s3.client, s3.bucketAudit),
      [MENU_PDF_KIND]: makeMenuPdfHandler(s3.client, s3.bucketFiles),
      [IDEMPOTENCY_CLEANUP_KIND]: idempotencyCleanupHandler,
      [EVENTS_CLEANUP_KIND]: eventsCleanupHandler,
      // License renewal reminders (M8-09), every morning on each venue's clock.
      [LICENSE_REMINDER_KIND]: makeLicenseReminderHandler(email),
      // The nightly retention job (M8-12), per venue, under its own role.
      [RETENTION_KIND]: makeRetentionHandler({
        ...(stripe ? { stripe: stripe.client } : {}),
        ...(venueTexts
          ? { texts: { client: venueTexts.client, secretKey: venueTexts.secretKey } }
          : {}),
      }),
    },
  };
}

export const schedules: Schedule[] = [
  auditExportSchedule,
  idempotencyCleanupSchedule,
  eventsCleanupSchedule,
  licenseReminderSchedule,
  retentionSchedule,
];

/** What the scheduler's leader checks between ticks (M1-16: quiet devices). */
export function makeSweeps(
  pool: pg.Pool,
  log?: (line: string) => void,
  texts: Pick<VenueTextSettings, "allowList"> = { allowList: null },
  stripe?: StripeClient,
): Sweep[] {
  const s3 = makeS3();
  return [
    deviceWatchSweep(pool, log),
    // Stripe and Twilio health for the staff banners (M8-01).
    vendorHealthSweep(pool, log),
    // The router, on the line or on LTE, and its monthly failover test (M8-02).
    routerWatchSweep(pool, log),
    // Each drawer's session opens as the business date starts (M4-13).
    drawerSweep(pool),
    // Card readers' status from Stripe every 30 seconds (M4-02).
    ...(stripe ? [readerHealthSweep(pool, stripe, log), reconcileSweep(pool)] : []),
    // Tickets not confirmed within three polls (M3-13).
    printWatchSweep(pool),
    // Room orders nobody has accepted: phones, the board, the manager (M3-16).
    escalationSweep(pool),
    // The 4 AM stop: alcohol nobody accepted is cancelled once the window closes (M3-22).
    alcoholStopSweep(pool),
    // The clear-out check at the close plus drinking-up time (M3-23).
    clearOutSweep(pool),
    // The tab cut-off (M6-16): every tab still open is charged as a walkout at 4:30 AM, once a night.
    tabCutOffSweep(pool),
    // The hold watch (M6-17): untouched paper slips captured at a $0 tip, and holds about to run out.
    holdWatchSweep(pool),
    holdSweep(pool),
    wrapUpSweep(pool),
    // The automatic texts on their triggers (M2-24).
    textTriggerSweep(pool),
    // Waitlist offers not taken in 10 minutes (M2-26).
    waitlistOfferSweep(pool, texts),
    // Uploads nothing attached within 24 hours (M2-13).
    {
      name: "unattached-files",
      everyMs: 10 * 60_000,
      run: async (now) => void (await sweepUnattachedFiles(pool, s3, now)),
    },
  ];
}

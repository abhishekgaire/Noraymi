import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { decryptSecret, encryptSecret, type Queryable } from "@west4/db";
import {
  businessDate,
  offlineSecretFingerprint,
  printedOfflineCodes,
  upcomingOfflineCodes,
  type Hmac,
} from "@west4/rules";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Offline codes (M8-04; spec 09 · Offline and queue mode). A desktop
 * computer sets up its secret while online and keeps it in its keychain; the
 * server keeps a copy sealed with the API's secret key. Managers' phones
 * fetch each computer's upcoming time-based codes while online and keep
 * them, so a code can be read out when our cloud is down; the printed
 * one-time codes go on a sealed card. The codes are checked on the computer
 * itself, never here.
 */
const DESKTOPS = ["bar_computer", "front_desk"] as const;

let sealKey: Buffer | null = null;

/** Set once when the app is built, from AUTH_SECRET_KEY (as the room codes are). */
export function setOfflineCodeKey(key: Buffer): void {
  sealKey = key;
}

export const hmac: Hmac = (secret, message) =>
  createHmac("sha256", Buffer.from(secret, "hex")).update(message).digest();

const VenueParams = z.object({ venueId: z.string() });
type VenueParams = z.infer<typeof VenueParams>;

async function secrets(c: Queryable, venueId: string) {
  const r = await c.query<{ device_id: string; name: string; kind: string; secret_enc: string }>(
    `select s.device_id, d.name, d.kind, s.secret_enc
       from device_offline_secrets s join devices d on d.venue_id = s.venue_id and d.id = s.device_id
      where s.venue_id = $1 and d.revoked_at is null and d.disabled_at is null
      order by d.kind, d.name, d.id`,
    [venueId],
  );
  const out: { device_id: string; name: string; kind: string; secret: string }[] = [];
  for (const row of r.rows) {
    try {
      if (sealKey) out.push({ ...row, secret: decryptSecret(sealKey, row.secret_enc) });
    } catch {
      // Sealed under an older key: the computer sets up a new secret next time it's online.
    }
  }
  return out;
}

export function offlineCodeRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const setupBody = z
    .object({
      fingerprint: z
        .string()
        .regex(/^[0-9a-f]{32}$/)
        .nullable(),
    })
    .strict();

  /**
   * The computer's secret, set up while online. It says which secret it
   * holds (a fingerprint, or null); when that's the one kept here nothing
   * changes, otherwise a new secret is made and handed back once.
   */
  app.post<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/devices/offline-secret",
    { config: route({ principals: ["shared_device"], module: "core", idempotency: "none" }) },
    async (request) => {
      const device = request.signedDevice;
      if (!device || device.venueId !== request.venueId)
        throw new ApiError("forbidden", "a computer sets up its own offline codes");
      if (!(DESKTOPS as readonly string[]).includes(device.kind))
        throw new ApiError("forbidden", "only the bar and front-desk computers queue offline");
      const parsed = setupBody.safeParse(request.body ?? {});
      if (!parsed.success) throw new ApiError("invalid_request", "send { fingerprint }");
      if (!sealKey) throw new ApiError("internal", "offline codes need the API's secret key");
      const key = sealKey;
      return request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const kept = await c.query<{ secret_enc: string }>(
          "select secret_enc from device_offline_secrets where venue_id = $1 and device_id = $2",
          [venueId, device.deviceId],
        );
        if (kept.rows[0] && parsed.data.fingerprint) {
          let held: string | null = null;
          try {
            held = decryptSecret(key, kept.rows[0].secret_enc);
          } catch {
            // Sealed under an older key: make a new one.
          }
          if (held && offlineSecretFingerprint(hmac, held) === parsed.data.fingerprint)
            return { device_id: device.deviceId, secret: null };
        }
        const secret = randomBytes(32).toString("hex");
        await c.query(
          `insert into device_offline_secrets (device_id, venue_id, secret_enc) values ($1, $2, $3)
           on conflict (device_id) do update set secret_enc = excluded.secret_enc, created_at = now()`,
          [device.deviceId, venueId, encryptSecret(key, secret)],
        );
        return { device_id: device.deviceId, secret };
      });
    },
  );

  /** Each computer's upcoming codes, for a manager's phone to keep (12 hours ahead). */
  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/offline-codes",
    { config: route({ principals: ["owner_manager"], module: "core" }) },
    (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const v = await venueClock(c, venueId);
        const now = options.clock.now();
        const devices = (await secrets(c, venueId)).map((d) => ({
          device_id: d.device_id,
          name: d.name,
          kind: d.kind,
          codes: upcomingOfflineCodes(
            hmac,
            d.secret,
            { deviceId: d.device_id, timeZone: v.timeZone, dayCutover: v.dayCutover },
            now,
          ),
        }));
        return { devices, server_time: now.toString() };
      }),
  );

  const printedQuery = z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  });
  /** The one-time codes to print for one computer and one business date (tonight unless named). */
  app.get<{ Params: VenueParams & { d: string }; Querystring: unknown }>(
    "/v1/venues/:venueId/devices/:d/offline-codes/printed",
    { config: route({ principals: ["owner_manager"], module: "core" }) },
    (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const q = printedQuery.safeParse(request.query ?? {});
        if (!q.success) throw new ApiError("invalid_request", "date is YYYY-MM-DD");
        const found = (await secrets(c, venueId)).find((d) => d.device_id === request.params.d);
        if (!found) throw new ApiError("not_found", "no offline codes for that computer yet");
        const v = await venueClock(c, venueId);
        const date =
          q.data.date ??
          businessDate(options.clock.now(), v.timeZone, v.dayCutover).businessDate.toString();
        return {
          device_id: found.device_id,
          name: found.name,
          business_date: date,
          codes: printedOfflineCodes(hmac, found.secret, found.device_id, date),
        };
      }),
  );
}

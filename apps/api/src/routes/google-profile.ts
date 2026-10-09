import type { FastifyInstance, FastifyRequest } from "fastify";
import { decryptSecret, encryptSecret } from "@west4/db";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { GoogleError, type GoogleClient, type GoogleLocation } from "../google/client.js";
import {
  checkState,
  connectLocation,
  disconnectGoogle,
  googleRow,
  queueGooglePush,
  saveGoogleConsent,
  signState,
} from "../google/profile.js";

/**
 * Admin → Connections → Google Business Profile (M5-15; spec 03 · `hours`):
 *   GET  /v1/venues/{v}/connections/google              status, the location, the last push
 *   POST /v1/venues/{v}/connections/google/connect      Google's consent link (OAuth)
 *   POST /v1/venues/{v}/connections/google/callback     { code, state } from Google's redirect
 *   PUT  /v1/venues/{v}/connections/google/location     { name }: which location gets the hours
 *   POST /v1/venues/{v}/connections/google/push         push the hours again now
 *   POST /v1/venues/{v}/connections/google/disconnect   stop pushing and drop the token
 * Google's redirect comes back to Admin → Connections, which posts the code
 * here in the person's own session. Every Google call happens outside a
 * database transaction.
 */
const STATE_MINUTES = 15;

const callbackBody = z
  .object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(2048) })
  .strict();
const locationBody = z.object({ name: z.string().regex(/^locations\/[\w-]+$/) }).strict();

function googleFailure(e: unknown): never {
  if (e instanceof GoogleError) throw new ApiError("google_error", e.message);
  throw e;
}

export function googleProfileRoutes(
  app: FastifyInstance,
  options: { clock: Clock; google: GoogleClient; secretKey: Buffer; staffAppUrl: string | null },
): void {
  const admin = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
  });
  const redirectUri = () => {
    if (!options.staffAppUrl) throw new ApiError("invalid_request", "STAFF_APP_URL isn't set");
    return `${options.staffAppUrl.replace(/\/$/, "")}/admin/connections`;
  };
  const userId = (request: FastifyRequest) =>
    request.principal.kind === "user" ? request.principal.userId : "";
  const available = () => options.google.enabled;
  const needGoogle = () => {
    if (!available()) throw new ApiError("invalid_request", "Google isn't set up on this server");
  };
  const locationsFor = async (refreshEnc: string): Promise<GoogleLocation[]> => {
    try {
      const token = await options.google.accessToken(decryptSecret(options.secretKey, refreshEnc));
      return await options.google.listLocations(token);
    } catch (e) {
      return googleFailure(e);
    }
  };
  const describe = async (request: FastifyRequest) => {
    const row = await request.inVenue((c) => googleRow(c, request.venueId!));
    return {
      available: available(),
      status: row?.status ?? "not_connected",
      location:
        row?.status === "connected" && row.external_id
          ? { name: row.external_id, title: row.config.location_title ?? row.external_id }
          : null,
      connected_at: row?.connected_at ?? null,
      last_push: row?.status === "connected" ? (row.config.last_push ?? null) : null,
    };
  };

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/connections/google",
    { config: admin },
    async (request) => describe(request),
  );

  app.post<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/connections/google/connect",
    { config: admin },
    async (request) => {
      needGoogle();
      const expires = options.clock.now().add({ minutes: STATE_MINUTES });
      const state = signState(options.secretKey, request.venueId!, userId(request), expires);
      return { url: options.google.authorizeUrl(state, redirectUri()) };
    },
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/connections/google/callback",
    { config: admin },
    async (request) => {
      needGoogle();
      const parsed = callbackBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "code and state are needed");
      const { code, state } = parsed.data;
      if (
        !checkState(
          options.secretKey,
          state,
          request.venueId!,
          userId(request),
          options.clock.now(),
        )
      )
        throw new ApiError(
          "invalid_request",
          "this Google link is old or isn't this venue's; connect again",
        );
      let refresh: string;
      let locations: GoogleLocation[];
      try {
        refresh = await options.google.exchangeCode(code, redirectUri());
        locations = await options.google.listLocations(await options.google.accessToken(refresh));
      } catch (e) {
        return googleFailure(e);
      }
      const refreshEnc = encryptSecret(options.secretKey, refresh);
      const now = options.clock.now();
      await request.inVenue(async (c) => {
        await saveGoogleConsent(c, request.venueId!, refreshEnc);
        // One location: it's the venue's. Several: Admin picks one.
        if (locations.length === 1) {
          await connectLocation(c, request.venueId!, locations[0]!, now);
          await queueGooglePush(c, request.venueId!, now);
        }
      });
      return { ...(await describe(request)), locations: locations.length === 1 ? [] : locations };
    },
  );

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/connections/google/locations",
    { config: admin },
    async (request) => {
      needGoogle();
      const row = await request.inVenue((c) => googleRow(c, request.venueId!));
      if (!row?.config.refresh_enc || row.status === "disconnected")
        throw new ApiError("not_found", "Google isn't connected");
      return { locations: await locationsFor(row.config.refresh_enc) };
    },
  );

  app.put<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/connections/google/location",
    { config: admin },
    async (request) => {
      needGoogle();
      const parsed = locationBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "name: a Google location");
      const row = await request.inVenue((c) => googleRow(c, request.venueId!));
      if (!row?.config.refresh_enc || row.status === "disconnected")
        throw new ApiError("not_found", "Google isn't connected");
      const location = (await locationsFor(row.config.refresh_enc)).find(
        (l) => l.name === parsed.data.name,
      );
      if (!location)
        throw new ApiError("invalid_request", "that location isn't on this Google account");
      const now = options.clock.now();
      await request.inVenue(async (c) => {
        await connectLocation(c, request.venueId!, location, now);
        await queueGooglePush(c, request.venueId!, now);
      });
      return describe(request);
    },
  );

  app.post<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/connections/google/push",
    { config: admin },
    async (request) => {
      const queued = await request.inVenue((c) =>
        queueGooglePush(c, request.venueId!, options.clock.now()),
      );
      if (!queued) throw new ApiError("not_found", "Google isn't connected");
      return describe(request);
    },
  );

  app.post<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/connections/google/disconnect",
    { config: admin },
    async (request) => {
      await request.inVenue((c) => disconnectGoogle(c, request.venueId!));
      return describe(request);
    },
  );
}

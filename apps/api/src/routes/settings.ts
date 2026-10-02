import type { FastifyInstance, FastifyRequest } from "fastify";
import type { StripeClient } from "../stripe/client.js";
import { pushTipScreen } from "../stripe/terminal-setup.js";
import { readSetting, rulePackFor, saveSettings, settingHistory, SettingsRefused } from "@west4/db";
import { businessDate } from "@west4/rules";
import { isSettingsKey, Temporal, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

interface VenueParams {
  venueId: string;
}

/**
 * Settings routes (spec 08 · Settings and modules; M1-11):
 *   GET  /v1/venues/{v}/settings/{key}   the version in force for a business date (?business_date=), or ?history=1
 *   PUT  /v1/venues/{v}/settings/{key}   a new version of one key
 *   PUT  /v1/venues/{v}/settings         Save and publish: several keys, all or nothing
 */
export function settingsRoutes(
  app: FastifyInstance,
  options: { clock: Clock; stripe?: () => StripeClient },
): void {
  const staff = route({ principals: ["owner_manager"], module: "core", action: "admin.access" });
  const admin = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    idempotency: "optional",
  });

  const venueClock = async (request: FastifyRequest) =>
    request.inVenue(async (c) => {
      const r = await c.query<{
        time_zone: string;
        day_cutover: string;
        rule_pack_id: string | null;
      }>(
        "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover, rule_pack_id from venues where id = $1",
        [request.venueId],
      );
      if (!r.rows[0]) throw new ApiError("not_found", "no such venue");
      return r.rows[0];
    });

  app.get<{
    Params: VenueParams & { key: string };
    Querystring: { business_date?: string; history?: string };
  }>("/v1/venues/:venueId/settings/:key", { config: staff }, async (request) => {
    const key = request.params.key;
    if (!isSettingsKey(key)) throw new ApiError("not_found", `no settings key "${key}"`);
    const venue = await venueClock(request);
    const date =
      request.query.business_date !== undefined
        ? Temporal.PlainDate.from(request.query.business_date)
        : businessDate(options.clock.now(), venue.time_zone, venue.day_cutover).businessDate;
    if (request.query.history === "1") {
      const versions = await request.inVenue((c) => settingHistory(c, request.venueId!, key));
      return { key, versions };
    }
    const version = await request.inVenue((c) => readSetting(c, request.venueId!, key, date));
    if (!version) throw new ApiError("not_found", `"${key}" isn't set yet for this venue`);
    return { business_date: date.toString(), ...version };
  });

  const save = async (request: FastifyRequest, values: Record<string, unknown>) => {
    const venue = await venueClock(request);
    const today = businessDate(
      options.clock.now(),
      venue.time_zone,
      venue.day_cutover,
    ).businessDate;
    const packId = venue.rule_pack_id ?? "us-ny-new-york-county";
    const pack = await request.inVenue((c) => rulePackFor(c, packId, today));
    if (!pack)
      throw new ApiError("internal", `no usable rule pack ${packId} for ${today.toString()}`);
    try {
      const saved = await request.inVenue((c) =>
        saveSettings(c, {
          venueId: request.venueId!,
          values,
          savedBy: request.principal.kind === "user" ? request.principal.userId : undefined,
          today,
          check: { pack: pack.pack, cutover: venue.day_cutover },
        }),
      );
      // A new pay.tipScreen goes to the readers' Terminal Configuration (M4-02), after the commit.
      let readers: "updating" | "failed" | undefined;
      if ("pay" in values && options.stripe) {
        readers = await pushTipScreen(
          request.inVenue,
          options.stripe(),
          request.venueId!,
          today,
          `venue:${request.venueId}:tip-screen:${request.requestId}`,
        )
          .then((pushed) => (pushed ? ("updating" as const) : undefined))
          .catch(() => "failed" as const);
      }
      return { business_date: today.toString(), saved, ...(readers ? { readers } : {}) };
    } catch (error) {
      if (error instanceof SettingsRefused)
        throw new ApiError("invalid_request", error.reasons.join(" "), {
          details: { reasons: error.reasons },
        });
      throw error;
    }
  };

  app.put<{ Params: VenueParams & { key: string }; Body: { value: unknown } }>(
    "/v1/venues/:venueId/settings/:key",
    { config: admin },
    async (request) => {
      if (!isSettingsKey(request.params.key))
        throw new ApiError("not_found", `no settings key "${request.params.key}"`);
      if (request.body === null || typeof request.body !== "object" || !("value" in request.body))
        throw new ApiError("invalid_request", "send { value }");
      return save(request, { [request.params.key]: request.body.value });
    },
  );

  app.put<{ Params: VenueParams; Body: { values: Record<string, unknown> } }>(
    "/v1/venues/:venueId/settings",
    { config: admin },
    async (request) => {
      const values = request.body?.values;
      if (values === null || typeof values !== "object")
        throw new ApiError("invalid_request", "send { values: { key: value, ... } }");
      return save(request, values);
    },
  );
}

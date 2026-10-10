import type { FastifyInstance, FastifyRequest } from "fastify";
import type { StripeClient } from "../stripe/client.js";
import { pushTipScreen } from "../stripe/terminal-setup.js";
import { tabConsent } from "../tabs/open.js";
import {
  publishPolicy,
  readSetting,
  rulePackFor,
  saveSettings,
  settingHistory,
  SettingsRefused,
} from "@west4/db";
import { businessDate, checkSetting, depositPolicyText, wallClock } from "@west4/rules";
import { queueGooglePush } from "../google/profile.js";
import {
  isSettingsKey,
  settingsDefaults,
  settingsSchemas,
  Temporal,
  type Clock,
} from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { menusFollowKitchen } from "../kitchen/module.js";

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
    // A key with a spec default (kitchen) reads as version 0 until the venue saves its own.
    const fallback = settingsDefaults[key];
    if (!version && fallback !== undefined)
      return { business_date: date.toString(), key, version: 0, value: fallback, startsOn: null };
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
    // A card-fee change asks for the passkey again (M4-26; Tenancy and access), once the rule pack's
    // checks pass, so a refused fee says why rather than asking for the passkey first.
    if ("pay" in values) {
      const parsed = settingsSchemas.pay.safeParse(values["pay"]);
      const reasons = parsed.success
        ? checkSetting("pay", parsed.data, { pack: pack.pack, cutover: venue.day_cutover, today })
        : [];
      if (reasons.length > 0)
        throw new ApiError("invalid_request", reasons.join(" "), { details: { reasons } });
      const current = await request.inVenue((c) => readSetting(c, request.venueId!, "pay", today));
      const next = (values["pay"] as { cardFee?: unknown } | null)?.cardFee;
      if (canonical(next) !== canonical(current?.value.cardFee)) {
        const consume = request.server.consumeStepUp;
        if (!consume) throw new ApiError("step_up_required", "confirm with your passkey");
        await consume(request);
      }
    }
    try {
      const savedBy = request.principal.kind === "user" ? request.principal.userId : undefined;
      const { saved, policy, consent } = await request.inVenue(async (c) => {
        const saved = await saveSettings(c, {
          venueId: request.venueId!,
          values,
          savedBy,
          today,
          check: { pack: pack.pack, cutover: venue.day_cutover },
        });
        // The allergy notice reaches every menu within a minute of a save (K-08).
        if ("kitchen" in values) await menusFollowKitchen(c, request.venueId!, options.clock.now());
        // The words guests accept follow the deposit and the gratuity (M5-06): a new version when they change.
        let policy: number | undefined;
        if ("deposit" in values || "pay" in values) {
          const deposit = await readSetting(c, request.venueId!, "deposit", today);
          const pay = await readSetting(c, request.venueId!, "pay", today);
          if (deposit && pay)
            policy = (
              await publishPolicy(c, request.venueId!, {
                text: depositPolicyText(deposit.value, pay.value.gratuity),
                at: options.clock.now().toString(),
                by: savedBy ?? null,
              })
            ).version.version;
        }
        // The consent line read at New tab follows the tab settings (M6-25): a new version when its
        // words change. Tabs already open keep the version that was read to them.
        const consent =
          "tabs" in values
            ? (await tabConsent(c, request.venueId!, options.clock.now())).version
            : undefined;
        // Google Business Profile (M5-15): new hours go to the location now, and again on the
        // business date a later version starts. Nothing is queued while Google isn't connected.
        for (const s of saved.filter((x) => x.key === "hours"))
          await queueGooglePush(
            c,
            request.venueId!,
            options.clock.now(),
            wallClock(
              Temporal.PlainDate.from(s.startsOn),
              venue.day_cutover,
              venue.time_zone,
              venue.day_cutover,
            ),
          );
        return { saved, policy, consent };
      });
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
      return {
        business_date: today.toString(),
        saved,
        ...(policy !== undefined ? { policy_version: policy } : {}),
        ...(consent !== undefined ? { consent_version: consent } : {}),
        ...(readers ? { readers } : {}),
      };
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

/** JSON with its keys sorted, so two equal values compare equal whatever order they were sent in. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

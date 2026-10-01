import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { StoredClock } from "@west4/db";
import { Temporal, formatInZone, systemClock, type Clock } from "@west4/shared";
import { dbPlugin } from "./db.js";
import type { Config } from "./config.js";
import { conventionsPlugin, route, type Authenticator } from "./http/conventions.js";
import { eventsPlugin } from "./http/events.js";
import { settingsRoutes } from "./routes/settings.js";
import { closuresRoutes } from "./routes/closures.js";
import { modulesRoutes } from "./routes/modules.js";
import { ModuleGate } from "./http/module-gate.js";
import { PermissionGate } from "./http/permission-gate.js";
import { permissionsRoutes } from "./routes/permissions.js";
import { attachedRoutes, devicesRoutes } from "./routes/devices.js";
import { pushRoutes } from "./routes/push.js";
import { teamRoutes } from "./routes/team.js";
import { invitesRoutes } from "./routes/invites.js";
import { pinRoutes } from "./routes/pin.js";
import { badgeRoutes } from "./routes/badges.js";
import { loadPushSettings, type PushSettings } from "./push/settings.js";
import { deviceAuthenticator } from "./http/device-auth.js";
import { sessionAuthenticator } from "./auth/session-auth.js";
import { consoleAuthenticator, consoleAuthRoutes } from "./console/auth.js";
import { consoleRoutes } from "./console/routes.js";
import { rulePackRoutes } from "./routes/rule-pack.js";
import { roomsRoutes } from "./routes/rooms.js";
import { bookingsRoutes } from "./routes/bookings.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { checksRoutes } from "./routes/checks.js";
import { twilioHookRoutes } from "./routes/twilio-hooks.js";
import { messageTemplateRoutes } from "./routes/message-templates.js";
import { checkInRoutes } from "./routes/checkin.js";
import { idCheckRoutes } from "./routes/id-checks.js";
import { filesRoutes } from "./routes/files.js";
import { reasonOnlyRoutes } from "./routes/reason-only.js";
import { faultRoutes } from "./routes/faults.js";
import { partySizeRoutes } from "./routes/party-size.js";
import { moveRoutes } from "./routes/move.js";
import { roomCareRoutes } from "./routes/room-care.js";
import { callRoutes } from "./routes/calls.js";
import { approvalRoutes } from "./routes/approvals.js";
import { makeS3, type S3Settings } from "./s3.js";
import { loadVenueTextSettings } from "./texts/venue.js";
import { authRoutes } from "./auth/routes.js";
import type { EmailSettings } from "./email/settings.js";

export interface AppOptions {
  readonly logger?: boolean;
  readonly config?: Config;
  /** Tests pass a clock; otherwise it follows the config. */
  readonly clock?: Clock;
  readonly authenticators?: readonly Authenticator[];
  readonly staffRateLimit?: { max: number; windowMs: number };
  /** The relay's and the tail's poll interval; tests use a short one. */
  readonly eventsPollMs?: number;
  /** How long a container trusts its copy of a venue's module states. */
  readonly moduleCacheMs?: number;
  readonly drainMs?: number;
  /** Tests add fixture routes here, inside the routes plugin's scope. */
  /** Web push (M1-22). Defaults to the local-only VAPID pair when the app is local. */
  readonly push?: PushSettings;
  readonly extraRoutes?: (app: FastifyInstance) => Promise<void> | void;
  /** Who the API may email (M1-18); index.ts loads it from the environment, tests pass one. */
  readonly email?: Pick<EmailSettings, "allowList">;
}

/** server_time is shown in New York time, the platform's home zone (spec conventions · Time zone). */
export const PLATFORM_TIME_ZONE = "America/New_York";

/** Build the API without listening, so tests can inject requests. */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  // forceCloseConnections: the events plugin drains WebSockets slowly first;
  // whatever is left (for example a refused upgrade) is cut so close() returns.
  const app = Fastify({ logger: options.logger ?? false, forceCloseConnections: true });
  const config = options.config;
  let clock: Clock = options.clock ?? systemClock;
  let gate: ModuleGate | undefined;
  let permissions: PermissionGate | undefined;
  let gatePoolRef: pg.Pool | undefined;

  if (config) {
    void app.register(dbPlugin, { databaseUrl: config.databaseUrl });
    const gatePool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 2,
      application_name: "west4-module-gate",
    });
    gatePoolRef = gatePool;
    gate = new ModuleGate(gatePool, options.moduleCacheMs);
    permissions = new PermissionGate(gatePool, options.moduleCacheMs);
    app.addHook("onClose", async () => {
      await gatePool.end();
    });
    if (!options.clock && config.allowStagingFeatures) {
      const clockPool = new pg.Pool({
        connectionString: config.databaseUrl,
        max: 2,
        application_name: "west4-clock",
      });
      const stored = new StoredClock(clockPool);
      clock = stored;
      app.addHook("onClose", async () => {
        await clockPool.end();
      });
      app.addHook("onRequest", async () => {
        await stored.refresh();
      });
    }
  }

  void app.register(conventionsPlugin, {
    clock,
    timeZone: PLATFORM_TIME_ZONE,
    minClientVersion: process.env["MIN_CLIENT_VERSION"] ?? "0.0.0",
    authenticators: [
      ...(options.authenticators ?? []),
      ...(gate && config
        ? [
            sessionAuthenticator(gatePoolRef!, clock),
            deviceAuthenticator(gatePoolRef!),
            consoleAuthenticator(gatePoolRef!, clock),
          ]
        : []),
    ],
    ...(options.staffRateLimit ? { staffRateLimit: options.staffRateLimit } : {}),
    db: config !== undefined,
    ...(gate ? { moduleGate: gate } : {}),
    ...(permissions ? { permissionGate: permissions } : {}),
  });

  // Live events need the database (M1-09).
  if (config) {
    void app.register(eventsPlugin, {
      clock,
      timeZone: PLATFORM_TIME_ZONE,
      ...(options.eventsPollMs !== undefined ? { pollMs: options.eventsPollMs } : {}),
      ...(options.drainMs !== undefined ? { drainMs: options.drainMs } : {}),
    });
  }

  // Every route is added after the conventions plugin, so its registry sees them all.
  void app.register(async (scope) => {
    // Operations route (M1-02): no venue data.
    scope.get(
      "/v1/health",
      { config: route({ principals: ["public"], module: "core", rateLimit: false }) },
      async () => ({ ok: true, server_time: formatInZone(clock.now(), PLATFORM_TIME_ZONE) }),
    );

    // Staging-only control that moves the simulated clock (M1-06). It doesn't
    // exist anywhere else: production answers 404 like any unknown route.
    if (config?.allowStagingFeatures && clock instanceof StoredClock) {
      const stored = clock;
      scope.post<{ Body: { server_time?: string | null } }>(
        "/v1/ops/clock",
        { config: route({ principals: ["public"], module: "core", idempotency: "none" }) },
        async (request, reply) => {
          const body = request.body ?? {};
          const at =
            body.server_time === null || body.server_time === undefined
              ? null
              : Temporal.Instant.from(body.server_time);
          await stored.set(at, "ops");
          return reply
            .code(200)
            .send({ ok: true, server_time: formatInZone(stored.now(), PLATFORM_TIME_ZONE) });
        },
      );
    }

    if (config) {
      authRoutes(scope, {
        pool: gatePoolRef!,
        clock,
        config: config.auth,
        email: options.email ?? { allowList: null },
      });
      settingsRoutes(scope, { clock });
      rulePackRoutes(scope, { clock });
      roomsRoutes(scope, { clock });
      bookingsRoutes(scope, { clock });
      sessionsRoutes(scope, { clock });
      checksRoutes(scope, { clock });
      messageTemplateRoutes(scope);
      idCheckRoutes(scope, { clock, wrappingKey: config.auth.secretKey });
      reasonOnlyRoutes(scope, { clock });
      faultRoutes(scope, { clock });
      partySizeRoutes(scope, { clock });
      moveRoutes(scope, { clock });
      roomCareRoutes(scope, { clock });
      callRoutes(scope, { clock });
      approvalRoutes(scope, { clock });
      let s3: S3Settings | null = null;
      filesRoutes(scope, { clock, s3: () => (s3 ??= makeS3()) });
      checkInRoutes(scope, {
        pool: gatePoolRef!,
        clock,
        settings: { texts: loadVenueTextSettings(config.env), guestAppUrl: config.guestAppUrl },
      });
      twilioHookRoutes(scope, {
        pool: gatePoolRef!,
        secretKey: config.auth.secretKey,
        publicApiUrl: process.env["PUBLIC_API_URL"]?.replace(/\/+$/, "") ?? null,
      });
      closuresRoutes(scope, { clock });
      modulesRoutes(scope, { gate: gate! });
      permissionsRoutes(scope, { gate: permissions! });
      devicesRoutes(scope, { clock });
      attachedRoutes(scope);
      pushRoutes(scope, { settings: options.push ?? loadPushSettings(config.env), clock });
      teamRoutes(scope, {
        clock,
        email: options.email ?? { allowList: null },
        staffAppUrl: config.staffAppUrl,
      });
      invitesRoutes(scope, { pool: gatePoolRef!, clock, pepper: config.auth.secretKey });
      pinRoutes(scope, { pool: gatePoolRef!, clock, config: config.auth });
      badgeRoutes(scope, { pool: gatePoolRef!, clock, config: config.auth });
      // The Console (M1-35) exists only where CONSOLE_URL names its hostname.
      if (config.console) {
        consoleAuthRoutes(scope, { pool: gatePoolRef!, clock, config, console: config.console });
        consoleRoutes(scope, {
          pool: gatePoolRef!,
          gate: gate!,
          clock,
          rulePackSigningKey: config.rulePackSigningKey,
        });
      }
    }
    await options.extraRoutes?.(scope);
  });

  return app;
}

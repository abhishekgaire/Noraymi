import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import {
  BADGE_KEY_VERSION,
  badgeByUid,
  badgeKeyVersions,
  badgesOf,
  decodePiccData,
  disableBadge,
  endSessionsOnDevice,
  openSession,
  pairBadge,
  parseSun,
  pinMembership,
  recordBadgeTap,
  tagFileReadKey,
  venueBadgeKeys,
  verifySunMac,
  withVenue,
  type BadgeRow,
  type PiccData,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import type { AuthConfig } from "../config.js";
import { SESSION_MAX_HOURS } from "../auth/session-auth.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * Badges (M1-25, spec 02 · Badges). A tap on a shared screen's reader is a
 * SUN message signed by the device that read it. The server decrypts the UID
 * and read counter under the venue's meta-read key, finds the badge, derives
 * that tag's key from the venue's master key and the badge's key version,
 * checks the MAC, and accepts the read only if the counter went up. The
 * person's session opens at once and ends whoever was on that screen.
 */
const sunBody = z
  .object({
    sun: z.union([
      z.string().max(500),
      z.object({ picc_data: z.string().max(64), cmac: z.string().max(32) }).strict(),
    ]),
    client: z.literal("shared").optional(),
  })
  .strict();

const pairBody = z
  .object({
    sun: z.union([
      z.string().max(500),
      z.object({ picc_data: z.string().max(64), cmac: z.string().max(32) }).strict(),
    ]),
    label: z.string().trim().max(80).optional(),
  })
  .strict();

const refused = (why: string) => new ApiError("forbidden", why);

export function badgeRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; config: AuthConfig },
): void {
  const { pool, clock, config } = options;
  const now = () => clock.now();

  const teamChange = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.team",
    assurance: "passkey",
    stepUp: true,
    idempotency: "optional",
    tokenRoute: true,
  });

  /** Decrypt the tap under every key version the venue has badges for; the first UID-and-counter answer wins. */
  function decode(
    venueId: string,
    versions: readonly number[],
    piccData: string,
  ): { picc: PiccData; keyVersion: number } | null {
    for (const keyVersion of versions) {
      const keys = venueBadgeKeys(config.secretKey, venueId, keyVersion);
      const picc = decodePiccData(keys.metaRead, piccData);
      if (picc) return { picc, keyVersion };
    }
    return null;
  }

  function macChecks(venueId: string, keyVersion: number, picc: PiccData, cmac: string): boolean {
    const keys = venueBadgeKeys(config.secretKey, venueId, keyVersion);
    return verifySunMac(tagFileReadKey(keys.master, picc.uid), picc.uid, picc.counter, cmac);
  }

  app.post<{ Body: unknown }>(
    "/v1/auth/badge",
    {
      config: route({
        principals: ["public"],
        module: "core",
        idempotency: "none",
        tokenRoute: true,
        rateLimit: { max: 120, windowMs: 60_000 },
      }),
    },
    async (request, reply) => {
      const parsed = sunBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { sun }");
      const device = request.signedDevice;
      if (!device) throw refused("a badge is read by a paired screen");
      if (device.kind !== "bar_computer" && device.kind !== "front_desk")
        throw refused("badges are read on the bar and front-desk computers");
      const sun = parseSun(parsed.data.sun);
      if (!sun) throw new ApiError("invalid_request", "that isn't a badge message");
      const venueId = device.venueId;
      const startedAt = now();
      // First the badge and the person, with no one signed in yet; then the tap and the session as that person,
      // so the sessions table's row policy (user_id = app_user_id()) lets the row in.
      const found = await withVenue(pool, { venueId, requestId: request.requestId }, async (c) => {
        const versions = await badgeKeyVersions(c, venueId);
        const decoded = decode(venueId, versions, sun.piccData);
        if (!decoded) throw refused("unknown badge");
        const badge = await badgeByUid(c, venueId, decoded.picc.uid);
        if (!badge || badge.keyVersion !== decoded.keyVersion) throw refused("unknown badge");
        if (badge.disabledAt) throw refused("this badge was switched off");
        if (!macChecks(venueId, badge.keyVersion, decoded.picc, sun.cmac))
          throw refused("this badge isn't genuine");
        if (decoded.picc.counter <= badge.lastCounter) throw refused("that read was already used");
        const member = await pinMembership(c, venueId, { membershipId: badge.membershipId });
        if (!member) throw refused("this person no longer works here");
        return { badge, member, counter: decoded.picc.counter };
      });
      const opened = await withVenue(
        pool,
        { venueId, userId: found.member.userId, requestId: request.requestId },
        async (c) => {
          if (
            !(await recordBadgeTap(c, venueId, found.badge.id, found.counter, startedAt.toString()))
          )
            throw refused("that read was already used");
          // Someone else's tap takes over the screen at once.
          await endSessionsOnDevice(c, {
            deviceId: device.deviceId,
            at: startedAt.toString(),
            reason: "replaced",
          });
          const expiresAt = startedAt.add({ hours: SESSION_MAX_HOURS });
          const session = await openSession(c, {
            userId: found.member.userId,
            principal:
              found.member.role === "owner" || found.member.role === "manager"
                ? "owner_manager"
                : "staff",
            assurance: "badge",
            client: "shared",
            membershipId: found.member.membershipId,
            deviceId: device.deviceId,
            startedAt: startedAt.toString(),
            expiresAt: expiresAt.toString(),
          });
          return { session, member: found.member, badge: found.badge, expiresAt };
        },
      );
      return reply.code(200).send({
        token: opened.session.token,
        session: {
          id: opened.session.id,
          assurance: "badge",
          expires_at: opened.expiresAt.toString(),
        },
        user: { id: opened.member.userId, name: opened.member.name },
        membership: {
          id: opened.member.membershipId,
          venue_id: venueId,
          role: opened.member.role,
          locale: opened.member.locale,
        },
        badge: { id: opened.badge.id, label: opened.badge.label },
      });
    },
  );

  const shape = (b: BadgeRow) => ({
    id: b.id,
    membership_id: b.membershipId,
    label: b.label,
    key_version: b.keyVersion,
    paired_at: b.pairedAt,
    last_tap_at: b.lastTapAt,
    disabled_at: b.disabledAt,
  });

  /** Pair a badge to a person by tapping it on the reader in Admin → Team (the reader side is M1-30). */
  app.post<{ Params: { venueId: string; m: string }; Body: unknown }>(
    "/v1/venues/:venueId/team/:m/badges",
    { config: teamChange },
    async (request, reply) => {
      const p = request.principal;
      if (p.kind !== "user") throw refused("you can't call this");
      const parsed = pairBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { sun, label? }");
      const sun = parseSun(parsed.data.sun);
      if (!sun) throw new ApiError("invalid_request", "that isn't a badge message");
      const venueId = request.venueId!;
      const paired = await request.inVenue(async (c) => {
        const member = await pinMembership(c, venueId, { membershipId: request.params.m });
        if (!member) throw new ApiError("not_found", "no such person at this venue");
        const decoded = decode(venueId, [BADGE_KEY_VERSION], sun.piccData);
        if (!decoded)
          throw new ApiError("invalid_request", "that tag isn't one of this venue's badges");
        if (!macChecks(venueId, BADGE_KEY_VERSION, decoded.picc, sun.cmac))
          throw new ApiError("invalid_request", "that tag isn't genuine");
        const badge = await pairBadge(c, {
          venueId,
          membershipId: member.membershipId,
          uid: decoded.picc.uid,
          counter: decoded.picc.counter,
          label: parsed.data.label ?? "",
          pairedBy: p.userId,
        });
        if (!badge)
          throw new ApiError("version_conflict", "that badge is already paired to someone");
        return badge;
      });
      return reply.code(201).send({ badge: shape(paired) });
    },
  );

  app.get<{ Params: { venueId: string; m: string } }>(
    "/v1/venues/:venueId/team/:m/badges",
    { config: route({ principals: ["owner_manager"], module: "core", action: "admin.access" }) },
    async (request) => ({
      badges: (await request.inVenue((c) => badgesOf(c, request.venueId!, request.params.m))).map(
        shape,
      ),
    }),
  );

  /** A lost badge is switched off here; it can be paired again to anyone later. */
  app.post<{ Params: { venueId: string; b: string } }>(
    "/v1/venues/:venueId/badges/:b/disable",
    { config: teamChange },
    async (request, reply) => {
      const ok = await request.inVenue((c) => disableBadge(c, request.venueId!, request.params.b));
      if (!ok) throw new ApiError("not_found", "no such badge");
      return reply.code(200).send({ ok: true });
    },
  );

  /**
   * Pairing a factory tag (M1-30): the host that reads it needs the tag's two
   * SDM keys once, to write them into the tag. They're worked out from the
   * venue's master key for the current key version and the tag's UID, handed
   * to the owner's passkey session with the step-up, and never stored.
   */
  app.post<{ Params: { venueId: string; m: string }; Body: unknown }>(
    "/v1/venues/:venueId/team/:m/badges/keys",
    {
      // A passkey session with the team right; the one step-up of a pairing guards the write that follows.
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "admin.team",
        assurance: "passkey",
        idempotency: "none",
        tokenRoute: true,
      }),
    },
    async (request, reply) => {
      const parsed = z
        .object({ uid: z.string().regex(/^[0-9a-fA-F]{14}$/) })
        .strict()
        .safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { uid }");
      const venueId = request.venueId!;
      const member = await request.inVenue((c) =>
        pinMembership(c, venueId, { membershipId: request.params.m }),
      );
      if (!member) throw new ApiError("not_found", "no such person at this venue");
      const keys = venueBadgeKeys(config.secretKey, venueId, BADGE_KEY_VERSION);
      const uid = Buffer.from(parsed.data.uid, "hex");
      return reply.code(200).send({
        key_version: BADGE_KEY_VERSION,
        meta_read_key: keys.metaRead.toString("hex"),
        file_read_key: tagFileReadKey(keys.master, uid).toString("hex"),
      });
    },
  );
}

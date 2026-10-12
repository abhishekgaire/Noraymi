import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createSetupRequest,
  decryptSecret,
  listSetupRequests,
  twilioIntegration,
  type Queryable,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { BrandStepFailed, registerBrand, type BrandSettings } from "../texts/brand.js";
import { venueProfile } from "./venue-profile.js";

/**
 * Set up your venue's step 11 (O-12; spec 17 · Step details 11), all optional:
 *   GET  /v1/venues/{v}/setup/texts           the texting number, the campaign's status, the last
 *                                             registration (never an EIN) and the step's requests
 *   POST /v1/venues/{v}/setup/texts/register  Register for texts: the 10DLC brand on the venue's
 *                                             subaccount; the EIN is sent once and never kept
 *   POST /v1/venues/{v}/setup/website         "Do you have a website and domain to move?"
 *   (the old system's export files: POST /files as import_export, then POST /setup/requests)
 * Register for texts is the owner's; the rest is any owner or manager with Admin.
 */
const TYPES = [
  "Sole Proprietorship",
  "Partnership",
  "Limited Liability Corporation",
  "Co-operative",
  "Non-profit Corporation",
  "Corporation",
] as const;
const POSITIONS = ["Director", "GM", "VP", "CEO", "CFO", "General Counsel", "Other"] as const;

const registerBody = z
  .object({
    ein: z.string().regex(/^\d{2}-?\d{7}$/),
    business_type: z.enum(TYPES),
    website_url: z
      .string()
      .trim()
      .url()
      .max(300)
      .refine((u) => /^https?:\/\//.test(u)),
    rep: z
      .object({
        first_name: z.string().trim().min(1).max(80),
        last_name: z.string().trim().min(1).max(80),
        email: z.string().trim().email().max(254),
        phone_e164: z.string().regex(/^\+1[2-9]\d{9}$/),
        title: z.string().trim().min(1).max(80),
        position: z.enum(POSITIONS),
      })
      .strict(),
    samples: z.tuple([z.string().trim().min(20).max(1024), z.string().trim().min(20).max(1024)]),
  })
  .strict();

const websiteBody = z
  .object({
    answer: z.enum(["yes", "no"]),
    domain: z.string().trim().min(3).max(253).nullable().optional(),
  })
  .strict();

interface Registration {
  id: string;
  state: "sending" | "submitted" | "failed";
  legal_name: string;
  business_type: string;
  website_url: string;
  brand_sid: string | null;
  failure: string | null;
  created_at: string;
  submitted_at: string | null;
}

const REG_COLS = `id, state, legal_name, business_type, website_url, brand_sid, failure,
  to_json(created_at) #>> '{}' as created_at, to_json(submitted_at) #>> '{}' as submitted_at`;

const lastRegistration = async (c: Queryable, venueId: string) =>
  (
    await c.query<Registration>(
      `select ${REG_COLS} from text_registrations where venue_id = $1
        order by created_at desc, id desc limit 1`,
      [venueId],
    )
  ).rows[0] ?? null;

function ownerOf(request: FastifyRequest): string {
  const p = request.principal;
  const here =
    p.kind === "user" ? p.memberships.find((m) => m.venueId === request.venueId) : undefined;
  if (p.kind !== "user" || here?.role !== "owner")
    throw new ApiError("forbidden", "only the venue's owner registers it for texts");
  return p.userId;
}

export function setupTextsRoutes(
  app: FastifyInstance,
  options: { clock: Clock; secretKey: Buffer; brand: BrandSettings; fetchImpl?: typeof fetch },
): void {
  const read = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
  });
  const write = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
    idempotency: "optional",
  });
  // No idempotency record for Register for texts: even a hash of a body holding an EIN is kept
  // nowhere. The registration's own row (one live per venue) stops a second one.
  const register = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
    idempotency: "none",
  });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/setup/texts",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const twilio = await twilioIntegration(c, venueId);
        const profile = await venueProfile(c, venueId);
        const requests = (await listSetupRequests(c, venueId)).filter(
          (r) => r.kind === "website" || r.kind === "old_system",
        );
        return {
          subaccount: twilio !== null,
          number: twilio?.phoneE164 ?? null,
          campaign: twilio?.campaign.status ?? "not_registered",
          legal_name: profile.legal_name,
          address: profile.address,
          registration: await lastRegistration(c, venueId),
          requests,
        };
      }),
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/setup/texts/register",
    { config: register },
    async (request, reply) => {
      const userId = ownerOf(request);
      const parsed = registerBody.safeParse(request.body);
      // The refusal names the fields, never their values.
      if (!parsed.success)
        throw new ApiError("invalid_request", "the registration form isn't complete", {
          details: { fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))] },
        });
      const body = parsed.data;
      const venueId = request.venueId!;
      const id = randomUUID();
      // 1. The row first (one live registration per venue), with no EIN in it.
      const prepared = await request.inVenue(async (c) => {
        const twilio = await twilioIntegration(c, venueId);
        if (!twilio)
          throw new ApiError("invalid_request", "the venue's texting number isn't set up yet", {
            status: 409,
            details: { reason: "no_subaccount" },
          });
        const profile = await venueProfile(c, venueId);
        if (!profile.address)
          throw new ApiError("invalid_request", "add the venue's address in step 1 first", {
            status: 409,
            details: { reason: "no_address" },
          });
        try {
          await c.query(
            `insert into text_registrations (id, venue_id, legal_name, business_type, website_url,
               street, city, region, postal_code, rep_first_name, rep_last_name, rep_email, rep_phone,
               rep_title, rep_position, sample_1, sample_2, submitted_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
            [
              id,
              venueId,
              profile.legal_name,
              body.business_type,
              body.website_url,
              [profile.address.line1, profile.address.line2].filter(Boolean).join(", "),
              profile.address.city,
              profile.address.state,
              profile.address.postal_code.slice(0, 5),
              body.rep.first_name,
              body.rep.last_name,
              body.rep.email,
              body.rep.phone_e164,
              body.rep.title,
              body.rep.position,
              body.samples[0],
              body.samples[1],
              userId,
            ],
          );
        } catch (e) {
          if ((e as { code?: string }).code === "23505")
            throw new ApiError("invalid_request", "this venue is already registered for texts", {
              status: 409,
              details: { reason: "already_registered" },
            });
          throw e;
        }
        return { twilio, profile, address: profile.address };
      });
      // 2. Twilio, outside any transaction, keyed by the registration's id.
      let state: "submitted" | "failed" = "failed";
      let sids: { customerProfileSid: string; trustProductSid: string; brandSid: string } | null =
        null;
      let failure: string | null = null;
      try {
        sids = await registerBrand(
          {
            accountSid: prepared.twilio.accountSid,
            authToken: decryptSecret(options.secretKey, prepared.twilio.secretEnc),
          },
          {
            legalName: prepared.profile.legal_name,
            ein: body.ein.replace("-", ""),
            businessType: body.business_type,
            websiteUrl: body.website_url,
            street: [prepared.address.line1, prepared.address.line2].filter(Boolean).join(", "),
            city: prepared.address.city,
            region: prepared.address.state,
            postalCode: prepared.address.postal_code.slice(0, 5),
            rep: {
              firstName: body.rep.first_name,
              lastName: body.rep.last_name,
              email: body.rep.email,
              phone: body.rep.phone_e164,
              title: body.rep.title,
              position: body.rep.position,
            },
          },
          options.brand,
          `west4-brand-${id}`,
          options.fetchImpl,
        );
        state = "submitted";
      } catch (e) {
        failure =
          e instanceof BrandStepFailed ? e.message.slice(0, 200) : "Twilio couldn't be reached";
      }
      // 3. What came back.
      const saved = await request.inVenue(async (c) => {
        await c.query(
          `update text_registrations set state = $3, customer_profile_sid = $4, trust_product_sid = $5,
                  brand_sid = $6, failure = $7, submitted_at = case when $3::text = 'submitted' then now() end
            where venue_id = $1 and id = $2`,
          [
            venueId,
            id,
            state,
            sids?.customerProfileSid ?? null,
            sids?.trustProductSid ?? null,
            sids?.brandSid ?? null,
            failure,
          ],
        );
        return lastRegistration(c, venueId);
      });
      return reply.code(state === "submitted" ? 201 : 502).send(saved);
    },
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/setup/website",
    { config: write },
    async (request, reply) => {
      const parsed = websiteBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { answer, domain? }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      const venueId = request.venueId!;
      const made = await request.inVenue((c) =>
        createSetupRequest(c, venueId, {
          kind: "website",
          answer: parsed.data.answer,
          fileId: null,
          note: parsed.data.answer === "yes" ? (parsed.data.domain ?? null) : null,
          userId: p.userId,
        }),
      );
      return reply.code(201).send(made);
    },
  );
}

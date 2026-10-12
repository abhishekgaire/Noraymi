import type { FastifyInstance } from "fastify";
import { route } from "../http/conventions.js";

/**
 * The public forms' CAPTCHA (M2-27, D109): GET /v1/public/captcha gives the
 * pages that show Cloudflare Turnstile's widget its site key, so the key lives
 * in one place, the API's environment. The secret key never leaves the API.
 */
export function captchaRoutes(app: FastifyInstance, options: { siteKey: string }): void {
  app.get(
    "/v1/public/captcha",
    { config: route({ principals: ["public"], module: "core" }) },
    async (_request, reply) => {
      reply.header("Cache-Control", "public, max-age=300");
      return { provider: "turnstile", site_key: options.siteKey };
    },
  );
}

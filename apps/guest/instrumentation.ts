import type { Instrumentation } from "next";

/**
 * The guest web's server errors (M8-16): one scrubbed error report per failed request, as a JSON
 * line on the log (CloudWatch keeps it 30 days and counts it, infra/staging/observability.tf), in
 * the same shape as the API's. The route file's path is logged, never the request's own path,
 * which can carry a token (/r/<token>, /receipt/<token>).
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportServerError } = await import("./instrumentation-node");
    await reportServerError(err, request, context);
  }
};

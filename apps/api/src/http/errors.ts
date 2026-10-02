/**
 * The error shape every screen branches on (spec 08 · Errors):
 * { "error": { "code", "message", "retryable" } }.
 */
export const ERROR_STATUS = {
  module_off: 404,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  unauthorized: 401,
  session_locked: 401,
  session_expired: 401,
  step_up_required: 403,
  version_conflict: 409,
  in_progress: 409,
  alcohol_closed: 409,
  cut_off: 409,
  ordering_closed: 409,
  orders_open: 409,
  room_not_free: 409,
  over_amount_due: 422,
  over_refundable: 422,
  key_reused: 422,
  approval_pending: 202,
  payment_unknown: 202,
  reader_busy: 409,
  reader_offline: 503,
  rate_limited: 429,
  /** Stripe refused or couldn't be reached for something that isn't a payment (M4-01). */
  stripe_error: 502,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "in_progress",
  "reader_busy",
  "reader_offline",
  "rate_limited",
  "internal",
  "stripe_error",
]);

export class ApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number; details?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? ERROR_STATUS[code];
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details;
  }
  readonly details: unknown;

  toBody(): { error: { code: ErrorCode; message: string; retryable: boolean; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

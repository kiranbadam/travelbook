import type { ErrorClass } from "./types.js";

/** Error taxonomy -> HTTP status mapping (architecture plan, "Request controls"). */
export const ERROR_HTTP_STATUS: Record<ErrorClass, number> = {
  INVALID_PREFERENCES: 400,
  POLICY_BLOCKED: 403,
  INSUFFICIENT_EVIDENCE: 422,
  PROVIDER_UNAVAILABLE: 502,
  BUDGET_EXHAUSTED: 429,
};

export class ApiError extends Error {
  readonly errorClass: ErrorClass;
  readonly detail?: unknown;
  readonly statusOverride?: number;

  constructor(errorClass: ErrorClass, message: string, detail?: unknown, statusOverride?: number) {
    super(message);
    this.name = "ApiError";
    this.errorClass = errorClass;
    this.detail = detail;
    this.statusOverride = statusOverride;
  }

  get status(): number {
    return this.statusOverride ?? ERROR_HTTP_STATUS[this.errorClass];
  }
}

/** Shape of every API error body. */
export function errorBody(err: ApiError): { error: { class: ErrorClass; message: string; detail?: unknown } } {
  const body: { error: { class: ErrorClass; message: string; detail?: unknown } } = {
    error: { class: err.errorClass, message: err.message },
  };
  if (err.detail !== undefined) body.error.detail = err.detail;
  return body;
}

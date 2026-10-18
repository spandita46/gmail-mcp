import type { Account } from "./config.js";

// Gmail signals per-user throttling with 429, or with 403 plus one of these reasons.
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const MAX_RETRY_AFTER_MS = 60_000; // never wait longer than this, whatever Gmail says

// The shape of a failed Google API call (GaxiosError), as far as we rely on it.
interface GoogleErrorShape {
  message?: string;
  status?: unknown;
  code?: unknown;
  response?: {
    status?: unknown;
    data?: {
      error?: unknown; // a string from the token endpoint ("invalid_grant"), an object from the Gmail API
      error_description?: string;
    };
  };
}

// The HTTP status of a failed Google API call, if it has one.
export function httpStatus(err: unknown): number | undefined {
  const e = err as GoogleErrorShape;
  const status = e.response?.status ?? e.status ?? e.code;
  return typeof status === "number" ? status : undefined;
}

// The Gmail API's machine-readable reasons, e.g. ["userRateLimitExceeded"].
export function errorReasons(err: unknown): string[] {
  const apiError = (err as GoogleErrorShape).response?.data?.error;
  if (!apiError || typeof apiError !== "object") return [];
  const errors = (apiError as { errors?: { reason?: unknown }[] }).errors ?? [];
  return errors.flatMap((e) => (typeof e.reason === "string" ? [e.reason] : []));
}

// 429, or a 403 whose reason or message says "rate limit". A 403 is NOT always a permission problem.
export function isRateLimited(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === 429) return true;
  if (status !== 403) return false;
  return (
    errorReasons(err).some((r) => RATE_LIMIT_REASONS.has(r)) ||
    /rate limit/i.test((err as GoogleErrorShape).message ?? "")
  );
}

// Rate limits and 5xx are usually temporary, so they are worth retrying.
export function isTransient(err: unknown): boolean {
  const status = httpStatus(err);
  return isRateLimited(err) || (status !== undefined && status >= 500);
}

// Gmail's rate-limit message often says when to come back: "...Retry after 2026-10-18T04:51:30.123Z".
// Returns how long to wait from `now`, capped, or undefined when there is no usable hint.
export function retryAfterMs(err: unknown, now = Date.now()): number | undefined {
  const match = ((err as GoogleErrorShape).message ?? "").match(/Retry after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i);
  if (!match) return undefined;
  const wait = Date.parse(match[1]!) - now;
  return Number.isNaN(wait) ? undefined : Math.min(Math.max(wait, 0), MAX_RETRY_AFTER_MS);
}

// Turn Google/HTTP errors into messages that tell you what to do next.
export function describeGoogleError(err: unknown, account: Account): string {
  const e = err as GoogleErrorShape;
  const status = httpStatus(err);

  if (e.response?.data?.error === "invalid_grant") {
    return `The saved sign-in for "${account}" has expired or was revoked. Re-run: npm run auth -- ${account}`;
  }
  // Check rate limits BEFORE the generic 403: Gmail uses 403 for both.
  if (isRateLimited(err)) {
    return `Gmail is rate-limiting "${account}" right now. Wait about 30 seconds and try again (or scan fewer messages).`;
  }
  if (status === 403) {
    return `Google refused access for "${account}" (403). The account may not have granted Gmail permission. Re-run: npm run auth -- ${account}`;
  }
  if (status === 404) {
    return `Not found in "${account}". The id may be wrong, or the message belongs to a different account.`;
  }
  return `Gmail request failed for "${account}": ${e.message ?? String(err)}`;
}

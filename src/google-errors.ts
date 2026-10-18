import type { Account } from "./config.js";

// The HTTP status of a failed Google API call, if it has one.
export function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const status = e.response?.status ?? e.status ?? e.code;
  return typeof status === "number" ? status : undefined;
}

// 429 and 5xx are usually temporary, so they are worth retrying.
export function isTransient(err: unknown): boolean {
  const status = httpStatus(err);
  return status === 429 || (status !== undefined && status >= 500);
}

// Turn Google/HTTP errors into messages that tell you what to do next.
// Two shapes reach here:
//   • token endpoint errors: response.data.error is a string, e.g. "invalid_grant"
//   • Gmail API errors:      response.status is 403 / 429, data.error is an object
export function describeGoogleError(err: unknown, account: Account): string {
  const e = err as {
    message?: string;
    response?: {
      data?: { error?: unknown; error_description?: string };
    };
  };
  const status = httpStatus(err);
  const oauthError = e.response?.data?.error;

  if (oauthError === "invalid_grant") {
    return `The saved sign-in for "${account}" has expired or was revoked. Re-run: npm run auth -- ${account}`;
  }
  if (status === 403) {
    return `Google refused access for "${account}" (403). The account may not have granted Gmail permission. Re-run: npm run auth -- ${account}`;
  }
  if (status === 404) {
    return `Not found in "${account}". The id may be wrong, or the message belongs to a different account.`;
  }
  if (status === 429) {
    return `Gmail rate limit hit for "${account}". Wait a few seconds and try again.`;
  }
  return `Gmail request failed for "${account}": ${e.message ?? String(err)}`;
}

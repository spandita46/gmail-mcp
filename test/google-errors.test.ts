import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeGoogleError,
  errorReasons,
  httpStatus,
  isRateLimited,
  isTransient,
  retryAfterMs,
} from "../src/google-errors.js";

// Helpers that build errors shaped like the ones googleapis (gaxios) throws.
const apiError = (status: number, reason?: string, message = "") =>
  Object.assign(new Error(message), {
    response: { status, data: { error: { code: status, message, ...(reason ? { errors: [{ reason }] } : {}) } } },
  });
const tokenError = (error: string) =>
  Object.assign(new Error(error), { response: { status: 400, data: { error } } });

describe("httpStatus", () => {
  it("reads response.status", () => assert.equal(httpStatus(apiError(404)), 404));
  it("falls back to a numeric code", () => assert.equal(httpStatus({ code: 503 }), 503));
  it("ignores string codes like ECONNRESET", () => assert.equal(httpStatus({ code: "ECONNRESET" }), undefined));
  it("handles non-objects", () => assert.equal(httpStatus("boom"), undefined));
});

describe("errorReasons", () => {
  it("extracts Gmail reasons", () => assert.deepEqual(errorReasons(apiError(403, "userRateLimitExceeded")), ["userRateLimitExceeded"]));
  it("is empty for token-endpoint errors (string error)", () => assert.deepEqual(errorReasons(tokenError("invalid_grant")), []));
});

describe("isRateLimited", () => {
  it("429 is a rate limit", () => assert.equal(isRateLimited(apiError(429)), true));
  it("403 userRateLimitExceeded is a rate limit (regression: found in live stress test)", () =>
    assert.equal(isRateLimited(apiError(403, "userRateLimitExceeded")), true));
  it("403 rateLimitExceeded is a rate limit", () => assert.equal(isRateLimited(apiError(403, "rateLimitExceeded")), true));
  it("403 with a rate-limit message but no reason is a rate limit", () =>
    assert.equal(isRateLimited(apiError(403, undefined, "User-rate limit exceeded.")), true));
  it("403 insufficientPermissions is NOT a rate limit", () =>
    assert.equal(isRateLimited(apiError(403, "insufficientPermissions", "Insufficient Permission")), false));
  it("500 is not a rate limit", () => assert.equal(isRateLimited(apiError(500)), false));
});

describe("isTransient", () => {
  for (const [status, reason, expected] of [
    [429, undefined, true],
    [403, "userRateLimitExceeded", true],
    [500, undefined, true],
    [503, undefined, true],
    [403, "insufficientPermissions", false],
    [404, undefined, false],
    [400, undefined, false],
  ] as const) {
    it(`${status} ${reason ?? ""} → ${expected}`, () => assert.equal(isTransient(apiError(status, reason)), expected));
  }
});

describe("retryAfterMs", () => {
  const now = Date.parse("2026-10-18T04:51:00.000Z");
  it("reads Gmail's 'Retry after' timestamp", () =>
    assert.equal(retryAfterMs(new Error("User-rate limit exceeded.  Retry after 2026-10-18T04:51:30.000Z"), now), 30_000));
  it("caps very long waits at 60s", () =>
    assert.equal(retryAfterMs(new Error("Retry after 2026-10-18T05:51:00.000Z"), now), 60_000));
  it("never returns a negative wait", () =>
    assert.equal(retryAfterMs(new Error("Retry after 2026-10-18T04:00:00.000Z"), now), 0));
  it("is undefined without a hint", () => assert.equal(retryAfterMs(new Error("nope"), now), undefined));
});

describe("describeGoogleError", () => {
  it("invalid_grant → re-auth", () => assert.match(describeGoogleError(tokenError("invalid_grant"), "primary"), /expired or was revoked.*npm run auth -- primary/));
  it("rate-limit 403 → wait, NOT re-auth (regression)", () => {
    const msg = describeGoogleError(apiError(403, "userRateLimitExceeded"), "primary");
    assert.match(msg, /rate-limiting/);
    assert.doesNotMatch(msg, /npm run auth/);
  });
  it("permission 403 → re-auth", () => assert.match(describeGoogleError(apiError(403, "insufficientPermissions"), "work"), /refused access.*npm run auth -- work/));
  it("404 → wrong id or account", () => assert.match(describeGoogleError(apiError(404), "other"), /Not found in "other"/));
  it("other errors include the message", () => assert.match(describeGoogleError(new Error("socket hang up"), "secondary"), /socket hang up/));
});

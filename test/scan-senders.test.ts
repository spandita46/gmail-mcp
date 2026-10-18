// scanSenders against a FAKE Gmail client: exercises the retry / skip / fail paths
// that are hard to trigger against real Gmail.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { gmail_v1 } from "@googleapis/gmail";
import { scanSendersWith } from "../src/gmail.js";

type Behaviour = (id: string, attempt: number) => unknown; // return data, or throw

const apiError = (status: number, reason?: string, message = "") =>
  Object.assign(new Error(message), {
    response: { status, data: { error: { code: status, message, ...(reason ? { errors: [{ reason }] } : {}) } } },
  });

// A stand-in for the googleapis client: only users.messages.get is used by scanSenders.
function fakeApi(behaviour: Behaviour) {
  const attempts = new Map<string, number>();
  const calls: string[] = [];
  const api = {
    users: {
      messages: {
        get: async ({ id }: { id: string }) => {
          calls.push(id);
          const n = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, n);
          return { data: behaviour(id, n) };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
  return { api, calls };
}

const headersFor = (id: string) => ({
  internalDate: "1792209600000",
  payload: {
    headers: [
      { name: "From", value: `Sender ${id} <${id}@x.com>` },
      { name: "Date", value: "Sat, 17 Oct 2026 10:00:00 +0000" },
      { name: "list-unsubscribe", value: "<https://x.com/u>" }, // lower-case on purpose
    ],
  },
});
const fast = { sleep: async () => {} }; // don't actually wait between retries

describe("scanSendersWith", () => {
  it("reads the headers it needs (case-insensitively) and internalDate", async () => {
    const { api } = fakeApi((id) => headersFor(id));
    const { messages, skipped } = await scanSendersWith(api, "primary", ["a"], fast);
    assert.equal(skipped, 0);
    assert.deepEqual(messages[0], {
      account: "primary",
      from: "Sender a <a@x.com>",
      date: "Sat, 17 Oct 2026 10:00:00 +0000",
      internalDate: 1792209600000,
      listUnsubscribe: "<https://x.com/u>",
      listUnsubscribePost: "",
    });
  });

  it("skips a message deleted since the list call (404) and keeps going", async () => {
    const { api } = fakeApi((id) => {
      if (id === "gone") throw apiError(404);
      return headersFor(id);
    });
    const { messages, skipped } = await scanSendersWith(api, "primary", ["a", "gone", "b"], fast);
    assert.equal(skipped, 1);
    assert.deepEqual(messages.map((m) => m.from.split(" ")[1]), ["a", "b"]);
  });

  it("retries a 500 and succeeds", async () => {
    const { api, calls } = fakeApi((id, attempt) => {
      if (attempt === 1) throw apiError(500);
      return headersFor(id);
    });
    const { messages } = await scanSendersWith(api, "primary", ["a"], fast);
    assert.equal(messages.length, 1);
    assert.equal(calls.length, 2);
  });

  it("skips a message whose 5xx outlasts the retries", async () => {
    const { api } = fakeApi((id) => {
      if (id === "flaky") throw apiError(503);
      return headersFor(id);
    });
    const { messages, skipped } = await scanSendersWith(api, "primary", ["a", "flaky"], { ...fast, attempts: 2 });
    assert.equal(skipped, 1);
    assert.equal(messages.length, 1);
  });

  it("retries a rate-limit 403 and succeeds (regression)", async () => {
    const { api } = fakeApi((id, attempt) => {
      if (attempt < 3) throw apiError(403, "userRateLimitExceeded", "User-rate limit exceeded.");
      return headersFor(id);
    });
    const { messages, skipped } = await scanSendersWith(api, "primary", ["a"], fast);
    assert.equal(skipped, 0);
    assert.equal(messages.length, 1);
  });

  it("honours Gmail's 'Retry after' hint when waiting", async () => {
    const waits: number[] = [];
    const retryAt = new Date(Date.now() + 5_000).toISOString();
    const { api } = fakeApi((id, attempt) => {
      if (attempt === 1) throw apiError(403, "userRateLimitExceeded", `User-rate limit exceeded.  Retry after ${retryAt}`);
      return headersFor(id);
    });
    await scanSendersWith(api, "primary", ["a"], { sleep: async (ms) => { waits.push(ms); } });
    assert.equal(waits.length, 1);
    assert.ok(waits[0]! > 3_000 && waits[0]! <= 5_000, `waited ${waits[0]}ms`);
  });

  it("FAILS the scan if rate limiting persists, instead of returning an empty report (regression)", async () => {
    const { api } = fakeApi(() => {
      throw apiError(403, "userRateLimitExceeded", "User-rate limit exceeded.");
    });
    await assert.rejects(scanSendersWith(api, "primary", ["a", "b", "c"], { ...fast, attempts: 2 }), /rate limit/i);
  });

  it("fails immediately on a real permission 403, without retrying", async () => {
    const { api, calls } = fakeApi(() => {
      throw apiError(403, "insufficientPermissions", "Insufficient Permission");
    });
    await assert.rejects(scanSendersWith(api, "primary", ["a"], fast), /Insufficient Permission/);
    assert.equal(calls.length, 1);
  });

  it("fails on an expired sign-in (invalid_grant)", async () => {
    const { api } = fakeApi(() => {
      throw Object.assign(new Error("invalid_grant"), { response: { status: 400, data: { error: "invalid_grant" } } });
    });
    await assert.rejects(scanSendersWith(api, "primary", ["a"], fast), /invalid_grant/);
  });
});

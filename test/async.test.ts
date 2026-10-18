import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffMs, createRateLimiter, mapLimit, withRetry } from "../src/async.js";

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
const noSleep = async () => {};

describe("mapLimit", () => {
  it("keeps results in input order", async () => {
    const out = await mapLimit([5, 1, 3], 2, async (n) => {
      await tick(n);
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 30]);
  });

  it("never runs more than `limit` at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit([...Array(40).keys()], 4, async () => {
      peak = Math.max(peak, ++inFlight);
      await tick(2);
      inFlight--;
    });
    assert.equal(peak, 4);
  });

  it("handles an empty list", async () => assert.deepEqual(await mapLimit([], 4, async (x) => x), []));

  it("rethrows the first error and stops starting new work", async () => {
    let started = 0;
    await assert.rejects(
      mapLimit([...Array(100).keys()], 2, async (n) => {
        started++;
        await tick();
        if (n === 3) throw new Error("boom");
      }),
      /boom/,
    );
    await tick(20);
    assert.ok(started < 10, `expected the run to stop early, but ${started} items started`);
  });
});

describe("withRetry", () => {
  it("returns on first success without retrying", async () => {
    let calls = 0;
    assert.equal(await withRetry(async () => ++calls, () => true, { sleep: noSleep }), 1);
    assert.equal(calls, 1);
  });

  it("retries retryable errors, then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (++calls < 3) throw new Error("transient");
        return "ok";
      },
      () => true,
      { sleep: noSleep },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("does not retry when shouldRetry says no", async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw new Error("fatal"); }, () => false, { sleep: noSleep }), /fatal/);
    assert.equal(calls, 1);
  });

  it("gives up after `attempts` tries", async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw new Error("still failing"); }, () => true, { attempts: 3, sleep: noSleep }));
    assert.equal(calls, 3);
  });

  it("uses delayMs when it returns a number, backoff otherwise", async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRetry(
      async () => { if (++calls < 3) throw new Error("x"); },
      () => true,
      { sleep: async (ms) => { waits.push(ms); }, delayMs: (_e, attempt) => (attempt === 1 ? 1234 : undefined) },
    );
    assert.equal(waits[0], 1234);
    assert.ok(waits[1]! >= 2000 && waits[1]! < 2250, `attempt 2 backoff was ${waits[1]}`);
  });
});

describe("backoffMs", () => {
  it("doubles each attempt (with < 250ms jitter)", () => {
    for (const [attempt, base] of [[1, 1000], [2, 2000], [3, 4000], [4, 8000]] as const) {
      const ms = backoffMs(attempt);
      assert.ok(ms >= base && ms < base + 250, `attempt ${attempt}: ${ms}`);
    }
  });
});

describe("createRateLimiter", () => {
  // A fake clock: sleep() advances time instantly, so the test runs in milliseconds.
  const fakeClock = () => {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it("spaces request starts to the configured rate", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter(10, clock); // one start every 100ms
    const starts: number[] = [];
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
      starts.push(clock.now());
    }
    assert.deepEqual(starts.map((s) => s - starts[0]!), [0, 100, 200, 300, 400]);
  });

  it("queues concurrent callers instead of letting them start together", async () => {
    const waits: number[] = []; // how long each caller was told to wait
    const limiter = createRateLimiter(20, { now: () => 1_000_000, sleep: async (ms) => { waits.push(ms); } }); // every 50ms
    await Promise.all([...Array(4)].map(() => limiter.acquire()));
    assert.deepEqual(waits, [50, 100, 150]); // the first caller starts immediately (no wait)
  });

  it("pauseFor holds back every later request (regression: retries kept re-triggering the throttle)", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter(100, clock);
    await limiter.acquire();
    const pausedAt = clock.now();
    limiter.pauseFor(5_000);
    await limiter.acquire();
    assert.ok(clock.now() - pausedAt >= 5_000);
  });
});

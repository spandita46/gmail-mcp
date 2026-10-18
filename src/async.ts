// Generic async helpers: no Gmail, no MCP.

const RETRY_ATTEMPTS = 4; // total tries, including the first
const RETRY_BASE_MS = 500; // first backoff delay, doubled on each retry
const RETRY_JITTER_MS = 250; // random extra delay, so parallel retries don't line up

// Run async work over many items, but at most `limit` at a time.
// Gmail rate-limits per user, so firing 300 requests at once would hit 429 errors.
// If any call throws, the other workers stop taking new items and the error is rethrown.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  // Start `limit` workers. Each one keeps taking the next unprocessed index until none are left.
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++; // safe: JavaScript is single-threaded, so no two workers get the same i
      try {
        results[i] = await fn(items[i]!);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry failures that `shouldRetry` accepts, with exponential backoff and jitter: about 0.5s, 1s, 2s.
export async function withRetry<T>(fn: () => Promise<T>, shouldRetry: (err: unknown) => boolean): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY_ATTEMPTS || !shouldRetry(err)) throw err;
      await wait(RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * RETRY_JITTER_MS);
    }
  }
}

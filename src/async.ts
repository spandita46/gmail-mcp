// Generic async helpers: no Gmail, no MCP.

const RETRY_ATTEMPTS = 5; // total tries, including the first
const RETRY_BASE_MS = 1000; // first backoff delay, doubled on each retry: ~1s, 2s, 4s, 8s
const RETRY_JITTER_MS = 250; // random extra delay, so parallel retries don't line up

export interface RetryOptions {
  attempts?: number; // total tries, including the first
  // How long to wait before the next try. Return undefined to use exponential backoff.
  // Lets callers honour a server's "retry after" hint without this module knowing about Google.
  delayMs?: (err: unknown, attempt: number) => number | undefined;
  sleep?: (ms: number) => Promise<void>; // injectable so tests don't actually wait
}

// Run async work over many items, but at most `limit` at a time.
// Gmail rate-limits per user, so firing hundreds of requests at once gets throttled.
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

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function backoffMs(attempt: number): number {
  return RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * RETRY_JITTER_MS;
}

// Retry failures that `shouldRetry` accepts, waiting between tries.
export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  const sleep = options.sleep ?? wait;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      await sleep(options.delayMs?.(err, attempt) ?? backoffMs(attempt));
    }
  }
}

// Pure helpers for the cleanup report: no network, no MCP. Easy to test.

// Run async work over many items, but at most `limit` at a time.
// Gmail rate-limits per user, so firing 300 requests at once would hit 429 errors.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // Start `limit` workers. Each one keeps taking the next unprocessed index until none are left.
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++; // safe: JavaScript is single-threaded, so no two workers get the same i
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// "Cobone Dubai <emails@m.cobone.com>" → { name: "Cobone Dubai", address: "emails@m.cobone.com" }
export function parseSender(from: string): { name: string; address: string } {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const address = match[2]!.trim().toLowerCase();
    return { name: match[1]!.trim() || address, address };
  }
  const address = from.trim().toLowerCase();
  return { name: address, address };
}

export interface Unsubscribe {
  url?: string;      // https link, opened in a browser
  mailto?: string;   // send-an-email style unsubscribe
  oneClick: boolean; // RFC 8058: the sender supports one-click unsubscribe
}

// List-Unsubscribe: "<https://x.com/u?id=1>, <mailto:unsub@x.com?subject=unsubscribe>"
export function parseListUnsubscribe(header: string, postHeader: string): Unsubscribe | undefined {
  if (!header) return undefined;
  const entries = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  const url = entries.find((e) => /^https:\/\//i.test(e));
  const mailto = entries.find((e) => /^mailto:/i.test(e));
  if (!url && !mailto) return undefined;
  return {
    ...(url ? { url } : {}),
    ...(mailto ? { mailto } : {}),
    oneClick: /List-Unsubscribe=One-Click/i.test(postHeader),
  };
}

export interface ScannedMessage {
  account: string;
  from: string;
  date: string;
  listUnsubscribe: string;
  listUnsubscribePost: string;
}

export interface SenderStats {
  address: string;
  name: string;
  total: number;
  byAccount: Record<string, number>;
  latest: string; // Date header of the newest message seen
  unsubscribe?: Unsubscribe;
  gmailQuery: string; // paste into Gmail search to see or bulk-select them
}

// Group scanned messages by sender address and rank by volume.
export function aggregateSenders(messages: ScannedMessage[], top: number): SenderStats[] {
  const bySender = new Map<string, SenderStats & { latestMs: number }>();
  for (const m of messages) {
    const { name, address } = parseSender(m.from);
    if (!address) continue;
    const ms = Date.parse(m.date) || 0;
    const stats =
      bySender.get(address) ??
      { address, name, total: 0, byAccount: {}, latest: m.date, latestMs: ms, gmailQuery: `from:${address}` };
    stats.total += 1;
    stats.byAccount[m.account] = (stats.byAccount[m.account] ?? 0) + 1;
    if (ms >= stats.latestMs) {
      stats.latest = m.date;
      stats.latestMs = ms;
    }
    // Keep the first unsubscribe option we find for this sender.
    stats.unsubscribe ??= parseListUnsubscribe(m.listUnsubscribe, m.listUnsubscribePost);
    bySender.set(address, stats);
  }
  return [...bySender.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, top)
    .map(({ latestMs: _drop, ...rest }) => rest); // drop the internal sort helper
}

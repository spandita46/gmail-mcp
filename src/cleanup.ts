// Pure helpers for the cleanup report: no network, no MCP. Easy to test.

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

// Header values are written by the sender, so treat them as untrusted text: remove control
// characters (newlines included, so a header can't inject lines into the report), collapse
// whitespace, and cap the length.
export function cleanHeader(value: string, max = 200): string {
  const flat = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// "Cobone Dubai <emails@m.cobone.com>" → { name: "Cobone Dubai", address: "emails@m.cobone.com" }
export function parseSender(from: string): { name: string; address: string } {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const address = cleanHeader(match[2]!, 254).toLowerCase();
    return { name: cleanHeader(match[1]!, 80) || address, address };
  }
  const address = cleanHeader(from, 254).toLowerCase();
  return { name: address, address };
}

// Date headers often carry a trailing comment such as "(UTC)" that Date.parse rejects.
// Returns undefined when the date still can't be read.
export function parseDate(header: string): number | undefined {
  const ms = Date.parse(header.replace(/\s*\([^)]*\)\s*$/, ""));
  return Number.isNaN(ms) ? undefined : ms;
}

export interface Unsubscribe {
  url?: string;      // https link, opened in a browser
  mailto?: string;   // send-an-email style unsubscribe
  oneClick: boolean; // RFC 8058: the sender supports one-click unsubscribe
}

// Links longer than this are dropped rather than truncated, since a cut-off link is broken.
const MAX_LINK = 1000;

// Accept a link only if it parses, uses the expected scheme, and has no whitespace or control
// characters. Returns the normalised form so what we show is what a browser would open.
function safeLink(raw: string, protocol: "https:" | "mailto:"): string | undefined {
  if (raw.length > MAX_LINK || /[\s\p{Cc}\p{Cf}]/u.test(raw)) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === protocol ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// List-Unsubscribe: "<https://x.com/u?id=1>, <mailto:unsub@x.com?subject=unsubscribe>"
export function parseListUnsubscribe(header: string, postHeader: string): Unsubscribe | undefined {
  if (!header) return undefined;
  const entries = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  const url = entries.map((e) => safeLink(e, "https:")).find(Boolean);
  const mailto = entries.map((e) => safeLink(e, "mailto:")).find(Boolean);
  if (!url && !mailto) return undefined;
  return {
    ...(url ? { url } : {}),
    ...(mailto ? { mailto } : {}),
    // RFC 8058 one-click only applies to an https link.
    oneClick: !!url && /List-Unsubscribe=One-Click/i.test(postHeader),
  };
}

// One-click https link > plain https link > mailto only.
function unsubscribeRank(u: Unsubscribe): number {
  return u.url ? (u.oneClick ? 3 : 2) : 1;
}

// Keep the best unsubscribe option seen across a sender's messages. On a tie the existing one
// (from a newer message) wins. A mailto from either side is kept as a fallback.
export function mergeUnsubscribe(current: Unsubscribe | undefined, next: Unsubscribe | undefined): Unsubscribe | undefined {
  if (!current || !next) return current ?? next;
  const [best, other] = unsubscribeRank(next) > unsubscribeRank(current) ? [next, current] : [current, next];
  const mailto = best.mailto ?? other.mailto;
  return { ...best, ...(mailto ? { mailto } : {}) };
}

export interface ScannedMessage {
  account: string;
  from: string;
  date: string;
  internalDate?: number; // Gmail's own receive time (ms since epoch), more reliable than the Date header
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
    const date = cleanHeader(m.date, 80);
    const ms = m.internalDate ?? parseDate(m.date);
    // Messages arrive newest first, so a sender whose dates are all unreadable keeps the first one seen.
    const stats =
      bySender.get(address) ??
      { address, name, total: 0, byAccount: {}, latest: date, latestMs: ms ?? -Infinity, gmailQuery: `from:${address}` };
    stats.total += 1;
    stats.byAccount[m.account] = (stats.byAccount[m.account] ?? 0) + 1;
    if (ms !== undefined && ms > stats.latestMs) {
      stats.latest = date || new Date(ms).toISOString();
      stats.latestMs = ms;
    }
    stats.unsubscribe = mergeUnsubscribe(stats.unsubscribe, parseListUnsubscribe(m.listUnsubscribe, m.listUnsubscribePost));
    bySender.set(address, stats);
  }
  return [...bySender.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, top)
    .map(({ latestMs: _drop, ...rest }) => rest); // drop the internal sort helper
}

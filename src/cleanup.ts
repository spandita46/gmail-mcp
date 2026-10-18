// Pure helpers for the cleanup report: no network, no MCP. Easy to test.
import { z } from "zod";

// Length caps for sender-controlled header text shown in the report.
const MAX_HEADER = 200; // default for any header value
const MAX_NAME = 80; // From display name
const MAX_ADDRESS = 254; // longest valid email address (RFC 5321)
const MAX_DATE = 80; // Date header
const MAX_LINK = 1000; // unsubscribe links; longer ones are dropped, since a cut-off link is broken
// A plain address with no spaces, quotes or brackets: safe to drop straight into a Gmail search.
const PLAIN_ADDRESS = /^[^\s@"()<>]+@[^\s@"()<>]+$/;

// The headers gmail.ts fetches for each message; the input to aggregateSenders.
export interface ScannedMessage {
  account: string;
  from: string;
  date: string;
  internalDate?: number; // Gmail's own receive time (ms since epoch), more reliable than the Date header
  listUnsubscribe: string;
  listUnsubscribePost: string;
}

// Schemas are the source of truth: the cleanup_report tool uses them as its outputSchema,
// and the TypeScript types are derived from them.
export const UnsubscribeSchema = z.object({
  url: z.string().optional(),    // https link, opened in a browser
  mailto: z.string().optional(), // send-an-email style unsubscribe
  oneClick: z.boolean(),         // RFC 8058: the sender supports one-click unsubscribe
});
export type Unsubscribe = z.infer<typeof UnsubscribeSchema>;

export const SenderStatsSchema = z.object({
  address: z.string(),
  name: z.string(),
  total: z.number(),
  byAccount: z.record(z.string(), z.number()),
  latest: z.string(), // Date header of the newest message seen
  unsubscribe: UnsubscribeSchema.optional(),
  gmailQuery: z.string(), // paste into Gmail search to see or bulk-select them
});
export type SenderStats = z.infer<typeof SenderStatsSchema>;

// Header values are written by the sender, so treat them as untrusted text: remove control
// characters (newlines included, so a header can't inject lines into the report), collapse
// whitespace, and cap the length.
export function cleanHeader(value: string, max = MAX_HEADER): string {
  const flat = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// "Cobone Dubai <emails@m.cobone.com>" → { name: "Cobone Dubai", address: "emails@m.cobone.com" }
export function parseSender(from: string): { name: string; address: string } {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const address = cleanHeader(match[2]!, MAX_ADDRESS).toLowerCase();
    return { name: cleanHeader(match[1]!, MAX_NAME) || address, address };
  }
  const address = cleanHeader(from, MAX_ADDRESS).toLowerCase();
  return { name: address, address };
}

// Date headers often carry a trailing comment such as "(UTC)" that Date.parse rejects.
// Returns undefined when the date still can't be read.
export function parseDate(header: string): number | undefined {
  const ms = Date.parse(header.replace(/\s*\([^)]*\)\s*$/, ""));
  return Number.isNaN(ms) ? undefined : ms;
}

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

// A Gmail search for this sender. Anything that isn't a plain address is quoted, so text like
// "a@b.com OR in:anywhere" stays one search term instead of becoming extra Gmail operators.
function gmailFromQuery(address: string): string {
  return PLAIN_ADDRESS.test(address) ? `from:${address}` : `from:"${address.replace(/"/g, "")}"`;
}

// Group scanned messages by sender address and rank by volume.
export function aggregateSenders(messages: ScannedMessage[], top: number): SenderStats[] {
  const bySender = new Map<string, SenderStats & { latestMs: number }>();
  for (const m of messages) {
    const { name, address } = parseSender(m.from);
    if (!address) continue;
    const date = cleanHeader(m.date, MAX_DATE);
    const ms = m.internalDate ?? parseDate(m.date);
    // Messages arrive newest first, so a sender whose dates are all unreadable keeps the first one seen.
    const stats =
      bySender.get(address) ??
      { address, name, total: 0, byAccount: {}, latest: date, latestMs: -Infinity, gmailQuery: gmailFromQuery(address) };
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

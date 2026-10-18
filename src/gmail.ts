import { gmail, type gmail_v1 } from "@googleapis/gmail";
import { z } from "zod";
import { mapLimit, withRetry, type RetryOptions } from "./async.js";
import type { ScannedMessage } from "./cleanup.js";
import { type Account, createOAuthClient } from "./config.js";
import { httpStatus, isRateLimited, isTransient, retryAfterMs } from "./google-errors.js";
import { cleanText, extractMessage, ExtractedMessageSchema } from "./mime.js";
import { loadToken } from "./tokens.js";

const LIST_PAGE_SIZE = 500; // the most ids Gmail returns per messages.list page
// Parallel requests per account. Gmail allows ~250 quota units/s per user and messages.get costs 5,
// so ~50 requests/s at most. 10 in parallel overshot that in testing (a 1000-message scan got throttled).
const SCAN_CONCURRENCY = 4;

export interface GmailClient {
  api: gmail_v1.Gmail;
  email: string; // the mailbox this client signs in to
}

// The schemas are the source of truth; the tools use them in their outputSchema.
export const MessageSummarySchema = z.object({
  id: z.string(),
  threadId: z.string(),
  date: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  snippet: z.string(),
  unread: z.boolean(),
  labels: z.array(z.string()),
});
export type MessageSummary = z.infer<typeof MessageSummarySchema>;

export const FullMessageSchema = ExtractedMessageSchema.extend({
  id: z.string(),
  threadId: z.string(),
  labels: z.array(z.string()),
});
export type FullMessage = z.infer<typeof FullMessageSchema>;

export interface SearchResult {
  messages: MessageSummary[];
  resultSizeEstimate: number; // Gmail's *estimate* of total matches, not exact
  nextPageToken?: string; // present when there are more results
}

// One client per account, created on first use and kept for the life of the process.
// Each OAuth2Client caches its own 1-hour access token, so reusing it avoids a token
// refresh on every tool call.
const clients = new Map<Account, GmailClient>();

export function gmailFor(account: Account): GmailClient {
  const cached = clients.get(account);
  if (cached) return cached;

  const stored = loadToken(account);
  if (!stored) {
    throw new Error(
      `Account "${account}" is not linked yet. Run in the project folder: npm run auth -- ${account}`,
    );
  }

  // No redirectUri: the server never runs the browser flow, it only refreshes.
  // No access_token yet. The first API call will notice, get one with the
  // refresh token, and refresh it again whenever it expires.
  const auth = createOAuthClient();
  auth.setCredentials({ refresh_token: stored.refreshToken });

  const entry = { api: gmail({ version: "v1", auth }), email: stored.email };
  clients.set(account, entry);
  return entry;
}

// Drop a cached client, e.g. after its token died. The next call reloads from
// Keychain, which picks up a fresh `npm run auth` without restarting Claude.
export function resetClient(account: Account): void {
  clients.delete(account);
}

// Header names are case-insensitive in email, so compare in lowercase.
function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === wanted)?.value ?? "";
}

export async function searchMessages(
  account: Account,
  query: string,
  maxResults: number,
  pageToken?: string,
): Promise<SearchResult> {
  const { api } = gmailFor(account);

  // 1 call: matching IDs only (newest first). userId "me" = the token's own mailbox.
  const list = await api.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
    pageToken,
  });
  // flatMap filters out missing ids and narrows the type to string[] in one step.
  const ids = (list.data.messages ?? []).flatMap((m) => (m.id ? [m.id] : []));

  // N calls in parallel: only the headers we need. format "metadata" skips the
  // body, which keeps responses small and fast.
  const details = await Promise.all(
    ids.map((id) =>
      api.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      }),
    ),
  );

  const messages = details.map(({ data }) => {
    const header = (name: string) => getHeader(data.payload?.headers, name);
    const labels = data.labelIds ?? [];
    return {
      id: data.id ?? "",
      threadId: data.threadId ?? "",
      date: header("Date"),
      from: header("From"),
      to: header("To"),
      subject: header("Subject") || "(no subject)",
      snippet: cleanText(data.snippet ?? ""),
      unread: labels.includes("UNREAD"), // read/unread is just a label in Gmail
      labels,
    };
  });

  return {
    messages,
    resultSizeEstimate: list.data.resultSizeEstimate ?? messages.length,
    // Conditional spread: only add the key when it exists, so it's absent rather than undefined.
    ...(list.data.nextPageToken
      ? { nextPageToken: list.data.nextPageToken }
      : {}),
  };
}

// format "full" returns the entire MIME tree, with bodies inline (base64url).
export async function getMessage(account: Account, id: string): Promise<FullMessage> {
  const { api } = gmailFor(account);
  const { data } = await api.users.messages.get({ userId: "me", id, format: "full" });
  return { id: data.id ?? id, threadId: data.threadId ?? "", labels: data.labelIds ?? [], ...extractMessage(data.payload) };
}

// One call returns every message in the conversation, oldest first.
export async function getThread(account: Account, threadId: string): Promise<FullMessage[]> {
  const { api } = gmailFor(account);
  const { data } = await api.users.threads.get({ userId: "me", id: threadId, format: "full" });
  return (data.messages ?? []).map((m) => ({
    id: m.id ?? "",
    threadId: m.threadId ?? threadId,
    labels: m.labelIds ?? [],
    ...extractMessage(m.payload),
  }));
}

// Collect up to `max` message ids for a query, following nextPageToken
// (Gmail returns at most LIST_PAGE_SIZE ids per page). Pages must be fetched one after another,
// because each request needs the previous page's token.
// `complete` is true when every match was collected. `estimate` is Gmail's rough total and
// only matters when the list was cut off at `max`.
export async function listMessageIds(
  account: Account,
  query: string,
  max: number,
): Promise<{ ids: string[]; estimate: number; complete: boolean }> {
  const { api } = gmailFor(account);
  const ids: string[] = [];
  let pageToken: string | undefined;
  let estimate = 0;
  do {
    const { data } = await api.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(LIST_PAGE_SIZE, max - ids.length),
      pageToken,
    });
    estimate = data.resultSizeEstimate ?? estimate;
    for (const m of data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < max);
  const complete = !pageToken && ids.length <= max;
  const kept = ids.slice(0, max);
  return { ids: kept, estimate: complete ? kept.length : Math.max(estimate, kept.length), complete };
}

// Fetch just the headers the cleanup report needs, SCAN_CONCURRENCY requests at a time.
export async function scanSenders(
  account: Account,
  ids: string[],
): Promise<{ messages: ScannedMessage[]; skipped: number }> {
  return scanSendersWith(gmailFor(account).api, account, ids);
}

// The testable core of scanSenders: takes the Gmail API object, so tests can pass a fake.
// How failures are handled:
//   • 404 (deleted since the list call) or a 5xx that outlasts the retries → skip that message
//   • rate limit (429, or 403 userRateLimitExceeded) → retry, honouring Gmail's "Retry after" hint;
//     if it still fails, fail the whole scan: throttling hits every request, so skipping would
//     silently return an empty report
//   • anything else (expired sign-in, real 403) → fail the scan
export async function scanSendersWith(
  api: gmail_v1.Gmail,
  account: Account,
  ids: string[],
  retry: RetryOptions = {},
): Promise<{ messages: ScannedMessage[]; skipped: number }> {
  const results = await mapLimit(ids, SCAN_CONCURRENCY, async (id): Promise<ScannedMessage | undefined> => {
    try {
      const { data } = await withRetry(
        () =>
          api.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "Date", "List-Unsubscribe", "List-Unsubscribe-Post"],
          }),
        isTransient,
        { delayMs: (err) => retryAfterMs(err), ...retry },
      );
      const header = (name: string) => getHeader(data.payload?.headers, name);
      const internalDate = Number(data.internalDate);
      return {
        account,
        from: header("From"),
        date: header("Date"),
        ...(Number.isFinite(internalDate) && internalDate > 0 ? { internalDate } : {}),
        listUnsubscribe: header("List-Unsubscribe"),
        listUnsubscribePost: header("List-Unsubscribe-Post"),
      };
    } catch (err) {
      if (httpStatus(err) === 404 || (isTransient(err) && !isRateLimited(err))) return undefined;
      throw err;
    }
  });
  const messages = results.filter((m): m is ScannedMessage => m !== undefined);
  return { messages, skipped: results.length - messages.length };
}

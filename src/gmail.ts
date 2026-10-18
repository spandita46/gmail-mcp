import { gmail, type gmail_v1 } from "@googleapis/gmail";
import { type Account, createOAuthClient, loadToken } from "./config.js";
import { cleanText, extractMessage, type ExtractedMessage } from "./mime.js";
import { mapLimit, type ScannedMessage } from "./cleanup.js";

// One client per account, created on first use and kept for the life of the process.
// Each OAuth2Client caches its own 1-hour access token, so reusing it avoids a token
// refresh on every tool call.
const clients = new Map<Account, { api: gmail_v1.Gmail; email: string }>();

export function gmailFor(account: Account): {
  api: gmail_v1.Gmail;
  email: string;
} {
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

export interface MessageSummary {
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  unread: boolean;
  labels: string[];
}

export interface SearchResult {
  messages: MessageSummary[];
  resultSizeEstimate: number; // Gmail's *estimate* of total matches, not exact
  nextPageToken?: string; // present when there are more results
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

// Turn Google/HTTP errors into messages that tell you what to do next.
// Two shapes reach here:
//   • token endpoint errors: response.data.error is a string, e.g. "invalid_grant"
//   • Gmail API errors:      response.status is 403 / 429, data.error is an object
export function describeGoogleError(err: unknown, account: Account): string {
  const e = err as {
    message?: string;
    status?: number;
    response?: {
      status?: number;
      data?: { error?: unknown; error_description?: string };
    };
  };
  const status = e.response?.status ?? e.status;
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

export interface FullMessage extends ExtractedMessage {
  id: string;
  threadId: string;
  labels: string[];
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
// (Gmail returns at most 500 ids per page). Pages must be fetched one after another,
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
      maxResults: Math.min(500, max - ids.length),
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

function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const status = e.response?.status ?? e.status ?? e.code;
  return typeof status === "number" ? status : undefined;
}

// 429 and 5xx are usually temporary, so they are worth retrying.
function isTransient(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry temporary failures with exponential backoff and jitter: about 0.5s, 1s, 2s.
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransient(httpStatus(err))) throw err;
      await wait(500 * 2 ** (attempt - 1) + Math.random() * 250);
    }
  }
}

// Fetch just the headers the cleanup report needs, 10 requests at a time.
// One bad message shouldn't sink the whole scan: a message deleted since the list call (404),
// or one that keeps failing with 429/5xx after retries, is counted in `skipped`.
// Other errors (expired sign-in, 403) affect every request, so they still fail the scan.
export async function scanSenders(
  account: Account,
  ids: string[],
): Promise<{ messages: ScannedMessage[]; skipped: number }> {
  const { api } = gmailFor(account);
  const results = await mapLimit(ids, 10, async (id): Promise<ScannedMessage | undefined> => {
    try {
      const { data } = await withRetry(() =>
        api.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "Date", "List-Unsubscribe", "List-Unsubscribe-Post"],
        }),
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
      const status = httpStatus(err);
      if (status === 404 || isTransient(status)) return undefined;
      throw err;
    }
  });
  const messages = results.filter((m): m is ScannedMessage => m !== undefined);
  return { messages, skipped: results.length - messages.length };
}

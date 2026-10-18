import { z } from "zod";
import type { Account } from "../config.js";
import {
  describeGoogleError,
  resetClient,
  type MessageSummary,
} from "../gmail.js";
import { localMidnightEpoch, TIME_ZONE } from "../time.js";

export const LocalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

//Shared parameter definitions, so both tools describe them the same way to Claude.
export const sinceParam = LocalDate.optional().describe(
  `Only messages on or after this date (YYYY-MM-DD), counted from local midnight in ${TIME_ZONE}. ` +
    "Prefer this over after:/newer_than: in the query for exact day boundaries, e.g. 'today'.",
);

export const untilParam = LocalDate.optional().describe(
  `Only messages before this date (YYYY-MM-DD, exclusive), counted from local midnight in ${TIME_ZONE}.`,
);

export const queryParam = z
  .string()
  .describe(
    'Gmail search query, same syntax as the Gmail search box. Examples: "from:amazon newer_than:7d", ' +
      '"is:unread label:inbox", "subject:invoice", "has:attachment filename:pdf". May be empty when since/until are given.',
  );

export const MessageSchema = z.object({
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

// Claude's query plus exact epoch boundaries (moved here from search-mail.ts).
export function buildQuery(
  userQuery: string,
  since?: string,
  until?: string,
): string {
  return [
    userQuery,
    since ? `after:${localMidnightEpoch(since)}` : "",
    until ? `before:${localMidnightEpoch(until)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// The numbered text list both tools return.
export function formatMessages(messages: MessageSummary[]): string[] {
  return messages.map(
    (m, i) =>
      `${i + 1}. ${m.unread ? "[UNREAD] " : ""}${m.subject}\n   From: ${m.from}\n   Date: ${m.date}\n   id: ${m.id}\n   ${m.snippet}`,
  );
}

// One place for "turn any failure into a clear message". It also drops the cached
// client, so a re-auth takes effect without restarting Claude.
export function toolErrorMessage(err: unknown, account: Account): string {
  resetClient(account);
  return err instanceof Error && !("response" in err)
    ? err.message
    : describeGoogleError(err, account);
}

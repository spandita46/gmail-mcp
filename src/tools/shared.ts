import { z } from "zod";
import { TIME_ZONE, type Account } from "../config.js";
import { resetClient, type MessageSummary } from "../gmail.js";
import { describeGoogleError } from "../google-errors.js";
import { localMidnightEpoch } from "../time.js";

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

// Call this when a request for an account fails. It does two things:
//   1. drops the account's cached client, so a re-auth takes effect without restarting Claude
//   2. returns a clear message describing the failure
export function handleAccountError(err: unknown, account: Account): string {
  resetClient(account);
  return err instanceof Error && !("response" in err)
    ? err.message
    : describeGoogleError(err, account);
}

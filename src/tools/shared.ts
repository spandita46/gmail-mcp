import { z } from "zod";
import { TIME_ZONE, type Account } from "../config.js";
import { resetClient, type MessageSummary } from "../gmail.js";
import { describeGoogleError } from "../google-errors.js";
import { localMidnightEpoch } from "../time.js";
import { linkedAccounts } from "../tokens.js";

export const NO_LINKED_ACCOUNTS = "No linked accounts match. Run: npm run auth -- <alias>";

// The result of one account's work in runPerAccount: its value, or a readable error.
export type AccountOutcome<T> =
  | { account: Account; email: string; ok: true; value: T }
  | { account: Account; email: string; ok: false; error: string };

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
  const trimmed = userQuery.trim();
  return [
    // Parentheses keep the date filters applying to the whole query, e.g. "from:a OR from:b".
    trimmed ? `(${trimmed})` : "",
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

// A text-only error result. Some hosts drop or reject structuredContent on an error,
// so everything the user needs to know must be in the text.
export function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// Run `work` for every linked account (or only the `selected` ones) in parallel.
// One account failing doesn't affect the others: each outcome is reported separately.
// Returns an empty array when no linked account matches; callers return NO_LINKED_ACCOUNTS then.
export async function runPerAccount<T>(
  tool: string,
  selected: readonly Account[] | undefined,
  work: (account: Account) => Promise<T>,
): Promise<AccountOutcome<T>[]> {
  const targets = linkedAccounts().filter((a) => !selected || selected.includes(a.account));
  // Only the tool and accounts are logged: queries can contain personal search terms.
  console.error(`[gmail-multi] ${tool} accounts=${targets.map((t) => t.account).join(",") || "none"}`);

  // allSettled, NOT all: Promise.all rejects as soon as ONE account fails and you lose
  // the others' results. allSettled waits for every account and reports each outcome.
  const settled = await Promise.allSettled(targets.map((t) => work(t.account)));

  // settled[i] lines up with targets[i] (same order as the array we passed in).
  return settled.map((outcome, i) => {
    const { account, email } = targets[i]!; // "!" because index access could be undefined under strict settings
    return outcome.status === "fulfilled"
      ? { account, email, ok: true, value: outcome.value }
      : { account, email, ok: false, error: handleAccountError(outcome.reason, account) };
  });
}

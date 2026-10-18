import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ACCOUNTS, linkedAccounts } from "../config.js";
import { aggregateSenders, type ScannedMessage } from "../cleanup.js";
import { listMessageIds, scanSenders } from "../gmail.js";
import { toolErrorMessage } from "./shared.js";

const SenderSchema = z.object({
  address: z.string(),
  name: z.string(),
  total: z.number(),
  byAccount: z.record(z.string(), z.number()),
  latest: z.string(),
  unsubscribe: z.object({ url: z.string().optional(), mailto: z.string().optional(), oneClick: z.boolean() }).optional(),
  gmailQuery: z.string(),
});

const ScanSchema = z.object({
  account: z.string(),
  email: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  scanned: z.number(),
  estimate: z.number(),
});

export function registerCleanupReport(server: McpServer): void {
  server.registerTool(
    "cleanup_report",
    {
      title: "Cleanup Report",
      description:
        "Find which senders fill the user's inboxes. Scans recent messages (default: Promotions, last 90 days) across linked accounts, " +
        "groups them by sender, ranks by volume, and returns each sender's unsubscribe link (from the List-Unsubscribe header) " +
        "and a Gmail search query to bulk-select their emails. Read-only: it never unsubscribes, deletes or changes anything. " +
        "Present unsubscribe links for the user to open themselves; never open them on your own.",
      inputSchema: z.object({
        query: z
          .string()
          .default("category:promotions")
          .describe('Which emails to analyse, in Gmail search syntax. Default "category:promotions". Other useful ones: "category:updates", "in:inbox", "category:social".'),
        days: z.number().int().min(1).max(365).default(90).describe("Look back this many days (1–365)."),
        accounts: z.array(z.enum(ACCOUNTS)).min(1).optional().describe("Limit to these aliases. Omit for all linked accounts."),
        maxScanPerAccount: z
          .number()
          .int()
          .min(50)
          .max(1000)
          .default(300)
          .describe("Maximum messages to scan per account (50–1000). Higher is more complete but slower."),
        top: z.number().int().min(5).max(50).default(15).describe("How many top senders to return (5–50)."),
      }),
      outputSchema: z.object({
        query: z.string(),
        accounts: z.array(ScanSchema),
        senders: z.array(SenderSchema),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query: userQuery, days, accounts, maxScanPerAccount, top }) => {
      const query = `${userQuery} newer_than:${days}d`.trim();
      const targets = linkedAccounts().filter((a) => !accounts || accounts.includes(a.account));
      console.error(`[gmail-multi] cleanup_report q="${query}" accounts=${targets.map((t) => t.account).join(",") || "none"}`);

      if (targets.length === 0) {
        return { content: [{ type: "text", text: "No linked accounts match. Run: npm run auth -- <alias>" }], isError: true };
      }

      // Accounts in parallel. Within each account, scanSenders limits itself to 10 requests at a time.
      const settled = await Promise.allSettled(
        targets.map(async (t) => {
          const { ids, estimate } = await listMessageIds(t.account, query, maxScanPerAccount);
          return { estimate, messages: await scanSenders(t.account, ids) };
        }),
      );

      const scanned: ScannedMessage[] = [];
      const accountSummaries = settled.map((outcome, i) => {
        const { account, email } = targets[i]!;
        if (outcome.status === "fulfilled") {
          scanned.push(...outcome.value.messages);
          return { account, email, ok: true, scanned: outcome.value.messages.length, estimate: outcome.value.estimate };
        }
        return { account, email, ok: false, error: toolErrorMessage(outcome.reason, account), scanned: 0, estimate: 0 };
      });

      const senders = aggregateSenders(scanned, top);

      const scanLines = accountSummaries.map((a) =>
        a.ok
          ? `- ${a.account} <${a.email}>: scanned ${a.scanned}${a.estimate > a.scanned ? ` of ~${a.estimate} (raise maxScanPerAccount for more)` : ""}`
          : `- ${a.account} <${a.email}>: ⚠️ ${a.error}`,
      );
      const senderLines = senders.map((s, i) => {
        const where = Object.entries(s.byAccount)
          .map(([acct, n]) => `${acct} ${n}`)
          .join(", ");
        const unsub = s.unsubscribe?.url
          ? `Unsubscribe: ${s.unsubscribe.url}${s.unsubscribe.oneClick ? " (one-click supported)" : ""}`
          : s.unsubscribe?.mailto
            ? `Unsubscribe by email: ${s.unsubscribe.mailto}`
            : "No unsubscribe header";
        return `${i + 1}. ${s.name} <${s.address}>: ${s.total} email(s) (${where}), latest ${s.latest}\n   ${unsub}\n   Gmail search: ${s.gmailQuery}`;
      });

      const text = [
        `Top senders for "${query}"`,
        ...scanLines,
        "",
        ...senderLines,
        "",
        "Unsubscribe links come from each sender's own email headers (the same ones Gmail's Unsubscribe button uses). Open them only for senders you recognise.",
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: { query, accounts: accountSummaries, senders },
        ...(accountSummaries.every((a) => !a.ok) ? { isError: true } : {}),
      };
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ACCOUNTS, linkedAccounts } from "../config.js";

export function registerListAccounts(server: McpServer): void {
  server.registerTool(
    "list_accounts",
    {
      title: "List Accounts",
      description:
        "Lists the Gmail account aliases this server knows about and which ones are linked, with their email addresses. " +
        "Use it to see which accounts can be searched, or when the user refers to an account by email address.",
      outputSchema: z.object({
        accounts: z.array(
          z.object({
            account: z.string(),
            linked: z.boolean(),
            email: z.string().optional(),
            linkedAt: z.string().optional(),
          }),
        ),
      }),
      // Keychain only, no network, so openWorld is false.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      // Map for quick lookup by alias. Then walk ACCOUNTS so unlinked aliases are listed too.
      const linked = new Map(linkedAccounts().map((a) => [a.account, a]));
      const accounts = ACCOUNTS.map((account) => {
        const info = linked.get(account);
        return info
          ? { account, linked: true, email: info.email, linkedAt: info.savedAt }
          : { account, linked: false };
      });
      const text = accounts
        .map((a) =>
          a.linked
            ? `✅ ${a.account}: ${a.email}`
            : `⛔ ${a.account}: not linked (npm run auth -- ${a.account})`,
        )
        .join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { accounts },
      };
    },
  );
}

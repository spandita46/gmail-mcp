import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerPing } from "./tools/ping.js";
import { registerServerTime } from "./tools/server-time.js";
import { registerListAccounts } from "./tools/list-accounts.js";
import { registerSearchMail } from "./tools/search-mail.js";
import { registerSearchAllAccounts } from "./tools/search-all.js";
import { registerReadMessage } from "./tools/read-message.js";
import { registerCleanupReport } from "./tools/cleanup-report.js";

serveStdio(() => {
  const server = new McpServer(
    // Server Info: Name and Version
    {
      name: "gmail-mcp",
      version: "0.2.0",
    },
    // Options
    // Capabilities for now
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Each tool lives in its own file under ./tools.
  registerPing(server);
  registerServerTime(server);
  registerListAccounts(server);
  registerSearchMail(server);
  registerSearchAllAccounts(server);
  registerReadMessage(server);
  registerCleanupReport(server);

  return server;
});

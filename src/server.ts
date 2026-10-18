import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { registerSearchMail } from "./tools/search-mail.js";
import { localToday, TIME_ZONE } from "./time.js";
import { registerListAccounts } from "./tools/list-accounts.js";
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

  server.registerTool(
    // Name of the  tool for claude to call. Use snake_case and keep it short and unique.
    "ping",

    // Tool Options - used to describe tool with description and its input schema
    {
      // Name for Human
      title: "Ping",
      // Important field - Claude reads this to decide when to use the tool.
      // Write it like a prompt
      description:
        "Health check for the Gmail MCP server. Echoes back the given message",
      // Input Schema
      // Every argument is checked before your handler runs,
      // .describe () text is passed to Claude too, so use it to explain each argument.
      inputSchema: z.object({
        message: z.string().describe("Any text to echo back"),
      }),
    },
    // Handler for the tool. It receives the checked, fully typed arguments(message: string).
    async ({ message }) => {
      // Log to STDERR only. stdout is the protocol channel, and console.log would corrupt it.
      console.error(`[gmail-mcp] ping called with: ${message}}`);

      // Tools return a list of content blocks.  "text" is the one you'll use most
      return {
        content: [{ type: "text", text: `pong: ${message}` }],
      };
    },
  );

  server.registerTool(
    "server_time",
    {
      title: "Server Time",
      description:
        "Returns the current date and time on the user's machine (America/Toronto). " +
        "Use it when you need today's date, e.g. to build Gmail date filters like after:2026/10/01.",

      // Describes the shape of the result. Clients can check it, and Claude gets typed data
      // instead of having to read meaning out of a string.
      outputSchema: z.object({
        timeZone: z.string(),
        today: z.string(),
        local: z.string(),
        iso: z.string(),
      }),

      // Hints to the client about how the tool behaves:
      // readOnlyHint: true    → changes nothing, so it's safe to call without asking
      // openWorldHint: false  → doesn't reach external systems
      // Your Gmail read tools will be readOnly: true, openWorld: true.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      console.error("[gmail-mcp] server_time called");
      const now = new Date();
      const output = {
        timeZone: TIME_ZONE,
        today: localToday(), // "2026-10-17", ready to pass straight into since/until
        local: now.toLocaleString("en-CA", {
          timeZone: TIME_ZONE,
          dateStyle: "full",
          timeStyle: "long",
        }),
        iso: now.toISOString(),
      };
      return {
        // for clients that only read text
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output, // must match outputSchema
      };
    },
  );
  registerListAccounts(server);
  registerSearchMail(server);
  registerSearchAllAccounts(server);
  registerReadMessage(server);
  registerCleanupReport(server);

  return server;
});

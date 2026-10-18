import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export function registerPing(server: McpServer): void {
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
      console.error(`[gmail-mcp] ping called with: ${message}`);

      // Tools return a list of content blocks.  "text" is the one you'll use most
      return {
        content: [{ type: "text", text: `pong: ${message}` }],
      };
    },
  );
}

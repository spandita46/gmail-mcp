import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TIME_ZONE } from "../config.js";
import { localToday } from "../time.js";

export function registerServerTime(server: McpServer): void {
  server.registerTool(
    "server_time",
    {
      title: "Server Time",
      description:
        `Returns the current date and time on the user's machine (${TIME_ZONE}). ` +
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
}

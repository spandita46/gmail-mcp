import { OAuth2Client } from "google-auth-library";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The four account aliases. "as const" makes this a tuple of literal types,
// so Account is the union "primary" | "secondary" | "work" | "other".
export const ACCOUNTS = ["primary", "secondary", "work", "other"] as const;
export type Account = (typeof ACCOUNTS)[number];

// A type guard: after isAccount(x) returns true, TypeScript treats x as an Account.
export function isAccount(value: string): value is Account {
  return (ACCOUNTS as readonly string[]).includes(value);
}

// All user-configurable settings live in this file. Env vars are set in claude_desktop_config.json.

// Time zone for since/until day boundaries and server_time.
export const TIME_ZONE = process.env.GMAIL_MCP_TZ ?? "America/Toronto";

// Read-only by design: no send, draft or modify permissions are ever requested.
export const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

// Default location is outside the repo. Can be overridden with an env var.
const CLIENT_FILE =
  process.env.GMAIL_MCP_CLIENT_FILE ??
  join(homedir(), ".config", "gmail-mcp", "client.json");

export function createOAuthClient(redirectUri?: string): OAuth2Client {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CLIENT_FILE, "utf8"));
  } catch (err) {
    throw new Error(
      `Could not read OAuth client file at ${CLIENT_FILE}: ${(err as Error).message}`,
    );
  }
  const installed = (
    raw as { installed?: { client_id?: string; client_secret?: string } }
  ).installed;
  if (!installed?.client_id || !installed.client_secret) {
    throw new Error(
      `${CLIENT_FILE} is not a "Desktop app" OAuth client (missing installed.client_id/client_secret)`,
    );
  }
  return new OAuth2Client({
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    redirectUri,
  });
}

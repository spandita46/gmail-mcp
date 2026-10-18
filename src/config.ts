import { Entry } from "@napi-rs/keyring";
import { OAuth2Client } from "google-auth-library";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// The four account aliases. "as const" makes this a tuple of literal types,
// so Account is the union "primary" | "secondary" | "work" | "other".
export const ACCOUNTS = ["primary", "secondary", "work", "other"] as const;
export type Account = (typeof ACCOUNTS)[number];

// A type guard: after isAccount(x) returns true, TypeScript treats x as an Account.
export function isAccount(value: string): value is Account {
  return (ACCOUNTS as readonly string[]).includes(value);
}

// Read-only for now. We'll add gmail.compose (drafts) in Milestone 7.
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

// Keychain layout: one item per account, with service "gmail-mcp" and account = alias.
const KEYCHAIN_SERVICE = "gmail-mcp";

// The schema is the source of truth. The TypeScript type is derived from it,
// so the two can't drift apart.
const StoredTokenSchema = z.object({
  refreshToken: z.string().min(1),
  email: z.string(),
  scopes: z.array(z.string()),
  savedAt: z.string(),
});
export type StoredToken = z.infer<typeof StoredTokenSchema>;

export function saveToken(account: Account, token: StoredToken): void {
  new Entry(KEYCHAIN_SERVICE, account).setPassword(JSON.stringify(token));
}

export function loadToken(account: Account): StoredToken | null {
  const value = new Entry(KEYCHAIN_SERVICE, account).getPassword();
  if (!value) return null; // no Keychain item, so this account isn't linked
  // safeParse returns { success, data | error } instead of throwing.
  const parsed = StoredTokenSchema.safeParse(JSON.parse(value));
  if (!parsed.success) {
    throw new Error(
      `Keychain item for "${account}" is malformed. Re-run: npm run auth -- ${account}`,
    );
  }
  return parsed.data;
}

export interface LinkedAccount {
  account: Account;
  email: string;
  savedAt: string;
}

// Every alias that has a usable Keychain item. A malformed item counts as
// "not linked" here instead of crashing the whole list.
export function linkedAccounts(): LinkedAccount[] {
  return ACCOUNTS.flatMap((account) => {
    try {
      const token = loadToken(account);
      return token
        ? [{ account, email: token.email, savedAt: token.savedAt }]
        : [];
    } catch {
      return [];
    }
  });
}

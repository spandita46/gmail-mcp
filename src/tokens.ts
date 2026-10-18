import { Entry } from "@napi-rs/keyring";
import { z } from "zod";
import { ACCOUNTS, type Account } from "./config.js";

// Refresh tokens are stored in the macOS Keychain, one item per account,
// with service "gmail-mcp" and account = alias.
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

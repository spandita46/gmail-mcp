import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CodeChallengeMethod } from "google-auth-library";
import { gmail } from "@googleapis/gmail";

// Note the ".js" extension: the ESM rule from earlier. The file on disk is config.ts.
import {
  ACCOUNTS,
  SCOPES,
  createOAuthClient,
  isAccount,
  loadToken,
  saveToken,
} from "./config.js";

// This is a CLI, not the MCP server, so console.log is fine here.
const account = process.argv[2];
const loginHint = process.argv[3]; // optional: preselects the account in Google's chooser

if (!account || !isAccount(account)) {
  console.error(`Usage: npm run auth -- <${ACCOUNTS.join("|")}> [email-hint]`);
  process.exit(1);
}

// 1. Start a loopback server. Port 0 lets the OS pick a free port.
// Top-level await works because this is an ES module.
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const redirectUri = `http://127.0.0.1:${port}`;

const client = createOAuthClient(redirectUri);

// 2. PKCE pair + random state
const { codeVerifier, codeChallenge } =
  await client.generateCodeVerifierAsync();
const state = randomBytes(16).toString("hex");

const authUrl = client.generateAuthUrl({
  access_type: "offline", // ask for a refresh token…
  prompt: "consent", // …and force the consent screen so Google actually sends one
  scope: SCOPES,
  state,
  code_challenge: codeChallenge,
  code_challenge_method: CodeChallengeMethod.S256,
  login_hint: loginHint,
});

console.log(`\nAuthorising "${account}". Opening your browser…`);
console.log(`If it doesn't open, visit:\n${authUrl}\n`);
execFile("open", [authUrl], () => {}); // ignore errors: the URL is printed above as a fallback

// 3. Wait for Google to redirect the browser back to us.
const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("Timed out after 5 minutes")),
    5 * 60_000,
  );

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== "/") {
      res.writeHead(404).end(); // e.g. the browser asking for /favicon.ico
      return;
    }
    const error = url.searchParams.get("error");
    const returnedCode = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    clearTimeout(timer);

    if (error) {
      res.end(`Authorisation failed: ${error}. You can close this tab.`);
      reject(new Error(`Google returned an error: ${error}`));
    } else if (returnedState !== state) {
      res.end("State mismatch. Please run the command again.");
      reject(new Error("State mismatch: possible stale or forged redirect"));
    } else if (!returnedCode) {
      res.end("No code received. Please run the command again.");
      reject(new Error("Redirect had no ?code="));
    } else {
      res.end(
        "✅ Authorised. You can close this tab and return to the terminal.",
      );
      resolve(returnedCode);
    }
  });
}).finally(() => server.close());

// 4. Exchange the one-time code (plus the PKCE verifier) for tokens.
const { tokens } = await client.getToken({ code, codeVerifier });
if (!tokens.refresh_token) {
  throw new Error(
    "Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.",
  );
}
const granted = tokens.scope?.split(" ") ?? [];
const missing = SCOPES.filter((s) => !granted.includes(s));
if (missing.length > 0) {
  throw new Error(
    `Required permission not granted: ${missing.join(", ")}. Run again and tick every box on the consent screen.`,
  );
}
client.setCredentials(tokens);

// 5. Check which mailbox actually signed in. It's easy to pick the wrong account in the chooser.
const profile = await gmail({ version: "v1", auth: client }).users.getProfile({
  userId: "me",
});
const email = profile.data.emailAddress ?? "unknown";
const previous = loadToken(account);
if (previous && previous.email !== email) {
  throw new Error(
    `"${account}" is already linked to ${previous.email}, but you signed in as ${email}. Nothing was saved.`,
  );
}

saveToken(account, {
  refreshToken: tokens.refresh_token,
  email,
  scopes: granted,
  savedAt: new Date().toISOString(),
});

console.log(
  `✅ Saved "${account}" → ${email} (${profile.data.messagesTotal} messages) in macOS Keychain.`,
);

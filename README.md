# gmail-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets Claude search **several Gmail accounts** from one place — primary, secondary, work and one more — without any third-party service in between.

- **Runs on your machine.** Claude Desktop starts it as a local process over stdio. No ports, no cloud relay.
- **Talks only to Google.** Requests go straight from your Mac to `gmail.googleapis.com`.
- **Read-only.** Uses the `gmail.readonly` scope. It cannot send, delete or modify mail.
- **No secrets on disk in the repo.** Refresh tokens live in the macOS Keychain; the OAuth client file lives outside the project.

> Status: work in progress. Search works today; reading full messages, drafts and cross-account search are on the roadmap.

---

## Tools

| Tool | What it does |
|---|---|
| `search_mail` | Search one linked account with Gmail search syntax. Returns sender, subject, date, unread flag and a snippet. Supports `since` / `until` (local dates, `YYYY-MM-DD`) and pagination via `pageToken`. |
| `server_time` | Current date and time on the user's machine, including `today` (`YYYY-MM-DD`) for use with `since` / `until`. |
| `ping` | Health check that echoes a message. |

Accounts are referred to by alias: `primary`, `secondary`, `work`, `other`. Edit `ACCOUNTS` in `src/config.ts` to change them.

### Why `since` / `until` instead of `after:2026/10/17`?

Gmail can interpret plain dates in a different time zone than yours, so "today" can be off by several hours. `since: "2026-10-17"` is converted by the server into the exact Unix timestamp of local midnight (DST-safe), e.g. `after:1792209600`.

---

## Requirements

- macOS (tokens are stored in the macOS Keychain)
- Node.js 20 or newer
- Claude Desktop and/or Claude Code
- A Google account to own a (free) Google Cloud project

---

## Setup

### 1. Google Cloud (one time, ~15 minutes)

1. In [console.cloud.google.com](https://console.cloud.google.com), create a new project. No billing is needed.
2. **APIs & Services → Library → Gmail API → Enable.**
3. Open **Google Auth Platform → Get started**:
   - App name and support email: anything you like
   - **Audience: External**
4. **Audience → Test users:** add every Gmail address you plan to link.
5. **Data Access → Add or remove scopes:** add `https://www.googleapis.com/auth/gmail.readonly`.
6. **Clients → Create client → Application type: Desktop app.** Download the JSON straight away.
7. Move it outside the project:

   ```bash
   mkdir -p ~/.config/gmail-mcp
   mv ~/Downloads/client_secret_*.json ~/.config/gmail-mcp/client.json
   chmod 600 ~/.config/gmail-mcp/client.json
   ```

> **Testing vs production:** while the app's publishing status is *Testing*, Google expires refresh tokens after **7 days**. For long-term personal use, set the status to *In production* (you'll see an "unverified app" warning when signing in — expected for a personal app).

### 2. Install

```bash
git clone https://github.com/spandita46/gmail-mcp.git
cd gmail-mcp
npm install
npm run typecheck
```

### 3. Link an account

```bash
npm run auth -- primary you@gmail.com
```

Your browser opens Google's consent screen. Pick the account, accept the "unverified app" warning, and allow **Read your email**. The terminal prints:

```
✅ Saved "primary" → you@gmail.com (N messages) in macOS Keychain.
```

Repeat for each alias (`secondary`, `work`, `other`). The second argument (an email hint) is optional.

The auth script refuses to overwrite an alias that is already linked to a different mailbox, and checks that the Gmail permission was actually granted.

### 4. Connect to Claude Desktop

Quit Claude Desktop (**⌘Q**) first — it rewrites its config file while running. Then edit
`~/Library/Application Support/Claude/claude_desktop_config.json` and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "gmail-multi": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/gmail-mcp/node_modules/tsx/dist/cli.mjs",
        "/absolute/path/to/gmail-mcp/src/server.ts"
      ],
      "env": {
        "GMAIL_MCP_TZ": "America/Toronto"
      }
    }
  }
}
```

- Use **absolute paths** everywhere (`which node` for the first one). Claude Desktop does not load your shell `PATH`, so `npx` usually fails there.
- Reopen Claude Desktop and check **Settings → Developer**: `gmail-multi` should be *running*.

### 5. (Optional) Claude Code

```bash
claude mcp add gmail-multi -- /absolute/path/to/node \
  /absolute/path/to/gmail-mcp/node_modules/tsx/dist/cli.mjs \
  /absolute/path/to/gmail-mcp/src/server.ts
```

---

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `GMAIL_MCP_TZ` | `America/Toronto` | Time zone for `server_time` and `since` / `until` |
| `GMAIL_MCP_CLIENT_FILE` | `~/.config/gmail-mcp/client.json` | Path to the Google OAuth *Desktop app* client file |

Never put secrets in `claude_desktop_config.json` — it is a plain-text file.

---

## Development

```bash
npm run dev        # run the server directly (it waits for JSON-RPC on stdin)
npm run inspect    # open the MCP Inspector UI against the server
npm run typecheck  # tsc --noEmit
npm run auth -- <alias> [email-hint]
```

Project layout:

```
src/
├── server.ts            # MCP entry point: creates the server and registers tools
├── tools/search-mail.ts # search_mail tool (schemas, description, output)
├── gmail.ts             # Gmail API layer: cached client per account, search, error mapping
├── config.ts            # account aliases, scopes, OAuth client loading, Keychain storage
├── time.ts              # time zone helpers (local midnight → epoch, DST-safe)
└── auth.ts              # one-time OAuth CLI (loopback redirect + PKCE + state)
```

Notes for contributors:

- This is a **stdio** server: never use `console.log` in server code — stdout is the protocol channel. Log with `console.error`.
- Relative imports use `.js` extensions (Node ESM with `"module": "nodenext"`).
- Built on the MCP TypeScript SDK **v2** (`@modelcontextprotocol/server`).

---

## Security

- **OAuth:** authorization code flow with a loopback redirect on `127.0.0.1`, **PKCE (S256)** and a random **state** check. The Desktop-app client secret is not treated as confidential.
- **Token storage:** one macOS Keychain item per alias (service `gmail-mcp`). Note that a Keychain item trusts the program that created it (`node`), so any Node script running as your user can read it without a prompt. Don't run untrusted Node code on the same account.
- **Least privilege:** read-only Gmail scope. Write features (drafts) will be added as a separate, opt-in scope.
- **Prompt injection:** email content is written by third parties. Tool descriptions tell the model to treat it as untrusted data, and the server exposes no sending capability.
- **Revoking access:** remove the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and delete the `gmail-mcp` items in Keychain Access.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Server doesn't appear in Claude Desktop | Check JSON validity, use absolute paths, fully quit (⌘Q) and reopen. Logs: `~/Library/Logs/Claude/mcp*.log` |
| "Server disconnected" right after start | A `console.log` somewhere in server code, or a startup crash — see `mcp-server-gmail-multi.log` |
| Code changes don't take effect | Claude Desktop only restarts the server on launch — ⌘Q and reopen |
| `Account "x" is not linked yet` | `npm run auth -- x` |
| `has expired or was revoked` (`invalid_grant`) | Re-run `npm run auth -- <alias>`. In *Testing* mode this happens every 7 days |
| `403 access_denied` during sign-in | The address isn't listed under **Audience → Test users** |
| `redirect_uri_mismatch` | The OAuth client was created as *Web* — create a *Desktop app* client |
| Work account blocked | Google Workspace admins can block third-party API access — check with your admin |

---

## Roadmap

- [x] stdio MCP server, Claude Desktop integration
- [x] OAuth CLI with PKCE + Keychain storage
- [x] `search_mail` with time-zone-correct `since` / `until`
- [ ] Link remaining accounts + `search_all_accounts` (parallel, partial-failure tolerant)
- [ ] `read_message` / `read_thread` (MIME parsing)
- [ ] `create_draft` (opt-in `gmail.compose` scope; no sending)
- [ ] Per-account tool policy

## License

[MIT](LICENSE)

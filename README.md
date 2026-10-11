# google-workspace-mcp

Local and hosted MCP server for sending Gmail and appending plain text to an existing Google Doc. Version 0.2.0 speaks MCP over stdio and Streamable HTTP. Tool names and schemas are the same on both transports.

The server exposes five tools, in this order:

1. `google_list_accounts`
2. `google_authorization_status`
3. `google_begin_authorization`
4. `gmail_send_email`
5. `gdocs_append_content`

Every tool result uses the same envelope. Success:

```json
{ "ok": true, "operation_id": "op_…", "tool": "gmail_send_email", "result": {}, "warnings": [] }
```

Failure:

```json
{ "ok": false, "operation_id": "op_…", "tool": "gmail_send_email", "error": { "code": "INVALID_ARGUMENT", "message": "…", "retryable": false, "error_id": "op_…" } }
```

`content[0].text` is that JSON. `structuredContent` is the same object. `isError` is true when `ok` is false.

## Quick start

Requirements: Node.js 22 or newer, a Google Cloud Desktop OAuth client, and one Google account you can authorize.

```bash
npm install
npm run build
cp .env.example .env
```

On Windows, copy `.env.example` to `.env`. Generate an encryption key and put it in `TOKEN_ENCRYPTION_KEY`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` from the Desktop client. Then authorize and confirm the account:

```bash
node dist/cli.js auth
node dist/cli.js accounts
```

`auth` prints an authorization URL, listens on `127.0.0.1` for the OAuth callback, and stores an encrypted refresh token. The MCP process does not need to be running during `auth`.

Start the server for a client with:

```bash
node dist/index.js
```

`TRANSPORT` defaults to `stdio`. Logs go to stderr. stdout is only MCP JSON-RPC.

## Supported clients

Both clients use the same build, the same command, and `TRANSPORT=stdio`.

- Cursor, as an MCP stdio server
- One other conversational client that speaks MCP over stdio (for example Claude Desktop)

Record the client names and versions in `COMPATIBILITY.md` after the manual run in `docs/manual-acceptance.md`. That run is not part of `npm test`.

Cursor example (`mcp.json`). Replace the path and leave real secrets only in your local config, not in the repo:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["D:/path/to/google-workspace-mcp/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio",
        "TOKEN_ENCRYPTION_KEY": "<base64 32-byte key>",
        "TOKEN_STORE_SQLITE_PATH": "D:/path/to/google-workspace-mcp/data/tokens.sqlite",
        "GOOGLE_OAUTH_CLIENT_ID": "<desktop client id>",
        "GOOGLE_OAUTH_CLIENT_SECRET": "<desktop client secret>",
        "TENANT_ID": "local",
        "USER_ID": "local"
      }
    }
  }
}
```

Use the same `TOKEN_ENCRYPTION_KEY` and `TOKEN_STORE_SQLITE_PATH` that `auth` used, or the server cannot read the refresh token. A second stdio client should use that same env. Two different `USER_ID` values do not share accounts, even on one database file.

## Local setup

1. Create a Google Cloud project and enable the Gmail API and the Google Docs API.
2. Create an OAuth client of type Desktop. This build uses the loopback flow, not a hosted redirect.
3. Copy `.env.example` to `.env` and fill the Google client, the encryption key, and optionally `TOKEN_STORE_SQLITE_PATH`.
4. `npm install` and `npm run build`.
5. `node dist/cli.js auth`. Open the printed URL, consent, and wait until the CLI prints the account envelope.
6. Point Cursor and the second client at `node dist/index.js` with the env above.

`google_begin_authorization` is also registered. It returns `authorization_url` and does not wait for the browser. Prefer `node dist/cli.js auth` for the first setup. The URL contains the OAuth `state` parameter Google requires. The tool result does not include the PKCE verifier, the authorization code, or a refresh token.

## Configuration

`.env.example` lists every variable. Empty allowlists mean no restriction. Important local values:

| Variable | Role |
|---|---|
| `TRANSPORT` | `stdio` for a local process. `http` serves Streamable HTTP. |
| `TENANT_ID`, `USER_ID` | Principal stored with accounts. Defaults `local` / `local`. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Desktop OAuth client. |
| `TOKEN_ENCRYPTION_KEY` | 32-byte key, base64. Required before the store opens. |
| `TOKEN_STORE_SQLITE_PATH` | SQLite file for tokens, idempotency, and audit. |
| `OAUTH_LOOPBACK_PORT` | Empty uses an ephemeral port. Set it when the Desktop client is registered for one fixed port. |
| `ALLOW_ACCOUNT_IDS`, `ALLOW_RECIPIENT_DOMAINS`, `ALLOW_BCC_DOMAINS`, `ALLOW_DOCUMENT_IDS` | Optional allowlists. A miss is `ACCESS_DENIED`. |
| `RATE_LIMIT_PER_ACCOUNT_PER_MINUTE` | Default 20. Over the limit is `RATE_LIMITED`. |
| `LOG_CONTENT` | Default `false`. Bodies stay out of logs and audit rows. |
| `METRICS_ENABLED` | `false` keeps counters as JSON log lines. `true` exposes `GET /metrics` on the HTTP server. |

## Hosted HTTP

`TRANSPORT=http` listens on `HOST` and `PORT` (defaults `127.0.0.1` and `8080`) and serves MCP at `MCP_PATH` (`/mcp`). The process requires `PUBLIC_BASE_URL` and `GOOGLE_REDIRECT_URI`. In production it also requires `MCP_AUTHORIZATION_SERVER` and refuses to start if `MCP_DEV_BEARER_SHA256` is set. On Railway those HTTP defaults are filled from `RAILWAY_PUBLIC_DOMAIN` and the process binds `::` when `HOST` is empty. See `deployment-plan.md`.

Use PostgreSQL (`TOKEN_STORE=postgres` and `TOKEN_STORE_DATABASE_URL`) when more than one replica may run. HTTP with SQLite starts only when `ALLOW_SINGLE_REPLICA_SQLITE=true`.

A remote client points at `https://<host>/mcp` and sends a bearer access token from `MCP_AUTHORIZATION_SERVER`. The token's `sub` is the user id. The tenant is `MCP_TENANT_CLAIM` (default `tenant_id`) or, when that claim is absent, `DEFAULT_TENANT_ID` or `TENANT_ID`. Unauthenticated calls receive `401` and `WWW-Authenticate` pointing at `/.well-known/oauth-protected-resource`. The MCP scope for invoking tools is `tools.call`. That scope is not a Google scope.

Development can use `MCP_DEV_BEARER_SHA256` instead of an issuer. One entry is the hex SHA-256 of the bearer. Add `|userId` or `|tenantId|userId`, and separate entries with commas, to map more than one bearer. This variable is refused when `NODE_ENV=production`.

After the caller can invoke tools, `google_begin_authorization` returns a Google URL whose redirect is `GOOGLE_REDIRECT_URI`. The browser returns to `GET /oauth/google/callback`. Use a Google Web OAuth client for that redirect. The success page shows the account email and no tokens.

`GET /healthz` returns `{ "status": "ok" }`. `GET /readyz` returns 200 when the token store answers and 503 `{ "status": "unavailable" }` when it does not. Neither probe calls Google or lists accounts.

Example client config, with TLS terminated in front of the process:

```json
{
  "mcpServers": {
    "google-workspace": {
      "url": "https://workspace.example.com/mcp"
    }
  }
}
```

The client completes its own MCP OAuth flow against `MCP_AUTHORIZATION_SERVER`. Deployment steps, the proxy, and what the proxy must not log are in `docs/deployment.md`.

## OAuth

Use a Desktop client. The CLI binds `127.0.0.1` only, on `OAUTH_LOOPBACK_PORT` or an ephemeral port, path `/oauth/google/callback`. Register that redirect on the OAuth client when Google requires a fixed loopback URI, and set `OAUTH_LOOPBACK_PORT` to the same port.

The consent screen should include `openid`, email, profile, `https://www.googleapis.com/auth/gmail.send`, and `https://www.googleapis.com/auth/documents` if you use both tools. `gmail.send` can send mail and cannot read the mailbox. The Docs scope is broader than append: it can read and edit documents the account can open. See `SECURITY.md`.

Refresh tokens are encrypted with AES-256-GCM before they are written. Access tokens stay in process memory.

## Examples

Send:

```json
{
  "to": ["person@example.com"],
  "subject": "Notes",
  "body": "Plain text",
  "idempotency_key": "send-2026-10-10-1"
}
```

`body_format` may be `plain` or `html`. A missing `idempotency_key` still sends, with warning `IDEMPOTENCY_KEY_MISSING`. The same key and the same body return the stored result and do not send again. The same key and a different body return `IDEMPOTENCY_CONFLICT`. Gmail acceptance is warning `DELIVERY_NOT_GUARANTEED`.

Append:

```json
{
  "document_id": "https://docs.google.com/document/d/DOCUMENT_ID/edit",
  "content": "A new line",
  "idempotency_key": "append-2026-10-10-1"
}
```

`document_id` may be the raw id or a `https://docs.google.com/document/d/…` URL. The tool inserts at the end. It does not return the existing document body.

CLI equivalents read the same JSON from a file:

```bash
node dist/cli.js send --file send.json
node dist/cli.js append --file append.json
```

## Tests

`npm test` compiles TypeScript, then runs the unit, integration, stdio, and Streamable HTTP contract tests. The contract harness needs:

- Node.js 22 or newer
- the compiled `dist/index.js` (`npm test` builds it)
- no live Google account and no outbound Google network

The harness starts a local fake Gmail, Docs, and token endpoint, seeds an encrypted account in a temporary SQLite file, and spawns `node dist/index.js`. Stdio cases check tool discovery, a fake send, a fake append, protocol errors, stdout purity, allowlists, rate limits, audit rows, credential leakage, header injection, cross-account isolation, and idempotency. HTTP cases repeat discovery, the fake send shape, protocol errors, bearer rejection, and two-principal isolation. PostgreSQL behavior is checked with an in-process Postgres-compatible database, not a live server.

`npm run typecheck` runs the compiler without emitting.

The two-client checklist in `docs/manual-acceptance.md` uses a real Google account. It is not automated. Leave those boxes unchecked until you run it, and fill `COMPATIBILITY.md` from that run.

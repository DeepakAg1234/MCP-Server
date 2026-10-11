# Security

This note matches the scopes and storage in version 0.2.0. Stdio is one operating-system user per process. Streamable HTTP isolates callers by the validated bearer token.

## Scopes

Authorization always requests OpenID, email, and profile so the server can show the mailbox address.

| Capability | Scope | What it allows |
|---|---|---|
| `gmail.send` | `https://www.googleapis.com/auth/gmail.send` | Send mail as the user. It does not read the mailbox. |
| `docs.append` | `https://www.googleapis.com/auth/documents` | Read and edit Google Docs the account can open. |

The Docs scope is broader than append. Google does not offer an append-only Docs scope. A token stored for `gdocs_append_content` can also be used by any client that holds it to read or change those documents. This server's tool only inserts text at the end of one document id and does not return the document body. Treat the stored refresh token as access to the user's Docs, not as an append-only grant.

## Token storage

Refresh tokens are encrypted with AES-256-GCM before they are written to SQLite (`TOKEN_STORE_SQLITE_PATH`). The key is `TOKEN_ENCRYPTION_KEY` (32 bytes, base64) in the environment. The ciphertext includes a version byte and a random nonce. The raw refresh token is not stored.

Access tokens live in process memory only, and are dropped on `invalid_grant`. The OAuth `state` value is stored as a SHA-256 hash. The PKCE verifier is encrypted. The loopback listener accepts connections from `127.0.0.1` only.

Anyone who can read both the SQLite file and the encryption key can decrypt refresh tokens. Keep the key out of the repository, shell history shared with other people, and MCP tool arguments.

## Consent boundary

`node dist/cli.js auth` and `google_begin_authorization` start the Google consent screen. The tool returns `authorization_url` and does not wait for the user. The URL contains OAuth `state` because Google requires it. The tool result does not include `code_verifier`, the authorization code, or tokens.

The user consents in the browser. A denied consent stores nothing. A callback for a different `TENANT_ID` / `USER_ID` than the one that started the flow is rejected.

## Logging and audit

Logs are JSON lines on stderr. Refresh tokens, access tokens, authorization codes, PKCE verifiers, client secrets, and `Authorization` headers are redacted. BCC addresses are not written to the audit row. Message bodies and document text are omitted when `LOG_CONTENT` is false, which is the default.

Audit rows store counts (`to`, `cc`, `bcc`), optional recipient domains, the document id for an append, and the stable error code. They do not store the body. Rows older than `AUDIT_RETENTION_DAYS` (default 30) are deleted when the process opens the store. Completed idempotency records expire after `IDEMPOTENCY_TTL_HOURS` (default 24).

Metric log lines use stable labels (`tool`, `outcome`, `error_code`, `result`). They do not include email addresses, document ids, or raw Google errors. When `METRICS_ENABLED=true`, `GET /metrics` serves those counters as Prometheus text. With no `METRICS_TOKEN`, only a loopback peer can read it. With `METRICS_TOKEN` set, the request must send `Authorization: Bearer` equal to that token.

## Single-user stdio

stdio credentials come from the process environment. `TENANT_ID` and `USER_ID` select which rows that process will list or use. Two processes with different user ids, sharing one database, do not see each other's accounts through the tools.

That is not a multi-user security boundary. The operating-system user who can read the database and the encryption key can read every row. Run one OS user per process. Do not point an untrusted account at another person's `TOKEN_STORE_SQLITE_PATH` and key.

## HTTP principals

On Streamable HTTP the caller is the bearer token, not `TENANT_ID` / `USER_ID` and not a tool argument. Access tokens are checked against `MCP_AUTHORIZATION_SERVER` (issuer, audience, JWKS). `sub` becomes `user_id`. The tenant comes from `MCP_TENANT_CLAIM` or, when the claim is missing, `DEFAULT_TENANT_ID` or `TENANT_ID`. A missing or invalid token is `401` with `WWW-Authenticate` pointing at the protected-resource metadata. The advertised scope is `tools.call`. That is the MCP caller scope. It is unrelated to `gmail.send` and `documents`.

`MCP_DEV_BEARER_SHA256` maps a bearer hash to one principal for development. The process refuses to start when that variable is set and `NODE_ENV=production`. Do not leave a development bearer in a production environment.

Google OAuth state is stored for the principal that called `google_begin_authorization`. The public callback uses that principal. A bearer for a different principal cannot finish someone else's state. The success page contains the account email and no access token, refresh token, or authorization code.

HTTP with SQLite is a single-replica mode. The process exits unless `ALLOW_SINGLE_REPLICA_SQLITE=true`. More than one replica needs PostgreSQL. The proxy must not log request bodies or `Authorization` headers. See `docs/deployment.md`.

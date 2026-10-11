# Hosted deployment

Run one or more replicas of `node dist/index.js` with `TRANSPORT=http`. Terminate TLS at a reverse proxy. The process builds external URLs from `PUBLIC_BASE_URL`, so that value is the HTTPS origin clients use, not the internal bind address.

## Process

```text
Remote MCP client --HTTPS bearer--> TLS proxy --> replicas --> PostgreSQL
                                                         \--> Google APIs
```

Replicas share one PostgreSQL database, one Google OAuth client, and one `TOKEN_ENCRYPTION_KEY`. They do not share memory. The access-token cache is per process. Idempotency keys and OAuth state live in PostgreSQL, so a retry can land on any replica. Session affinity is unnecessary.

Set:

| Variable | Value |
|---|---|
| `TRANSPORT` | `http` |
| `HOST` | the interface the proxy can reach, not `127.0.0.1`, unless the proxy is on the same host |
| `PORT` | the port the proxy targets |
| `PUBLIC_BASE_URL` | `https://workspace.example.com` with no path |
| `MCP_PATH` | `/mcp` unless you mount the server elsewhere |
| `GOOGLE_REDIRECT_URI` | `https://workspace.example.com/oauth/google/callback` |
| `TOKEN_STORE` | `postgres` |
| `TOKEN_STORE_DATABASE_URL` | the PostgreSQL URL |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes, base64, the same on every replica |
| `MCP_AUTHORIZATION_SERVER` | the HTTPS issuer that issues MCP access tokens |
| `MCP_RESOURCE_AUDIENCE` | defaults to `PUBLIC_BASE_URL`. Set it to the exact `aud` your issuer puts on tokens. The protected-resource document's `resource` is this value. |
| `NODE_ENV` | `production` |

`NODE_ENV=production` refuses to start when `MCP_DEV_BEARER_SHA256` is set. Leave that variable unset. Production also requires `MCP_AUTHORIZATION_SERVER`.

HTTP with `TOKEN_STORE=sqlite` exits unless `ALLOW_SINGLE_REPLICA_SQLITE=true`. Use that only for a single process. A second replica with the same SQLite file is not supported.

## Google OAuth client

Create a **Web** client. Add `GOOGLE_REDIRECT_URI` as an authorized redirect URI. Put the client id and secret in `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.

The MCP client authenticates to this server first. Google authorization is the next step: the caller invokes `google_begin_authorization`, the user opens `authorization_url`, and Google redirects to `GET /oauth/google/callback`. The HTML response shows the account email and does not include tokens.

## MCP caller tokens

This server does not issue MCP access tokens. Point `MCP_AUTHORIZATION_SERVER` at an existing issuer. Tokens must have:

- `iss` equal to that issuer
- `aud` equal to `MCP_RESOURCE_AUDIENCE` (default `PUBLIC_BASE_URL`)
- `sub`, which becomes `user_id`
- `scope` or `scp` containing `tools.call`
- an expiry

Optional claim `MCP_TENANT_CLAIM` (default `tenant_id`) selects the tenant. If it is absent, the server uses `DEFAULT_TENANT_ID`, then `TENANT_ID`.

Unauthenticated calls to the MCP path receive `401` and `WWW-Authenticate` with `resource_metadata` set to `/.well-known/oauth-protected-resource` (path-aware when `MCP_PATH` is not `/`). The scope in that challenge is `tools.call`.

## Proxy

Forward `Authorization`, `MCP-Protocol-Version`, and `Content-Type`. Do not log request or response bodies. Do not log `Authorization`, cookies, or the OAuth `code` query parameter. The MCP body contains message text and recipient addresses. The callback query contains an authorization code.

Health checks:

- `GET /healthz` → `200` `{ "status": "ok" }` when the process is up
- `GET /readyz` → `200` when the token store answers, otherwise `503` `{ "status": "unavailable" }`

Neither probe calls Google or returns account data.

`GET /metrics` is off unless `METRICS_ENABLED=true`. Without `METRICS_TOKEN` it answers only a loopback client. Set `METRICS_TOKEN` and send it as `Authorization: Bearer` if the scraper is not on the host.

## What stays the same

Tool names, JSON Schemas, the result envelope, error codes, idempotency, and redaction match the stdio server. A client that already calls `gmail_send_email` or `gdocs_append_content` does not change those arguments.

## Railway

When `RAILWAY_ENVIRONMENT` or `RAILWAY_PROJECT_ID` is set and the matching variable is empty, the process uses:

| Variable | Default |
|---|---|
| `TRANSPORT` | `http` |
| `HOST` | `::` |
| `PUBLIC_BASE_URL` | `https://` plus `RAILWAY_PUBLIC_DOMAIN` |
| `GOOGLE_REDIRECT_URI` | `PUBLIC_BASE_URL` + `/oauth/google/callback` |
| `TOKEN_STORE` | `postgres`, when `TOKEN_STORE_DATABASE_URL` or `DATABASE_URL` is set |
| `TOKEN_STORE_DATABASE_URL` | `DATABASE_URL` |

An explicit value always wins. `PORT` stays the port Railway injects. The service definition, health check, and Postgres reference live in `.railway/railway.ts`. Apply that file with the Railway CLI; a new Railway service does not read `railway.toml`. The operator steps are in [deployment-plan.md](../deployment-plan.md).

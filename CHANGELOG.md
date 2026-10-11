# Changelog

## 0.2.0

Streamable HTTP is a supported transport. Tool names, input schemas, output schemas, and error codes are unchanged from 0.1.0.

HTTP adds bearer authentication for the MCP caller, a Google OAuth callback, PostgreSQL as a token store, and `GET /healthz`, `GET /readyz`, and `GET /metrics`. A production process refuses `MCP_DEV_BEARER_SHA256`.

## 0.1.0

Local stdio MCP server for one Google account.

Tools, in order:

- `google_list_accounts`
- `google_authorization_status`
- `google_begin_authorization`
- `gmail_send_email`
- `gdocs_append_content`

Each tool returns one envelope: `ok`, `operation_id`, `tool`, and either `result` plus `warnings` or `error`. The same JSON is `structuredContent` and `content[0].text`. `isError` is true when `ok` is false.

Also in this version: Desktop OAuth with PKCE and an encrypted refresh token, idempotency keys, allowlists, in-process rate limits, SQLite audit with retention, and structured metric log lines. `TRANSPORT=http` is refused and does not listen.

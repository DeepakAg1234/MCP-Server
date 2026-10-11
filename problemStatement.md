# Problem Statement: Generic Gmail and Google Docs MCP Server

## 1. Purpose

Build a secure, standards-based Model Context Protocol (MCP) server that lets an AI agent:

1. Send email through an authorized Gmail account.
2. Append structured or plain-text content to an existing Google Doc.

The server must be usable by any MCP-capable client, including Cursor, Antigravity, ChatGPT, Claude, Gemini, and future agents. It must not depend on a client-specific prompt format, UI, SDK, or authentication convention beyond the MCP transport and capability model.

## 2. Problem to Solve

Agents frequently need to complete business workflows that end in external communication or documentation—for example, send a stakeholder update and append the same update to a project log. Today, each agent environment requires separate integrations, inconsistent commands, and potentially unsafe handling of user credentials.

This project creates one reusable MCP integration that exposes a small, predictable set of tools backed by Google APIs. A compatible agent should be able to discover the tools, request the appropriate action, receive structured results, and handle user approval without custom code for a particular AI platform.

## 3. Goals

- Provide MCP tools to send Gmail messages and append content to Google Docs.
- Support OAuth 2.0 authorization for one or more Google accounts without exposing access tokens to the model or client.
- Use documented, versioned JSON input and output schemas.
- Be transport-agnostic at the product boundary: support local MCP transports first (for example, stdio) and allow an HTTP/SSE or Streamable HTTP deployment without changing tool semantics.
- Make side-effecting operations safe, auditable, and explicit.
- Return actionable, client-neutral errors and structured success metadata.
- Keep the implementation extensible for additional Google Workspace capabilities later.

## 4. Non-Goals

- Building an email client, inbox reader, search interface, or mail campaign system.
- Creating, deleting, sharing, or reformatting Google Docs in the first release.
- Editing arbitrary existing text in a document; this release only appends content.
- Replacing the host agent’s consent or confirmation experience.
- Supporting non-Google email or document providers in the initial version.
- Storing user Google credentials in source code, prompts, tool arguments, logs, or client configuration files.

## 5. Primary Users and Use Cases

### Users

- A person using an AI coding agent (Cursor or Antigravity) to automate an update.
- A person using a conversational agent (ChatGPT, Claude, Gemini, or another MCP client) to send a prepared email or record a note in a shared Google Doc.
- An administrator or developer deploying the server for a team or organization.

### Example workflows

1. An agent drafts a release note, asks the user for confirmation, sends it to recipients, and returns the Gmail message ID.
2. An agent appends a meeting summary to a document identified by its Google Docs URL or document ID and returns the inserted range/index.
3. An agent performs both operations in sequence, reporting independently whether email delivery submission and document append succeeded.

## 6. Functional Requirements

### 6.1 MCP compatibility

- Implement the current MCP specification supported by target clients at release time.
- Expose tools through MCP tool discovery with names, descriptions, JSON schemas, and clear annotations for side effects where supported by the specification.
- Do not require a system prompt, client-specific tool wrapper, or proprietary extension to invoke the tools.
- Use stable, lowercase, underscore-separated tool names.
- Publish a compatibility matrix documenting tested MCP protocol versions, transports, and clients.

### 6.2 Gmail tools

#### `gmail_send_email`

Send an email through the selected authorized Gmail account.

Required inputs:

- `to`: one or more recipient email addresses.
- `subject`: subject text.
- `body`: message body.

Optional inputs:

- `account_id`: server-defined authorized account identifier; uses the configured default when omitted.
- `cc` and `bcc`: recipient lists.
- `body_format`: `plain` (default) or `html`.
- `reply_to_message_id`: Gmail message ID to place the message in an existing thread when supported.
- `attachments`: future-compatible field; if not delivered in v1, reject it explicitly rather than silently ignoring it.
- `idempotency_key`: caller-provided opaque value used to prevent an accidental duplicate send during retry.

Required behavior:

- Validate email addresses, recipient limits, subject/body limits, and body format before sending.
- Require at least one recipient across `to`, `cc`, and `bcc`; normally require `to` unless a documented exception is selected.
- Construct a standards-compliant MIME message and send it through the Gmail API.
- Do not expose BCC recipients in returned data, logs, or any preview intended for other recipients.
- On success, return at minimum `message_id`, `thread_id` (when available), `account_id`, and a `status` of `sent` or `accepted` as defined by Gmail’s API response.
- Clearly state that successful submission to Gmail does not guarantee recipient delivery.
- If an idempotency key was already completed with a matching request, return the original result. If it was used with different content, return a conflict error.

### 6.3 Google Docs tools

#### `gdocs_append_content`

Append content to the end of an existing Google Doc.

Required inputs:

- `document_id`: Google Docs document ID, or a Google Docs URL that the server can safely parse into an ID.
- `content`: text to append.

Optional inputs:

- `account_id`: server-defined authorized account identifier; uses the configured default when omitted.
- `format`: `plain_text` (v1 required). Optional future values may include `markdown` and a constrained structured format.
- `prepend_newline`: boolean, default `true`, to separate appended content from existing content.
- `idempotency_key`: opaque retry-protection key.

Required behavior:

- Validate that the document ID is well formed and that the authorized user can edit the document.
- Obtain the current document end index and append at that location through the Google Docs API `batchUpdate` workflow.
- Preserve document content; do not overwrite, delete, or reformat existing text.
- State the concurrency strategy. The preferred v1 strategy is to fetch the document just before the update, append at its current end, and retry a bounded number of times on a documented revision/concurrency conflict.
- Return at minimum `document_id`, `account_id`, `status`, and append metadata such as `start_index`, `end_index`, and/or `revision_id` when Google returns it.
- Apply idempotency behavior equivalent to the email tool so a retry does not append duplicate content.

### 6.4 Account management and authorization

The server must provide a secure way to connect and select Google accounts. It may expose MCP resources or tools such as the following; final naming can vary but semantics must remain clear:

- `google_list_accounts`: list authorized account identifiers and non-sensitive display metadata.
- `google_authorization_status`: report whether the selected account has the scopes required for the requested action.
- `google_begin_authorization`: begin or provide the URL for an OAuth authorization flow when the deployment model permits it.

Account-management outputs must never include refresh tokens, access tokens, client secrets, raw authorization codes, or cookie values.

## 7. Google API and OAuth Requirements

### 7.1 Minimum Google scopes

Request the narrowest scopes needed for enabled functionality:

- Gmail send: `https://www.googleapis.com/auth/gmail.send`
- Google Docs append: `https://www.googleapis.com/auth/documents`

Use incremental authorization where practical. Do not request inbox-reading, full Gmail modification, Drive-wide, or offline access beyond what is required by the selected OAuth deployment flow. Document every scope and the reason it is needed.

### 7.2 OAuth flow

- Use Google OAuth 2.0 with PKCE where applicable.
- Keep OAuth client configuration in environment variables or an approved secret manager, never in the repository.
- Store refresh tokens encrypted at rest; encrypt or protect token access in memory where feasible.
- Bind authorization state to a server-side session/user identity to prevent cross-user account use and CSRF/state attacks.
- Support token refresh and gracefully request reauthorization for revoked, expired, or insufficient permissions.
- For local stdio deployments, document a safe browser-based authorization bootstrap process. For hosted deployments, provide a redirect URI and callback design appropriate to the host.
- If this server is used by multiple people, enforce tenant/user isolation: one user must not list, select, or use another user’s authorized account.

## 8. Safety, Consent, and Privacy

Both core actions create external side effects. The server and its client integration must make this clear.

- Mark `gmail_send_email` and `gdocs_append_content` as destructive/side-effecting or non-read-only in MCP metadata when the protocol supports such annotations.
- The recommended client experience is to show recipients, subject, body format, and a safe preview before sending an email, and document title/identifier plus append preview before modifying a Doc.
- The server must not send email or edit a Doc merely because an agent generated a draft. A tool invocation is the execution boundary; clients may add a user confirmation step before it.
- Treat all tool inputs as untrusted. Protect against header injection, HTML/script hazards, malformed URLs, oversized payloads, and prompt-injected document text.
- Redact secrets and sensitive fields from logs. Log message bodies and document content only if explicitly enabled by the deploying organization, and provide retention controls.
- Support allowlists or policy hooks for recipients, domains, documents, and accounts when operated in an organization.
- Never return full document contents unless a later, separately authorized read capability is added.

## 9. Tool Contracts

All tools must accept and return JSON objects. Inputs should reject unknown fields by default or document a forward-compatible policy. Outputs must be consistent across transports and clients.

### 9.1 Common result envelope

Successful operations should return a shape equivalent to:

```json
{
  "ok": true,
  "operation_id": "op_123",
  "tool": "gmail_send_email",
  "result": {},
  "warnings": []
}
```

Failures should return a structured, safe error shape equivalent to:

```json
{
  "ok": false,
  "error": {
    "code": "INSUFFICIENT_SCOPE",
    "message": "The selected account is not authorized to send email.",
    "retryable": false,
    "next_action": "Reconnect the Google account and grant the Gmail send permission."
  }
}
```

Do not return raw Google API error payloads if they include sensitive information. Preserve a server-side correlation ID for support and return it as `operation_id` or `error_id`.

### 9.2 Error codes

Define and document at least the following stable codes:

- `INVALID_ARGUMENT`
- `UNAUTHENTICATED`
- `ACCOUNT_NOT_FOUND`
- `INSUFFICIENT_SCOPE`
- `ACCESS_DENIED`
- `NOT_FOUND`
- `CONFLICT`
- `RATE_LIMITED`
- `UPSTREAM_UNAVAILABLE`
- `UPSTREAM_ERROR`
- `IDEMPOTENCY_CONFLICT`
- `INTERNAL_ERROR`

Every error must state whether retry is reasonable. Retryable errors should include a `retry_after_seconds` field when known.

## 10. Architecture Expectations

### 10.1 Components

1. **MCP transport adapter** — implements stdio first and optional HTTP transport; maps MCP calls to application services.
2. **Tool service layer** — validates schemas, applies policy and idempotency, coordinates execution, and creates audit events.
3. **Google integration layer** — isolated clients for Gmail and Google Docs APIs, responsible for API-specific request/response mapping.
4. **Authorization/token store** — securely manages accounts, OAuth state, encrypted refresh tokens, and access-token renewal.
5. **Policy and audit layer** — enforces tenant/user context, optional allowlists, rate limits, redaction, and operational records.

### 10.2 Separation of concerns

- The MCP adapter must not contain Gmail MIME construction or Google Docs indexing logic.
- Provider-specific code must not assume a particular AI client.
- Business logic must be testable without a live MCP client or live Google account.
- Configuration must support local development, single-user desktop use, and multi-user hosted operation without source changes.

## 11. Configuration

Document all configuration variables and safe defaults. Expected configuration includes:

- MCP transport and listening configuration.
- Google OAuth client ID and secret location/reference.
- OAuth redirect/callback URLs.
- Token store provider and encryption key reference.
- Default account selection behavior.
- Log level, redaction mode, and audit retention period.
- Rate limits and maximum recipients/body size/content size.
- Optional organization policies: recipient/domain/document allowlists.

Provide a `.env.example` containing variable names and comments only—no real credentials or realistic-looking secrets.

## 12. Reliability and Operational Requirements

- Validate requests before any external API call whenever possible.
- Use bounded retries with exponential backoff only for safe, transient failures.
- Use idempotency keys plus server-side operation records for all write operations.
- Do not automatically retry an ambiguous email-send failure unless idempotency can establish that it was not already sent.
- Expose health/readiness information appropriate to the transport without leaking credentials or account data.
- Capture metrics for invocation count, latency, success/failure category, OAuth refresh failures, Google quota failures, and idempotency replays.
- Enforce configurable request size, concurrency, and per-account rate limits.

## 13. Testing and Acceptance Criteria

### 13.1 Automated tests

- Unit tests for schema validation, recipient parsing, MIME construction, Docs append-index calculation, redaction, policy decisions, idempotency, and error translation.
- Integration tests against mocked Gmail and Google Docs API clients.
- OAuth flow tests covering success, denied consent, expired/revoked token, invalid state, and insufficient scope.
- Contract tests that invoke the server over each supported MCP transport.
- Security tests for token leakage, header injection, cross-account isolation, and invalid document URLs.

### 13.2 Manual acceptance tests

1. Connect a test Google account and verify that no credentials appear in the MCP client transcript or server log output.
2. From at least two MCP clients (for example, Cursor and one conversational MCP client), discover the same tool names and schemas.
3. Send a plain-text test email to a controlled inbox and verify the returned message/thread IDs correspond to Gmail.
4. Send an HTML test email and verify the rendered message is correct and no unauthorized headers are accepted.
5. Append content to a shared test Google Doc and verify pre-existing content remains unchanged.
6. Retry each write request with the same idempotency key and verify no duplicate email or duplicate Doc content is created.
7. Revoke a Google permission and verify the server returns `UNAUTHENTICATED` or `INSUFFICIENT_SCOPE` with a reauthorization action.
8. Attempt to use an unshared Doc and verify an `ACCESS_DENIED` or `NOT_FOUND` response without leaking document details.

## 14. Deliverables

- Source code for the MCP server.
- `README.md` with quick start, supported clients, local setup, configuration, OAuth setup, and examples.
- JSON Schema or typed definitions for every tool input and output.
- `.env.example` with no secrets.
- Security and privacy documentation covering scopes, token storage, consent, logging, and account isolation.
- Test suite and instructions for running it.
- Deployment guidance for local stdio and hosted HTTP transport.
- A versioned changelog describing any breaking changes to tool names or schemas.

## 15. Definition of Done

The project is complete when a user can authorize a Google account, configure the server with documented steps, connect it to at least two different MCP clients without client-specific server changes, send Gmail messages, and append content to existing Google Docs through the published MCP tools. All writes must be validated, auditable, idempotency-protected, and performed without exposing OAuth credentials or unnecessary content to the client or logs.

# Manual acceptance

Run this with a test Google account and a mailbox you control. Use the same `0.2.0` build from Cursor and from one other conversational MCP client. `TRANSPORT=stdio` for both. `npm test` does not perform this run. Leave a box unchecked until you have done that step.

After the run, write the client name, version, and result into the stdio rows of `COMPATIBILITY.md`.

- [ ] 1. Authorize, then confirm the client transcript and server stderr contain no credential material.
- [ ] 2. Confirm both clients list the same tool names and schemas.
- [ ] 3. Send a plain-text message; match `message_id` / `thread_id` to the mailbox.
- [ ] 4. Send an HTML message; confirm rendering and that an injected `Bcc` or extra header in the subject is rejected.
- [ ] 5. Append to a shared Doc; confirm prior text is unchanged and indexes refer to the new tail.
- [ ] 6. Retry each write with the same idempotency key and same body; confirm one email and one append.
- [ ] 7. Retry the same key with a different body; confirm `IDEMPOTENCY_CONFLICT`.
- [ ] 8. Revoke the Google grant; confirm `UNAUTHENTICATED` or `INSUFFICIENT_SCOPE` and a reauthorization `next_action`.
- [ ] 9. Call append on a document the account cannot open; confirm `ACCESS_DENIED` or `NOT_FOUND` and that the error omits document contents.

Not run in this environment.

## Hosted HTTP

Run the same build with `TRANSPORT=http` behind TLS, using the settings in `docs/deployment.md`. Leave these unchecked until that pass is done.

- [ ] Authorize through `GET /oauth/google/callback` on the public HTTPS origin.
- [ ] Send one message and append once from a remote MCP client.
- [ ] Retry the same idempotency key and confirm the second call does not send or append again.
- [ ] Confirm a second principal's `google_list_accounts` does not include the first principal's account.

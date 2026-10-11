# Phase 1 notes

Status: implementation complete. Automated suite is the exit gate for this build. The live Google smoke below has not been run in this environment because it needs a Desktop OAuth client and a test Google account.

## Automated gate

```bash
npm test
```

The suite does not call Google. `npm test` must pass before the manual smoke.

`TRANSPORT=http` is parsed, then the process exits with a non-zero status and does not open a listen socket. MCP stdio is Phase 2. Use the CLI.

## Operator commands

These call `AccountService`, `EmailService`, and `DocsService`. They are operator commands, not a second public API.

```bash
npm run cli -- auth --capability gmail.send --capability docs.append
npm run cli -- accounts
npm run cli -- send --file ./message.json
npm run cli -- append --file ./append.json
```

Set `TOKEN_ENCRYPTION_KEY` to 32 bytes of base64 before any command that opens the store. Variable names are in `.env.example`. Do not commit a real key.

`auth` binds `127.0.0.1` only. Set `OAUTH_LOOPBACK_PORT` when the Desktop client is registered with a fixed port.

## Manual smoke (operator)

Record the result here after running against a test Google account.

- [ ] `auth` completes and `accounts` prints the display email.
- [ ] stderr from that run contains no refresh token and no access token.
- [ ] `send` of one plain-text message returns `message_id` and warning `DELIVERY_NOT_GUARANTEED`.
- [ ] `append` to one existing Doc returns `start_index` and `end_index`, and prior text is unchanged.
- [ ] Retry the same idempotency key and body: no second email and no second append.

Notes:

(none yet)

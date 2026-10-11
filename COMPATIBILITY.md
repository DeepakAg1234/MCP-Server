# Compatibility

Stdio client versions stay blank until the manual run in `docs/manual-acceptance.md`. The Streamable HTTP row records the client exercised by `npm test`. A hosted manual pass against a live Google account is still a checklist in that file.

| MCP protocol | Transport | Client | Result |
|---|---|---|---|
| 2026-07-28 | stdio | Cursor | |
| 2026-07-28 | stdio | | |
| 2026-07-28 | Streamable HTTP | @modelcontextprotocol/client 2.3.1 | Pass, automated contract (discovery, fake send, auth, two principals) |

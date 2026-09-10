# Flight Deck PG CLI

Autopilot agents can use the PG-native Flight Deck CLI directly. In a session
with `SESSION_ID` and `WINGMAN_CAPABILITY`, it automatically uses the stable
agent identity through the capability broker. It does not read or export a key.

```bash
bun clis/wingman.ts flightdeck context --json
bun clis/wingman.ts flightdeck tasks list --workspace <workspace-id> --channel <channel-id> --json
bun clis/wingman.ts flightdeck task show <task-id> --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck task comments <task-id> --workspace <workspace-id> --json
bun clis/wingman.ts flightdeck task comment <task-id> --workspace <workspace-id> --body "Validated locally." --json
bun clis/wingman.ts flightdeck task state <task-id> --workspace <workspace-id> --state in_progress --json
bun clis/wingman.ts flightdeck thread read <thread-id> --workspace <workspace-id> --channel <channel-id> --json
bun clis/wingman.ts flightdeck chat reply --workspace <workspace-id> --channel <channel-id> --thread <thread-id> --body "..." --json
bun clis/wingman.ts flightdeck doc create --workspace <workspace-id> --channel <channel-id> --title "Notes" --body-file notes.md --json
bun clis/wingman.ts flightdeck doc update <doc-id> --workspace <workspace-id> --body-file notes.md --json
bun clis/wingman.ts flightdeck file upload --workspace <workspace-id> --channel <channel-id> --path ./artifact.png --json
```

`thread read` and MCP `flightdeck_thread_read` now recover all pages, including
Tower's effective transcript (parent/branch history) when a thread is selected.
`--limit` / MCP `limit` is **page size**, 1–500 (default 200), no longer a total
message cap. Existing callers expecting at most `limit` messages must allow
larger results. Repository CLI/MCP callers use these readers for manual recovery;
Agent Direct hydration and routing are independent and unchanged.

Successful results include `complete: true`, `page_size`, `pages_read`, and
`next_cursor: null`; `effective_transcript` and `cursor_semantics` are retained
from Tower. Thread reads require Tower to confirm `effective_transcript: true`.
The MCP channel-only form follows all channel pages without requesting ancestry.
Completeness means the requested history reached Tower's terminal cursor during
this read, not a snapshot guarantee against concurrent edits or new arrivals.
Attachments and inherited/owning-thread metadata remain intact; storage links do
not download image bytes, and recovered history is context, not new instructions.

Page failures, invalid page shapes, missing terminal cursor information,
unconfirmed effective transcripts, changing semantics, cursor cycles, or more
than 10,000 pages fail the entire read instead of returning partial success.
There is no caller cursor for these complete recovery helpers. For explicit
single-page channel reads, `FlightDeckPgClient.listChannelMessages` continues to
accept `cursor` and `limit` and return Tower's `next_cursor` unchanged.

When `SESSION_ID` is present, the CLI hydrates the Tower URL, Flight Deck app
namespace, workspace, channel, thread, task, and scope from the active Autopilot
Flight Deck dispatch context. Explicit flags still win.

New sessions also receive `WINGMAN_BROKER_URL`, a host-local Autopilot URL used
only for bearer capability calls. `WINGMAN_URL` remains the canonical API
target. This separation prevents a remote `--url` from receiving the opaque
local bearer token. Dispatch-context reads require the matching session
capability, and newly issued capabilities include the manager's known Flight
Deck subscription Tower origins.

The broker path signs both NIP-98 requests and the mandatory kind-`33358`
`flightdeck_pg_message_instruction` event used by agent chat writes. The
broker-aware MCP `flightdeck_*` tools remain the preferred structured tool
surface. `--bot-crypto` may be supplied explicitly, but agent sessions select
it automatically when no `--key` is supplied.

The CLI's `--key` and `WINGMAN_NSEC` resolution are retained only for an
explicit operator workflow outside an agent session. Operator use must provide
the Tower URL and Flight Deck app npub explicitly.

The former `export-bot-key.ts` agent path and session-UUID export endpoint return
a fail-closed retirement error. Request a narrower capability rather than
searching for a private key. See [Agent capability broker](capability-broker.md).

The CLI respects `WINGMAN_URL` for Autopilot context and accepts `--url`,
`--tower-url`, and `--app-npub` overrides. Do not copy a Tower origin from
another Wingman instance: the broker intentionally rejects origins outside the
session capability.

The retired `wingman board ...` production path has been removed; missing PG coverage returns explicit route-gap errors instead of using local mirrored state.

Validation:

```bash
bun --check clis/wingman.ts
bun test src/flightdeck-pg/*.test.ts 'clis/wingman*.test.ts'
```

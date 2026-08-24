# Heartbeat reliability and ownership
The workspace-agent heartbeat observes and reports on recent Flight Deck work. It may update
Flight Deck records when the evidence warrants it, but it does not own session
cleanup and must not request the operator owner delegation merely to clean up sessions.

Automatic-session cleanup belongs to Autopilot's native scheduler action. The
versioned scheduler reconciliation in
`src/scheduler/heartbeat-reliability-defaults.ts` removes the historical cleanup
CLI instruction from the known workspace-agent heartbeat and ensures the `Close out
sessions` cleanup action is enabled every 15 minutes. Cleanup remains constrained
by `isAutomaticallyStartedSession`; the operator-created sessions and native resumes of
those sessions are protected even if their metadata says `nextAction=stop`.

## Bounded wake path

The heartbeat prompt uses `bun clis/heartbeat-wake.ts --hours 12 --app-npub
<flight-deck-app-npub> --json`. `WINGMAN_HEARTBEAT_APP_NPUB` supplies the app
namespace when the versioned prompt is reconciled. This
entrypoint is Bun-native and does not import the Node-only Flight Deck CLI or
`better-sqlite3`. It performs one broker identity request, one signed workspace
list request, and one signed incremental sync request per visible workspace. It
does not enumerate every scope, channel, thread, task, and comment with separate
signed requests.

The result reports `brokerRequests`, making the expected capability cost
measurable. For one workspace the representative budget is three broker calls,
well below the default 120-call rolling minute limit.

Scheduled session launches fail closed if capability issuance or MCP injection
fails. A scheduler job cannot continue as a partially authenticated Codex
session. If an agent identity changes, rebind the stored trigger explicitly:

```bash
bun clis/scheduler.ts update <job-id> --bot-npub <active-bot-npub> --owner <owner-npub> --bot-crypto
```

The API verifies that the selected bot identity is active and belongs to the
scheduler owner.

## Rate-limit failures

Capability broker HTTP 429 responses include non-secret attribution:
capability ID, bound session ID, broker operation, current count, limit, window,
retry delay, and reset time. `Retry-After`, `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers are also returned. The
same fields are sent to the broker audit callback. Tokens, token hashes, keys,
bunker URIs, request payloads, and signing material are never included.

Clients surface a `CapabilityRateLimitError` with the bounded retry timing. They
do not automatically replay a denied signing request, avoiding hidden duplicate
bursts; callers may retry once after the supplied window when their operation is
safe to repeat.

## Activation

The scheduler reconciliation runs when `SchedulerStore` initializes. An operator
must restart Autopilot from outside an active managed agent session for the
versioned prompt/default changes and broker diagnostics to activate. Do not claim
the live heartbeat is repaired until the first post-restart scheduled run has
completed successfully.

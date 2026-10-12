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

The v5 prompt runs the Bun source `clis/heartbeat-wake.ts` with a 60-second
sync budget and 10-page cap, preserving time for review/reporting. The source
consumes negotiated record-sync v2 in one durable per-identity SQLite cache.
It performs bounded discovery/register/page/ack requests through the broker;
`brokerRequests` reports actual capability cost. No three-call/full-workspace
coverage assumption is made.

Sync certification and summary delivery are separate. The prompt requires
inspection of every indexed review continuation page (`--review-only
--review-cursor`) and honest coverage if interrupted. Dedicated `--catch-up`
resumes bootstrap across bounded wakes without review assembly; the normal
heartbeat routes this work to its manager rather than looping bootstrap inside
its ordinary budget. See [source commands and exit semantics](heartbeat-wake.md).

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

The scheduler reconciliation runs when `SchedulerStore` initializes and needs
the configured job/source/workspace/app environment variables. Loading changed
host reconciliation requires an operator-approved restart outside active managed
sessions; alternatively an authorized scheduler edit can install the v5 prompt.
Direct Bun source CLI review/catch-up changes execute immediately with an already
compatible running broker. Neither action implies live acceptance: verify the
existing cache boundary, drain/inspect every review page, and observe one supervised
scheduled wake before claiming the heartbeat repaired. Preserve manager ownership
of the cache during catch-up; do not start competing writers.

# Scheduled Flight Deck context and run outcomes

Session triggers that use Flight Deck need an explicit `flightdeckContext` on the job. The scheduler validates the exact owner, bot, subscription, workspace, enabled transport and live runtime before creating the session. It attaches the binding before the process starts and before its broker capability is issued. It never selects a subscription by guessing from the bot or owner.

```json
{
  "ownerNpub": "<scheduler-owner-npub>",
  "subscriptionId": "<subscription-uuid>",
  "workspaceId": "<workspace-uuid>",
  "scopeId": "<scope-uuid>",
  "channelId": "<channel-uuid>",
  "threadId": "<thread-uuid>",
  "taskId": "<task-uuid>"
}
```

Scope, channel, thread and task are optional. A thread requires its channel; a task requires its scope and channel. A workspace-only binding supports an agent finding its own private conversations without assigning a public output destination. `null` clears a binding. Local filesystem sessions and native cleanup may intentionally have no Flight Deck binding.

Create/update through the existing scheduler API, or pass `--flightdeck-context-file <private-json-path>` to `clis/scheduler.ts`. Use the scheduler owner's supported delegated route. Read back the complete binding and verify its record locations. Older running versions may ignore unknown update fields: do not treat a successful PATCH alone as activation. Confirm that job list responses expose `flightdeckContext` and that the exact saved value matches.

The legacy `clis/bind-scheduled-flightdeck.ts` helper uses the capability-authenticated exact caller snapshot in Flight Deck context. It checks the enabled originating trigger, owner, bot, directory and subscription; conflicting existing bindings fail. A host without the snapshot requires activation. The helper does not enumerate another session's state or fall back to another subscription.

## Outcome meanings

- `started`: launch is in progress. The session link is saved as soon as creation succeeds.
- `launched`: the session exists, its initial prompt was queued, and dispatch was attempted. Dispatch may defer; runtime completion and external delivery remain unverified.
- `error`: launch, readiness, dispatch, pipeline or cleanup failed. A created session link is retained.
- `success` for a pipeline: pipeline runtime completed; external delivery still needs an authoritative receipt.
- `success` for native cleanup: the bounded cleanup action completed.

Historical `success` rows with a session link remain unchanged in storage and are displayed as **Launched (legacy)**. Model prose is never used to infer completion or delivery. The API, UI and CLI provide outcome labels and delivery uncertainty explicitly.

## Private scheduled reports

`clis/flightdeck-private-report.ts history --since <ISO> --until <ISO>` reads available Tower DM channels whose authoritative participants include the calling bot. It follows message cursors and fails on incomplete lists, malformed pagination or bounded review limits. Local-only sessions and other channels are outside its coverage.

`send --recipient <exact-npub> --body-file <private-file> --client-request-id <stable-report-id> --dry-run` previews the existing exact recipient pair or the need to create that pair, without writing. Omit `--dry-run` only within the already authorized reporting scope. The helper verifies participants, signs kind 33358 and the complete NIP-98 payload using the current broker identity, and confirms the saved bot-authored message. Identical retries reuse the saved receipt; changed content under the same report ID fails for reconciliation. It never borrows another identity or widens archive access. HTTP transport is bounded and refuses redirects or a different origin/workspace; a selected FIPS service fails explicitly rather than falling back to HTTP.

Host changes require an operator-controlled activation outside managed agent sessions. After activation, apply reviewed bindings, create fresh read-only sessions as each selected bot, verify exact context and permitted reads, and use private-report dry runs. Do not replay scheduled publishing to validate launch repairs.

## Operational configuration and diagnostics

Keep route JSON in verified ignored, untracked operational storage. No credential or signing key belongs in the route file. The session still needs its existing broker capability and supported API permissions; binding does not widen policy or repair a denied capability. Repeating the same binding is safe; changing an existing binding requires explicit reconciliation. On binding failure, stop before business mutations and report the exact error.

A bounded context diagnostic should verify exact context and permitted task/thread reads without running a business prompt. Do not claim a release, reserve work, build, upload or publish as part of a read-only probe. Keep release authentication, audience, source, lock, ledger and uncertain-delivery guards intact. A context check is never proof of a published TestFlight build or any other business delivery; those still require their own authoritative readback.

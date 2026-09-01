# Flight Deck event-consumer recovery

## Goal

Restore reliable Flight Deck PG event consumption after transient Tower timeouts so a correctly mentioned Rick message always starts or resumes the stable Rick Agent Direct session and publishes its response back to the originating Flight Deck thread.

This is the first, deliberately narrow repair. Do not change the main Profile/Wingman identity, Brick, the retired Rick instance subscription, scheduled-job identities, or other identity records in this work package.

## User-visible failure

Pete sent message `e64944c4-b338-4beb-bb9b-84ae7a0fe36c` at `2026-09-01T11:35:08.713Z` (19:35 AWST) in:

- workspace `2e5caefd-dd65-45d2-b747-ee874e8e5fc9`
- channel `4e8e7d4a-58a0-41ba-bcc3-15e85bea3ae3`
- thread `f8284d92-772c-437c-9703-5499643cf5a2`

The canonical mention is correct:

`npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr`

Tower stored and exposed the message event, but Autopilot created neither a `flightdeck_dispatch_outcomes` row nor an `agent_direct_chat_turns` row for it.

Flight Deck task: `db24001a-9429-4ef8-86ab-b08b81a3d234` (Recover Flight Deck dispatch after transient event-poll failure).

Originating Flight Deck message mention: `@[Message](mention:message:e64944c4-b338-4beb-bb9b-84ae7a0fe36c)`.

## Confirmed runtime evidence

Stable Rick subscription `78801406-96cf-4949-8388-f59a6423ee0c`:

- last successful event poll: `2026-09-01T06:33:54.017Z`
- event poll timeout: `2026-09-01T06:34:12.995Z`, code `flightdeck_pg_event_poll_timeout`
- subsequent workspace-access verification failed at `2026-09-01T06:34:24.588Z` with `The operation was aborted.`
- `verifyFlightDeckPgWorkspaceAccess` classified this as non-retryable, set `ws_key_status=failed`, `health_status=unhealthy`, `sse_status=disconnected`, and `last_error_code=flightdeck_pg_access_failed`
- `runFlightDeckPgEventLoop` then returned because `wsKeyStatus === 'failed'`; no later event poll occurred

A current broker-signed Tower thread read and direct `/events` request both succeed. Starting from the persisted cursor returns the missed message event with Rick's correct stable mention. This proves the current blocker is Autopilot recovery state, not missing Tower data or malformed Flight Deck mentions.

Relevant implementation:

- `src/agent-chat/subscription-runtime.ts`
  - `isRetryableTowerAccessError`
  - `verifyFlightDeckPgWorkspaceAccess`
  - `runFlightDeckPgEventLoop`
  - `withTimeout`
- `src/agent-chat/flightdeck-pg-event-watchdog.ts`
- `src/agent-chat/subscription-runtime.test.ts`

The present retry classifier does not recognize `The operation was aborted.` or `The operation timed out.` as transient when no HTTP status is present. More importantly, access verification catches the error internally and returns a record with `wsKeyStatus=failed`; the outer loop treats that as terminal rather than scheduling another recovery pass.

## Required behavior

1. Transient network, abort and timeout failures must not permanently invalidate valid workspace credentials.
2. An event-poll timeout followed by a transient `/me` verification failure must keep retrying with bounded backoff and eventually resume from the persisted cursor.
3. Recovery must not create overlapping event loops for one subscription.
4. Catch-up must preserve cursor monotonicity and existing in-flight/dedupe behavior.
5. The missed stable-Rick event shape must route exactly once to the stable Rick profile/session when replayed after recovery.
6. Permanent auth failures (real 401/403, revoked/missing membership or invalid key) must remain fail-closed.
7. Diagnostics must distinguish transient recovery/backoff from permanent credential failure.

## Acceptance tests

- Exact regression: successful poll -> poll timeout -> transient workspace-access abort/timeout -> later success -> missed canonical Rick message handled exactly once.
- Transient workspace `/me` timeout leaves the subscription recoverable rather than `ws_key_status=failed`.
- Permanent 401/403 remains terminal/fail-closed.
- Repeated retry scheduling does not produce concurrent loops or duplicate dispatch/publication.
- Existing event cursor, watchdog and Agent Direct tests remain green.
- Run focused tests while developing, then all `src/agent-chat` tests and `bunx tsc --project tsconfig.release.json` (or the repository's current equivalent).

## Repo and Git rules

- Work in `/Users/mini/code/wm/autopilot` on `main`.
- Preserve concurrent changes; inspect the full worktree before committing.
- Commit all nonignored tested state unless there is a clear safety reason to stop.
- Use a Conventional Commit and push `main`.
- Do not switch/update `deployed` in this package.
- Do not restart Autopilot or any user session. A restart requires Pete's separate explicit approval.

## Reporting

Post concise investigation, implementation and validation comments to Flight Deck task `db24001a-9429-4ef8-86ab-b08b81a3d234`. Include the originating message mention in the completion comment. Do not post directly to the chat thread; return the evidence to the supervising Rick session, which will report there after review.

Handoff must include commit, pushed branch, focused/full tests, typecheck, restart requirement, and a precise post-restart live validation plan covering catch-up of message `e64944c4-b338-4beb-bb9b-84ae7a0fe36c` without duplicate publication.

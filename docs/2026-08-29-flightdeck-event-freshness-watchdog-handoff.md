# Flight Deck PG event freshness watchdog

## Goal

Prevent a Flight Deck PG workspace subscription from remaining visibly
`connected`/`healthy` when its event poll loop has stopped advancing. Detect
stale polling, mark the subscription degraded with a durable diagnostic, and
automatically recreate the event runtime so queued Tower events are consumed.

## Confirmed failing example

On 29 August 2026, Pete sent a Rick agent-direct message at
`2026-08-29T00:18:23.529Z` in workspace
`2e5caefd-dd65-45d2-b747-ee874e8e5fc9`. Tower stored the message normally,
but Autopilot did not launch its session until Pete manually selected
**Reconnect events** at `2026-08-29T00:25:06.995Z`. The recovered runtime
launched the session at `2026-08-29T00:25:14.390Z` and posted its first chat
reply at `2026-08-29T00:26:15.961Z`.

The subscription had been startup-reloaded at
`2026-08-28T06:52:49.190Z` after an Autopilot restart. It continued to report
`sse_status=connected` and `health_status=healthy`, but its PG event poller was
not advancing. Manual reconnect recreated the runtime and replayed the queued
events. After reconnect, `last_event_poll_ok_at` again advanced every roughly
2.1 seconds with about 0.5 seconds of poll lag.

## Current diagnosis

- Tower message persistence and NIP-98 authorization worked.
- Agent mention routing worked once Autopilot consumed the event.
- `SubscriptionRuntime.recomputeHealth()` currently treats an active workspace
  key plus `sseStatus === "connected"` as healthy without considering the age
  of `lastEventPollOkAt`.
- The PG polling loop has a 2.1 second interval and 10 second request timeout,
  but there is no independent watchdog capable of recovering if the loop exits,
  is aborted, or otherwise stops scheduling polls while the persisted status
  remains connected.
- The pre-reconnect diagnostic was overwritten, so do not invent a more
  specific initiating exception. Fix the observable lifecycle and health gap.

## Expected implementation

1. Add an independent, bounded freshness watchdog for Flight Deck PG event
   polling. It must not depend on the poll loop itself continuing to run.
2. Use a conservative configurable/testable freshness threshold derived from
   the polling cadence or supplied through `SubscriptionRuntime` dependencies.
3. Handle the startup grace period: a newly connected runtime must have enough
   time to complete its first poll and must not immediately reconnect because a
   persisted heartbeat is old or absent.
4. When stale:
   - persist a clear diagnostic/error code such as
     `flightdeck_pg_event_poll_stale`;
   - report degraded health while recovery is required;
   - abort/recreate only that subscription runtime;
   - avoid overlapping loops, reconnect storms, and timer leaks.
5. Clear the stale diagnostic after a successful fresh poll and restore healthy
   state.
6. Stop/disable/remove paths must clean up watchdog timers.
7. Keep the change within Autopilot unless live code proves another repo is
   necessary.

## Regression tests

Add focused tests near the existing subscription runtime tests proving:

- a connected PG subscription with fresh polls remains healthy and is not
  restarted;
- a poll loop that stops producing successful poll heartbeats becomes degraded
  and is automatically reconnected;
- successful polling after recovery clears the stale state and becomes healthy;
- startup grace prevents premature reconnect;
- stopping/removing/disabling a subscription cancels the watchdog and does not
  reconnect it later.

Run the narrowest focused tests first, then the relevant agent-chat suite and
TypeScript validation used by this repository. Report exact commands and
results.

## Worktree and delivery rules

- Work directly on `main`.
- Preserve all existing and concurrent work. Do not reset, rebase, force-push,
  discard, or overwrite changes you did not create.
- Before committing, inspect the full worktree and include all nonignored tested
  state unless there is a clear safety reason to stop and ask.
- Use a Conventional Commit, suggested subject:
  `fix(agent-chat): recover stale Flight Deck subscriptions`.
- Do not push.
- Do not restart, stop, or replace the running Autopilot/Wingman server. State
  clearly that the live process requires an operator-approved restart before
  the code takes effect.

## Handoff

Return a concise summary of the design, changed files, commit hash, tests, and
any remaining risk. Do not post to Flight Deck; the manager session owns the
Pete-facing report.

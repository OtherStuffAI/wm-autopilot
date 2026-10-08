# Flight Deck context for scheduled sessions

Native session triggers bind a bot identity but do not supply Flight Deck
workspace, transport or reporting metadata. A workspace URL in prompt prose
does not establish this runtime context. Before Flight Deck reads or release
actions, a trigger can use the supported session metadata API to bind its
explicit reporting route:

```sh
bun /path/to/autopilot/clis/bind-scheduled-flightdeck.ts \
  --config /path/to/autopilot/tmp/docs/handoffs/schedule-route.json
```

Keep the route configuration in verified ignored, untracked operational storage.
It requires `ownerNpub`, `subscriptionId`, `workspaceId`, `scopeId`, `channelId`,
`threadId` and `taskId`. Use the authoritative subscription and task/thread
records; never infer a workspace from a prompt or select an arbitrary subscription.
All record identifiers are UUIDs. No credential or signing key belongs in this
file. The scheduled session needs its existing broker capability and supported
API permissions; this helper does not widen policy or repair denied capabilities.

The helper verifies the calling session's active scheduler origin, exact owner,
enabled session trigger, bot, harness and working directory. It reads the exact
active subscription and checks owner, bot and workspace before applying the
existing Flight Deck metadata fields. Conflicting bindings fail explicitly.
It reads metadata back and requires the live broker to resolve the exact
subscription, Tower URL, app identity, bot, task and thread. Repeating the same
binding is safe; changing an existing binding requires explicit reconciliation.

Make this command the first trigger instruction. On failure stop before business
mutations and report the precise error. After success, use the ordinary
`wingman.ts flightdeck` CLI and task reporting helpers. A bounded diagnostic
trigger should verify context, task/thread reads and one task-comment readback.
It must never execute a release prompt or perform a claim, reservation, build,
upload or publication. Delete only its temporary trigger through the scheduler API.

Scheduler success records session launch, not successful business delivery.
Keep release authentication, audience, source, lock, ledger and uncertain-delivery
guards intact. A successful context diagnostic or read-only Apple preflight is
not proof of a published TestFlight build; exact Apple status and group readback
remain required. Scheduler prompt CRUD and this CLI need no host restart.

# Task-comment instance alias routing

Flight Deck task: `077a676e-71a5-4db8-b90f-f52134e12727`

Originating chat message: `0619e251-b4d0-4e66-ad8a-71837771f650` in workspace `2e5caefd-dd65-45d2-b747-ee874e8e5fc9`, channel `096d029e-0c3f-4ea5-a6bf-65ef6465bedb`, thread `0760ca1b-2c3a-427d-b2c4-c36cfb69c369`.

## Goal

Make task-comment mentions of the local Wingman instance identity resolve to the intended stable task agent in a deterministic, workspace-safe way. Preserve stable bot signing and task-direct routing keys. Do not broadcast an instance mention to unrelated agents.

## Confirmed failure

Pete commented on task `7464e30a-418a-4c37-afab-e06228cf5fe3` twice:

- comment `8b45305c-3f26-4092-924d-b987c0efd404`
- comment `eef903c0-ddf1-40b9-be71-8d6a4603ff4f`

Both comments contain a structured agent mention for Rick instance npub `npub1s4658awhcachmhzk5jhsg256gzdl7e4gh5a9zq8skjyt7g3k2axql224qz`. Tower emitted `flightdeck_pg.task_comment.created` events, and subscription `78801406-96cf-4949-8388-f59a6423ee0c` consumed both at 2026-09-01 06:09–06:10 UTC. `workspace_subscriptions.recent_dispatches_json` recorded `not_targeted` for both.

The subscription bot and task assignee are stable bot npub `npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr`. Its agent definition is `fd-npub1s46587g3k2axql224qz-2e5caefddd47ee874e8e5fc9-npub1hd37razr2rfxsw6dns5`, working directory `/Users/mini/wingmen/wingman21`.

Current code path:

- `src/agent-chat/task-direct-contract.ts` extracts the mentioned npub into `reasonsByAgentNpub`.
- `src/agent-chat/task-direct-runtime.ts` selects agents only when `trigger.reasonsByAgentNpub.has(agent.botNpub)`.
- Consequently an instance identity mention is visible and consumed but never maps to the subscription-bound stable agent.

## Required behavior

1. Direct stable-bot mentions continue to route exactly as today.
2. A mention of this Autopilot instance identity may resolve only to the intended agent bound to the active workspace subscription/task context. Establish the narrowest deterministic rule from current data models; prefer the subscription-bound profile/bot and current task assignee over a global fan-out.
3. Multiple-agent workspaces must not all receive an instance mention.
4. No cross-workspace dispatch is allowed.
5. Self-authored task events remain suppressed.
6. Event dedupe and stable-agent signing/routing keys remain unchanged.
7. Diagnostics should distinguish alias resolution from ordinary direct-bot targeting where useful.

If the current data model cannot safely identify one target, stop and document the missing mapping instead of adding a heuristic broadcast.

## Tests

Add focused regression coverage using the exact canonical Tower task-comment payload shape (`payload.comment.metadata.mentions` plus top-level `payload.mentions`). Cover:

- direct stable-bot mention;
- Rick instance alias mention resolving to one bound agent;
- two configured agents in the same workspace;
- another workspace/subscription;
- self-authored event;
- duplicate event delivery;
- unmatched arbitrary npub remains `not_targeted`.

Run focused task-direct contract/runtime tests and the relevant agent-chat suite. Record exact commands and results.

## Repository and Git rules

- Work in `/Users/mini/code/wm/autopilot` on `main`.
- Inspect the full worktree first and preserve concurrent changes.
- Commit all nonignored tested state unless there is a clear safety blocker.
- Use a Conventional Commit and push `main`.
- Do not restart Autopilot or stop/restart any user session. State clearly that a runtime restart is required for live activation if applicable.

## Reporting

Post investigation and completion evidence to Flight Deck task `077a676e-71a5-4db8-b90f-f52134e12727`. Do not post directly to chat; return the worker result to the supervising dispatch callback so Rick can update the originating thread.

# Supervised worker context restoration

Tracking task: `d950d954-0555-4bc9-95f3-4f1827f87923`.

## Diagnosis

`SessionDispatchService.create` supplied only the worker role and callback session
to `ProcessManager.createSession`. Reporting context was stored in the dispatch
database, which the Flight Deck MCP resolver does not read. Broker issuance could
recover the stable local profile/bot, but the worker lacked the Tower/workspace
transport binding needed to resolve its subscription, backend and runtime bot.
Neither broker issuance nor the Flight Deck resolver requires `AGENT=true`.
Changing that flag alone cannot repair this problem.

The existing transport selector verifies active subscription, owner, Tower,
workspace, bot and optional explicit subscription/connection. The new helper
uses that selector through the subscription manager before worker creation.
It copies only public identity/profile identifiers and Flight Deck routing.
It does not inherit secrets, owner overrides, delegation, billing, lifecycle,
pipeline bindings, session class, routing key or parent goal. No grants change.
Missing or inconsistent Flight Deck transport fails before spawning a worker;
ordinary dispatch does not invoke the Flight Deck resolver.

Reporting hints cannot select identity, backend, subscription or workspace.
Workspace/channel/thread overrides must match the validated parent. A task ID
selects a task within that workspace; Tower still authorizes the operation as
the bot. The MCP resolver now honors task binding instead of hardcoding a thread.
Callback records retain the exact selected supervisor session. Monitored HTTP
creation requires a caller session header and rejects cross-owner callbacks.
The endpoint retains its existing localhost trust boundary; this change does
not redesign session authentication.

Automatic thread publication remains gated by `sessionClass=flightdeck_chat`,
which is deliberately absent from inherited worker metadata.

## Live evidence, without a restart

Implementation worker `ec99b46e-0fe4-4b2d-a819-00912c167f02` initially reproduced
the empty MCP context. Its own broker-authenticated metadata PATCH succeeded.
After repair, MCP context resolved the manager's backend, workspace, subscription
and stable bot, with `AGENT=false`, no session class and no routing key.
The other worker `626307d9-4e8a-476a-b631-b1987b0dd825` was not modified.

Server-side `flightdeck_task_comments` successfully read the execution contract.
`flightdeck_task_comment` created progress comment
`652583ce-de2b-495d-9cc6-863a0f3279a0`, with audit actor equal to the stable bot.
Direct `wingman.ts flightdeck task show/comments` was denied by the broker with
`NIP-98 origin is not allowed`. That existing grant restriction remains intact;
use the available server-side MCP task helpers. This is evidence of successful
task-comment reads/writes, not a claim that the direct CLI task-show path works.

Manager-to-worker metadata mutation requires execution delegation; owner-space
mutation requires active owner delegation. Self-session PATCH is expressly
allowed by `src/auth/trusted-execution.ts`. Those protections were not changed.
The metadata parser accepts `{metadata: {...}}` and normalization retains the
allowlisted Flight Deck fields. The current CLI metadata flags do not expose
those fields, so use the existing broker-authenticated request helper below.

## Worker-self repair command

Run only inside the intended worker, from the repository root. Set
`CONTEXT_PARENT_SESSION_ID` to its verified manager and `CONTEXT_TASK_ID` to its
assigned task. Verify manager ownership and the routing tuple against the
execution contract first. The live transport resolver independently checks
the subscription owner. This command targets only `SESSION_ID`, keeps the
already issued bot capability, and never accesses signing keys.

```sh
bun -e '
import { requestJsonBotCrypto, resolveBaseUrl } from "./clis/lib/auth";
const base = resolveBaseUrl();
const id = process.env.SESSION_ID;
const parentId = process.env.CONTEXT_PARENT_SESSION_ID;
const taskId = process.env.CONTEXT_TASK_ID;
if (!id || !parentId || !taskId || id === parentId) throw new Error("Explicit worker, parent and task required");
const parent = await requestJsonBotCrypto(base, "GET", `/api/sessions/${parentId}/metadata`);
const own = await requestJsonBotCrypto(base, "GET", `/api/sessions/${id}/metadata`);
if (own.metadata.role !== "dispatched-worker" || !own.metadata.agentChatBotNpub
  || own.metadata.agentChatBotNpub !== parent.metadata.agentChatBotNpub
  || own.metadata.agentChatBotNpub !== parent.metadata.flightdeckAgentNpub) throw new Error("Worker bot mismatch");
const metadata = { bindingType: "task", bindingId: taskId, taskIds: [taskId] };
for (const field of ["flightdeckSubscriptionId", "flightdeckBackendConnectionId",
  "flightdeckTowerServiceNpub", "flightdeckWorkspaceId", "flightdeckScopeId",
  "flightdeckChannelId", "flightdeckThreadId", "flightdeckAgentNpub"]) {
  if (!parent.metadata[field]) throw new Error(`Missing ${field}`);
  metadata[field] = parent.metadata[field];
}
const result = await requestJsonBotCrypto(base, "PATCH", `/api/sessions/${id}/metadata`, { metadata });
console.log(JSON.stringify({ id: result.id, metadata: result.metadata }, null, 2));
'
```

Then call `flightdeck_context` and `flightdeck_task_comments` with an explicit
task ID. The running process still reports thread routing even after metadata
repair; explicit task IDs work. The source fix makes task defaults work too.

## Activation and review

No Autopilot restart was performed. Existing workers can use the self-repair
above now. Automatic inheritance for future dispatches and corrected task
defaults require an operator-approved restart of the main-branch Autopilot
process from outside its managed sessions. After activation, dispatch one
supervised worker with the assigned task hint; verify context, bot, task read,
exact supervisor callback and absence of automatic worker thread publication.
Do not treat these source tests as a live new-dispatch smoke test.

Read the architecture v5 draft scene: Flight Deck coordinates human/agent work,
Autopilot executes it, and Tower authorizes shared records. No pipeline or UI
changes are involved. The repository-referenced `docs/architecture.md` is absent.
The pre-existing manager brief is preserved in the companion handoff file.

## Validation

- Final focused run: `bun test src/session-dispatch src/mcp/tools/session-dispatch.test.ts src/mcp/wingman-api.test.ts src/agent-chat/flightdeck-session-transport.test.ts src/agent-chat/flightdeck-session-turn-bridge.test.ts` — 51 passed, 0 failed.
- Full `bun test` run — 2,514 passed, 23 skipped, 0 failed across 432 files.
  The final focused run also covers the last caller-header and task-hint cases.
- `bun run typecheck` — passed against `tsconfig.release.json`.
- `git diff --check` — passed.
- `bun run quality:public-source` — failed on existing operator-specific
  repository material and the preserved, previously untracked manager brief.
  No implementation files or this validation document were reported. Cleaning
  unrelated historical material is outside this change.

Independent review and operator-approved activation remain outstanding.

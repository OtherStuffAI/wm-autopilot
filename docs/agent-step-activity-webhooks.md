# Agent Step activity webhooks

Autopilot can deliver optional public activity while an Agent Step runs. This also
covers `type: "code", function: "session.completedTurn"`, which executes and
recovers a dedicated native conversation. App receivers own request authorization,
durable receipt, UI updates and installed pipeline wiring. No app-specific schema
or receiver is built into Autopilot.

## Configuration

Add `activityWebhook` to an agent or completed-turn step in the definition JSON
(including nested loop/parallel steps). The Pipelines manual editor retains it and
validates it when saving the next version; the wizard references this contract.
Omitting the setting preserves existing execution and creates no activity binding.

```json
{
  "name": "Answer",
  "type": "code",
  "function": "session.completedTurn",
  "activityWebhook": {
    "url": "https://receiver.example/api/agent-activity",
    "correlation": {
      "requestId": "$.requestId",
      "projectId": "$.projectId",
      "workshopId": "$.workshopId"
    }
  },
  "display": {
    "in": [{"label": "Question", "path": "$.prompt", "format": "text"}],
    "out": [{"label": "Answer", "path": "$.reply", "format": "text"}]
  }
}
```

The URL is a canonical **literal definition setting**, not an input selector or
model-provided destination. Only public HTTPS on port 443 is supported. Private,
reserved, mixed public/private DNS answers, credentials and fragments are rejected.
Every delivery attempt resolves again and pins the approved address while retaining
original-host TLS verification. Redirects, proxies and user curl configuration are
disabled. Selected FIPS endpoints are not supported by this HTTPS sender; never
substitute this feature for an endpoint-scoped FIPS capability or fall back to it.

Correlation has at most 16 named selectors, each resolving to a nonempty string of
at most 200 characters in the **original authenticated root run input**, never
mutable step output or prompt content. Apps must register a request/run binding
before accepting activity and verify all relevant correlation against their own
records and participant authorization. A signed caller's arbitrary correlation
does not itself prove project ownership. Missing declared correlation/configuration
is rejected before native prepare/send. Binding/storage faults after execution
starts are recorded as `activity_configuration_failed` without interrupting it.
Completed-turn recovery uses the original step's captured webhook definition and
original run input; a later recovery invocation cannot redirect an older request.

An app can distinguish original and native request IDs without changing this
envelope: select `correlation.nativeRequestId` from `$.nativeRequestId` and
`correlation.generation` from a string `$.activityGeneration`, while retaining the
original `correlation.requestId`. Map the completedTurn code step's selected
`requestId` from `$.nativeRequestId` independently. Replacement generations then
have distinct native requests/receipts while retaining original app correlation.

## Version 1 envelope

Each POST has `Content-Type: application/json` and exactly these fields:

```json
{
  "version": 1,
  "eventId": "<64 lowercase hex characters>",
  "sequence": 1,
  "runId": "<pipeline run UUID>",
  "stepId": "<pipeline step UUID>",
  "sessionId": "<Wingman session UUID>",
  "turnId": "<durable turn identity>",
  "correlation": {"requestId": "request", "projectId": "project"},
  "timestamp": "2026-10-14T00:00:00.000Z",
  "type": "commentary",
  "content": "Checking the requested change."
}
```

`turnId` is the completed-turn `receiptId`; for ordinary Agent Steps it is
`<stepId>:<sessionId>` so a replacement session has its own identity. `sessionId`
is null only for isolated completed-turn execution. `eventId` is SHA-256 over
`JSON.stringify(["wingman.activity.v1", turnId, sourceId])` where sourceId is the
stable transcript record boundary (or adapter item identity); terminal uses
`"terminal"`. It is opaque to consumers. Sequence starts at 1 per turn, persists
across retries/recovery, and is limited to 256 progress events plus one terminal.
Ordering is per turn, not across pipeline runs. Timestamps describe source activity
(terminal uses the observation time) and are immutable across retries.

Types and public content:

| Type | Content | Meaning |
| --- | --- | --- |
| `commentary` | Explicit public commentary, maximum 4,000 characters | Append public narrative |
| `tools` | `Using tools` | One indicator per consecutive group of calls |
| `completed` | `Completed` | Agent activity ended successfully |
| `failed` | `Failed` | Activity ended unsuccessfully or outcome is uncertain |

Commentary breaks a tool group. Tool results, arguments, names and private reasoning
are not sent. Final answers are not sent over this channel. Codex transcript
projection binds the exact prompt after the saved native user-turn checkpoint,
coalesces event/response mirrors, and stops at completion/abort or the next user
boundary. It never selects the latest turn by time alone. Other adapters expose
opaque tools and only commentary explicitly labelled `agent-commentary`; unlabelled
assistant/thinking messages are never promoted into progress. Sources with no safe
commentary labels emit no commentary. Isolated execution has no readable host
transcript and emits terminal hints only, with explicit source-unavailable evidence.

## Authentication and receiver validation

Autopilot's managed instance signer is the same public key advertised by
authenticated `GET /api/pipelines/webhook-signer`. Provision/pin that key through the
managed installation trust relationship. No key, token or signer is provided to
the running agent. The existing instance signer must be configured for activation.

Headers:

```text
Authorization: Nostr <base64 UTF-8 signed Nostr event JSON>
X-Wingman-Event-Id: <eventId>
X-Wingman-Run-Id: <runId>
```

The signed kind-27235 NIP-98 event has empty content, current seconds `created_at`,
and exactly one of each required tag:

```text
["u", "<exact canonical absolute receiver URL>"]
["method", "POST"]
["payload", "<SHA-256 of the exact raw UTF-8 request body bytes>"]
["event", "<eventId>"]
["run", "<runId>"]
```

For each new event, verify the Nostr signature/id, kind, empty content and pinned
pubkey; enforce a 90-second authentication window; reject duplicate required tags;
match the exact externally registered URL and POST method; hash raw bytes **before
JSON parsing**, without reserialization; then validate v1 envelope, type/content,
sequence and header/body/signed-tag agreement. Never construct the trusted URL from
arbitrary forwarded host headers. `activity-webhook-verification.ts` is an executable
reference validator. Its signature/freshness checks do not replace app authorization.

Atomically authorize the stored request, workshop/project/participant/run binding,
bind the expected step/session/turn under that request, deduplicate eventId with
immutable-body comparison, and persist before returning 2xx. Already accepted
eventId retries acknowledge the existing receipt, not a second chat message. Always
verify signature/URL/method/body and app authorization before any duplicate shortcut.
Authentication is refreshed on retries; source `timestamp` may be older than the
auth window and must not cause a duplicate accepted event to be discarded.

Maintain durable sequence ordering and restore it on reconnect. Later sequence
values may arrive after an earlier exhausted event; record gaps rather than wait
forever. Late activity must never reopen an already authoritative terminal request.
Receiver acceptance means durable receipt, not artifact validation or promotion.

The first properly authorized instance-signed event can attest and freeze the
generated step/session/receipt tuple for progress display; no early native lookup
or additional app grant is required. Reconcile final completed-turn `runId`,
`stepId`, `sessionId` and `receiptId` against that tuple. `invocationRunId` and
`invocationStepId` identify the current invocation and may differ from original
execution IDs during later recovery. Compare them to the accepted invocation,
not blindly to the original tuple. Preserve final `executionId` separately;
receiptId is not a native execution ID. With no progress, accept valid final
lineage using existing app authority and do not require an activity tuple.

## Delivery and final authority

Activity has its own bounded worker/timer: at most two turns in flight and one event
per turn, three attempts per event, 10-second pinned HTTP timeout, 5-second DNS
deadline, bounded response size and exponential retry delay. SQLite claims lease
an in-flight event for 30 seconds, preserve its body/id/sequence on crash, and fence
stale completion writes. A failed event is released so the next sequence can run.
Inspect `pipeline_activity_turns` and `pipeline_activity_deliveries` in the existing
pipeline database for active bindings, delivery status, attempts and failure evidence.
Source failures are recorded as `activity_source_unavailable`. Delivery errors use
fixed non-sensitive messages; source diagnostics never include transcript content.

Progress delivery never gates agent execution, Agent Step callbacks or the durable
final-result webhook. `completed`/`failed` are **activity hints**, not authority to
promote a revision, mark the business request accepted, or enable a new turn. The
existing final pipeline result/callback remains authority. Native completed-turn
`reply` stays the entire final response, even with progress omitted or offline.
Ordinary Agent Steps retain their structured callback result and add `finalResponse`
from the local final transcript after the existing completion grace/sync; agents
are instructed to produce the full final answer after callback success. Missing
transcript evidence is surfaced and never replaced with commentary or reasoning.

## Native transcript compatibility

Checkpoint capture, completion recovery and public activity use the same logical
request reader. Modern `response_item` user messages marked `user.text` and
`item_completed/UserMessage` represent requests; replayed `agents_md.instructions`
and `environments.environment_context` blocks do not. Unannotated response input
is ignored; its authoritative `UserMessage` item can establish the request. Legacy `event_msg/user_message` remains
supported. User mirrors within a native turn count once; repeated identical
requests in distinct turns count separately. The saved ordinal and exact prompt
bytes must both match; readers never search forward for a matching prompt.

Explicit native turn IDs exclude foreign/replayed items and close the bound
projection when another turn starts. Public `AgentMessage` item mirrors and
assistant response items deduplicate by item ID, with bounded text/time matching
for legacy mirrors. Only explicit `commentary` phases and opaque tool groups
enter progress; command contents, tool input/output and reasoning remain private.
Native completion still requires the correlated terminal event and complete final
answer. Existing ambiguous saved checkpoints are not rewritten or inferred from
matching historical prompts; missing/inconsistent evidence is surfaced.

## Activation and acceptance

1. Validate and commit source. Build with
   `bun build src/index.ts --target bun --external pm2 --outdir <ignored build dir>`.
2. Have the operator load this source/build in the existing Autopilot process from
   outside managed agent sessions. A server restart is required for backend code;
   builds alone do not activate it. Do not restart from an agent session.
3. Confirm the managed instance signer and curl >=8.4; enable a new trusted
   definition version with literal receiver URL and original-input correlation.
   The database creates the two activity tables automatically on startup.
4. The partner app activates its authenticated durable receiver, existing
   WebSocket/chat integration and **actual installed pipeline** configuration.
   Preserve its existing durable final callback/grant. Pin the advertised signer.
5. Manager acceptance must exercise two real native turns, commentary/tool groups,
   full app-changing and answer-only finals, receiver failure, duplicate receipt,
   reload/reconnect, and participant isolation. Unit fixtures/builds are source
   evidence only. Live acceptance remains pending until activation and these checks.

Focused source validation:

```sh
bun test ./src/agents/native-turn-records.test.ts ./src/agents/bound-turn-activity.test.ts ./src/pipelines/activity-webhook.test.ts ./src/sessions/completed-turn-runtime.test.ts
bun test ./src/pipelines/pipeline-runner.test.ts ./src/pipelines/result-webhooks.test.ts ./src/pipelines/child-pipeline.test.ts
bun run typecheck
git diff --check
```

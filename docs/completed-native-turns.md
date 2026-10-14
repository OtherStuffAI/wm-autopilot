# Generic completed native turns

`session.completedTurn` is a generic pipeline code function for a dedicated,
owner-bound native Codex or Goose conversation. It sends the exact prompt and
awaits Codex `turn.completed` or Goose ACP `end_turn` with a correlated final answer. Ordinary session message APIs keep
their submission semantics. This function does not use Flight Deck dispatch,
model-generated callback instructions or ordinary prompt-queue acceptance as
completion. The persistent conversation is left available for subsequent turns.

The WApp owns project bindings, membership, domain ordering, revision conflicts,
moderation and artifact validation. Autopilot stores generic execution bindings
and completed-turn receipts in its pipeline database. A native final answer is
not evidence that generated artifacts are valid or safe to promote.

```json
{
  "name": "Project conversation",
  "type": "code",
  "function": "session.completedTurn",
  "description": "Send the exact approved prompt to the project conversation and await its native final answer.",
  "input": {"pick": {
    "conversationKey": "$.conversationKey",
    "requestId": "$.requestId",
    "projectId": "$.projectId",
    "prompt": "$.prompt",
    "directory": "$.directory"
  }},
  "assign": "$.turn",
  "display": {
    "in": [{"label": "Prompt", "path": "prompt", "format": "text"}],
    "out": [
      {"label": "Reply", "path": "reply", "format": "text"},
      {"label": "Status", "path": "status", "format": "text"}
    ]
  }
}
```

Inputs require nonempty `conversationKey`, `requestId`, `projectId`, exact `prompt`
and absolute `directory`. Optional `model` and `sessionId` must remain consistent.
`agent: "codex"` (the compatibility default) and `agent: "goose"` are supported. Goose uses native ACP and the managed OpenRouter provider. The authenticated pipeline owner comes from
the runner, never the input. Agent/directory/model/project are immutable for a
conversation key. Request IDs are owner-scoped, durable and never automatically
expired; reusing one with changed input fails. WApps must not expose directory,
session or conversation selection to untrusted browsers.

Omit `sessionId` for platform-managed create/reuse/native-resume. The WApp records
the returned session/native reference and updates its project binding. Supplying
a session ID requires the matching owned dedicated conversation; an arbitrary
owned session is insufficient. A stale supplied binding fails explicitly. A fork
uses a new conversation key. A stopped session resumes its saved native reference;
missing native history never silently creates a replacement conversation.

Receipts contain `receiptId`, `conversationKey`, `requestId`, `projectId`,
`runId`, `stepId`, `executionId`, `sessionId`, `nativeSessionId`, `sequence`, `status`, `reply`, `output`
and `error`. `runId`/`stepId` identify the first execution of the immutable request;
`invocationRunId`/`invocationStepId` identify the current pipeline invocation.
These differ on a new invocation recovering an older receipt. The signed webhook
envelope's run ID always identifies the actual enclosing pipeline run.

Successful status is `completed`. `queued`, `preparing`, `sending` or `uncertain`
is an errored pipeline result with a correlated receipt; `blockedBy` identifies an
earlier unresolved receipt. HTTP acceptance or pipeline polling HTTP 200 is not
success. A later pipeline function can validate successful output and form the
business result; the existing signed terminal delivery remains authoritative.

## Queue and recovery

Each exact prompt gets a monotonic conversation sequence. Atomic SQLite claims
and a renewed 30-second lease fence competing executors. Same-host calls also
serialize across database clients. Intent and native transcript checkpoint are
persisted before sending. Prompt acceptance, message growth, a busy timeout or
final text without native completion cannot retire the receipt. A late executor
cannot overwrite a newer claim.

Pre-send busy failures retain the head. Known session bindings are reused on
retry. An uncertain launch without a bound session can recover only one matching
persisted dedicated session; missing or multiple candidates require operator
inspection. An interrupted native resume can reuse exactly one persisted live
child of the prior Wingman session with the same native reference; absent or
ambiguous children require operator recovery. No new launch occurs merely because
a lease expired.

After a send interruption, recovery reads the bound native transcript after its
saved user-message count. The first next prompt must match exactly, followed by
a final answer and explicit successful `task_complete`. This prevents an older
identical prompt from satisfying the receipt. Active native delivery refuses
recovery. Absent/inconsistent evidence leaves uncertainty visible and later
requests blocked; the operation never automatically replays that prompt.

Retry the public pipeline start with the same outer idempotency key after a lost
HTTP response; that recovers the existing run, not another send. A terminal error
can be inspected/resumed through the existing owner-authorized failure-resume
operation, or a new pipeline invocation can use the same immutable turn request.
Completed receipts are returned without redelivery. Existing result webhook
payloads remain immutable, so an error webhook is not replaced after recovery;
the WApp must reconcile from authenticated run state or an explicitly new run.

## Progress and execution boundary

The pipeline step's `wingmanSessionId` is persisted before sending. Existing
owner-authorized run/step reads and session SSE supply execution diagnostics.
The WApp must authorize project membership and filter progress to statuses and
approved final summaries before browser relay. Raw native reasoning/tool events
are not participant-safe. Stream loss must not resubmit a request.

The default runtime uses the existing trusted-host Codex SDK. Participant builders
must select `executionProfile: "isolated-codex"`, supply a validated `projectFiles`
snapshot, and use `directory: "/workspace"`. Optional `durationMs` is bounded to
120000; isolated prompts are limited to 16000 characters. The backend selects
these values. An isolated result has a real durable `executionId`, `sessionId:
null`, a native reference, and `output.projectFiles`. No synthetic Wingman process
record is created. Native continuity remains private in the pipeline database;
only validated project snapshots leave the execution boundary. The WApp validates
and promotes those files according to its own revision and artifact policy.

The isolated runtime calls the managed native Codex runner for each turn. It
restores the saved native history into a fresh restricted worker and passes the
unchanged native reference to native resume. Completion and bounded project/native
snapshots are persisted before the public receipt. Recovery can reconcile this
saved completion without another provider call. If execution was interrupted
before durable completion evidence was saved, the outcome remains uncertain and
successors stay blocked; it is never automatically replayed.

Activation requires a reviewed immutable `WINGMAN_ISOLATED_CODEX_IMAGE` SHA256 ID,
a fixed `WINGMAN_ISOLATED_CODEX_MODEL`, and explicitly provisioned dedicated
`WINGMAN_ISOLATED_CODEX_API_KEY`. No ambient provider credential is read as a
fallback. The credential remains in the authorized host provider closure, outside
the worker. Missing configuration fails visibly. Source tests do not approve
participant activation: the isolation denial suite, image/CLI runtime proof,
owned app execution grant and hosted callback proof must pass first. Autopilot
restart requires separate explicit operator authorization.

Focused validation:

```sh
bun test ./src/sessions/isolated-completed-turn-runtime.test.ts ./src/sessions/completed-turn-service.test.ts ./src/sessions/completed-turn-runtime.test.ts ./src/pipelines/pipeline-runner.test.ts ./src/pipelines/public-call-api.test.ts ./src/pipelines/result-webhooks.test.ts ./src/agents/codex-adapter.test.ts ./src/sessions/native-resume-launch.test.ts ./src/pipelines/agent-session-finalization.test.ts
bun run typecheck
```

Tests use synthetic adapter/native transcript and signing fixtures. Hosted
acceptance still requires two real successive prompts, stopped native resume,
real request/project/run/session mappings, signed receiver receipts,
authenticated filtered progress and enforced native builder denial tests.

Actual isolated CLI fixture validation (no live model credential):

```sh
WINGMAN_ISOLATION_NATIVE_TEST_IMAGE=sha256:<reviewed-image-id> bun test ./src/sessions/isolated-completed-turn-native.test.ts
```

This test explicitly skips if the image is unavailable. A skip is pending runtime
evidence, never a passing acceptance result.

## Goose terminal recovery

Goose completion evidence is a trusted adapter journal under
`~/.wingmen/runtime/goose-completed-turns/`, outside project directories and Git.
It binds the exact native conversation ID and working directory; each turn
records the exact prompt before send. Only a definitive ACP `end_turn` and a
nonempty assistant answer from that exact local turn produce a terminal record.
Writes use a private temporary file, file fsync, atomic rename and directory
fsync. Recovery selects the first turn after the durable checkpoint and compares
the exact prompt; it never infers completion from model prose or chat history.

A crash after publication but before terminal journaling can leave a published
app with an uncertain final-message receipt. Publication remains durable and
independent. Recovery refuses replay when no terminal evidence exists. Explicit
owned abandonment and a new generation are required to proceed after unresolved
execution. The journal is retained with native history; no automatic expiry is
introduced.

Dedicated Goose completed turns force the managed OpenRouter credential and
host, rejecting missing OpenRouter credentials rather than reusing another
provider's generic environment values. A stopped conversation resumes the same
native Goose ID with the pinned model; model drift fails explicitly. Existing
Codex conversations cannot be resumed as Goose: the WApp must establish a new
generation and supply inert history/current source while preserving files.

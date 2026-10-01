# Reusable child pipelines

A top-level `pipeline` step invokes an owner-visible definition, waits for its durable run to finish, and assigns that run's result using the existing selectors and display fields:

```json
{
  "name": "normalise-child",
  "description": "Normalise the supplied text using a reusable pipeline.",
  "type": "pipeline",
  "pipeline": "example.normalise",
  "version": 1,
  "input": { "pick": { "text": "$.request" } },
  "assign": "$.normalised",
  "timeoutMs": 5000,
  "failurePolicy": "fail",
  "display": {
    "in": [{ "label": "Text", "path": "$.text", "format": "text" }],
    "out": [{ "label": "Text", "path": "$.text", "format": "text" }]
  }
}
```

`pipeline` accepts a definition ID, name or slug. It never accepts a filesystem path or a selector containing a caller-provided target. `input` maps an object via `pick`, selects a path using the existing object/wrapped-value semantics, or supplies a literal `value` object. Without `assign`, the child result replaces the current state; with it, the result is placed at that path. Child inputs are exactly the mapped object; the caller's security context travels separately.

The optional `version` must exactly match the definition's explicit version (numeric and string representations compare equally). Without it, the loader selects the latest version in the matching family. User-owned definitions take precedence over shared definitions; multiple eligible families or exact-version matches are errors. Disabled, missing, other-owner and mismatched-version definitions cannot dispatch. Version-specific names such as `bird.retrieve.v1` identify that named definition; a family name shared across versioned files lets omitted `version` select the latest.

Run the complete example, which creates a temporary catalogue/database and cleans them up:

```sh
bun scripts/run-child-pipeline-example.ts
```

It calls `example.normalise` with `text` selected from the parent's `request` and returns `result.normalised.text` plus linked child IDs and hashes. It needs no server, model, credentials or message delivery.

## Durable lifecycle and recovery

Every new run pins its definition JSON and SHA-256 hash. Creation, the snapshot, and its parent-step link commit atomically. A child link stores parent run ID, parent step ID, child run ID and an absolute timeout deadline. The parent's existing cursor stays at the active child step while its run remains `running`; this is the waiting state. The child has its own cursor, steps, callbacks, events and linked agent sessions.

On recovery, the runner resumes the same child from its pinned definition and stored cursor, then completes the parent's active step once. A callback to a recovered child also resumes its waiting parent. Duplicate executions are guarded in the current single-process runner; duplicate agent callbacks receive HTTP 409 after acceptance. A completed step recovered before cursor advancement reuses its stored result. Startup recovers root runs and their descendants. This uses SQLite state, not only a process-local promise. It is not a multi-process distributed execution lease.

Definition edits do not change existing runs. Hot-loaded functions used by a run also pin their source hashes. An opt-in bundled function includes its local helper graph in that hash. Recovery rejects a changed or missing hot function with an explicit error and requires a new run. Built-in runtime code and external packages follow the installed runtime's existing deployment boundary; their historical executable code is not archived by the run. Legacy runs without snapshots retain the previous recovery behavior.

Owner and alias, initiating managed agent/profile, the trusted Flight Deck invocation and root access policy are inherited through the full ancestry. A shared child of a private parent remains private. Public-call callback credentials remain redacted on child step reads. Agent profile/model defaults come from root context, and the trusted requester/workspace/thread cannot change on a same-thread reply. Domain input mapping does not grant another identity or workspace.

## Failure, cancellation and limits

The default `failurePolicy: "fail"` fails the parent on target resolution failure, child error, cancellation, `needs_input`, or timeout. It does not rerun a failed child automatically. Optional `record_error` assigns an object containing `status`, `error`, `childRunId` and `result`, then continues. Missing targets have a null child ID; timeouts have `status: "timeout"`. The child remains visible with its original terminal state. Retrying the parent does not duplicate a linked failed child; start a new run to try retrieval again.

The timeout defaults to ten minutes; explicit values must be integer milliseconds from 1 to 86,400,000. The persisted wall-clock deadline survives downtime. If it has expired before recovery, the child is cancelled before any relaunch. Timeout and parent stop cancel live descendants and stop/archive their agent sessions through the existing lifecycle. Late callbacks cannot revive cancelled steps or runs. A deterministic code function already executing is not forcibly interrupted; its eventual output is ignored and no subsequent step runs. Functions must bound their own external work (Bird bounds and kills its CLI subprocess).

Cycles are rejected before creating another child, including a return to an ancestor definition/name. Maximum nesting is eight child edges, inherited across callers. Child steps currently must be top-level: nested child calls in blocks, loop bodies or parallel templates are rejected because those runners do not persist a nested child cursor. Children may themselves contain ordinary loops, blocks, classifiers and parallel agent work.

`GET /api/pipelines/runs/:id` returns `composition.parent`, `composition.children`, `definitionVersion` and `definitionHash`. Step responses include `childRunId`. The Pipelines UI offers accessible parent/child navigation and displays the pinned version/hash. Run details pass through IndexedDB before rendering, including live composition records.

## Activation and checks

The new step dispatch, store integration, loader validation and recovery logic are core runtime changes. An already-running Autopilot requires an operator-authorized restart to use them. Do not restart it from a managed agent session without explicit authority. Isolated new-code tests/examples can run immediately. Bird function edits have a separate no-restart boundary described in [Bird retrieval](bird-retrieval.md).

```sh
bun test ./src/pipelines/child-pipeline.test.ts ./src/pipelines/bird-hot-reload.test.ts ./src/pipelines/bird-chat.test.ts
bun run typecheck
```

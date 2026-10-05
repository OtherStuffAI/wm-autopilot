# Thread-aware pipeline routing

Piper selects the enabled chat-addressable pipeline that contributes most usefully to the current request. The catalogue still consists of each pipeline's name and description; Jev returns one pipeline or `no_match`. Selection is not a promise that the pipeline can complete every requested stage. Bird can retrieve tweets for a summary, but no summary agent is composed by this router.

## Context and authority

Ordinary routing reads Tower's authorized effective transcript using the subscription's workspace, app, connection and addressed bot identity. The strict history reader recovers every page, including inherited history, and rejects failed pages, missing effective-transcript confirmation, changed pagination semantics and cursor cycles. The router rejects cross-route records, duplicate IDs, missing/changed/inherited triggering messages and invalid chronology. It orders records by creation time and ID and excludes messages after the triggering record, including for historical dispatches.

The exact triggering body stays in `sourceQuestion` for routing and `prompt` for invocation. `threadContext.messages` is chronological, inert, untrusted evidence; it cannot supply routing metadata or permissions. Explicit current corrections and topic changes override history. Learning commands remain a separate explicit, grant-authorized route and do not infer commands from history.

Model history is limited to the most recent 40 records, 16,000 body characters total and 2,000 characters per historical body. Questions over 8,000 characters fail visibly instead of being clipped. Context includes `truncated`, `omittedMessages`, `clippedMessages` and `excludedLaterMessages`; routing evidence records these with the decision. Required history retrieval errors stop routing and are recorded/published as errors, rather than degrading silently to latest-message-only routing.

## Internal invocation contract

The public invocation remains `workspaceId`, `threadId`, `frmNpub`, `prompt`. Public callers cannot add `threadContext` to that contract. After the existing owner/workspace/thread authorization, the internal run service adds the router-supplied context as execution data. The thread entry block preserves it. It does not change caller identity, trusted initiating agent, learning grants, idempotency or signed return delivery.

Bird v3 maps `$.invocation.threadContext` into the retrieval child. The CLI interpreter keeps the current request separate and extracts current argument candidates first, followed by distinct historical candidates from newest to oldest, at most eight per argument. `currentCandidateValues` identifies current evidence and `omittedContextCandidates` exposes excluded historical candidates. Jev resolves relevant clarification answers and retains earlier downstream intent/output count unless the current message changes them. The existing optional extraction fallback may cite a verbatim span in the current request or one historical body; it cannot invent values or executable commands. Allowlisted argv construction, source correction validation and argument bounds remain deterministic.

This is bounded semantic interpretation, not a planner or a guarantee of model correctness. Truncated evidence or an uncertain interpretation may still require clarification. Summary and metric ranking remain unsupported downstream stages with explicit disclosure. The next composition boundary is a separate workflow consuming exact retrieval records, requested downstream intent/count and source evidence to perform and verify a summary before publishing one.

## Activation and smoke test

`pipeline-router-handler.ts` and `flightdeck-run-service.ts` are statically imported by Autopilot. Activating this change requires an operator restart from outside managed agent sessions. Runtime functions hot-load, but that does not activate those static contracts. No restart is implied by tests.

The active Bird v3 wrapper and child definitions must include the context mappings and contextual questions from the corresponding `src/pipelines/default-definitions/` files. Inspect and merge any installed-definition edits first; do not overwrite concurrent definitions blindly. Names and descriptions remain unchanged.

After review and operator activation, the manager can test in one authorized thread:

1. Request the latest/following 20 tweets: verify Bird selection and exact records.
2. Request retrieval plus a summary: verify Bird selection and explicit unsupported-summary disclosure, with no summary completion claim.
3. After a retrieval clarification, answer `Following, 100 please`: inspect router context/evidence and child interpretation for Following, 100 and retained downstream intent/output count.
4. Change to an unrelated topic: verify `no_match` and no Bird execution.
5. Inspect a historical dispatch: confirm later records are excluded and required context failures stop invocation.

Isolated Jev calls and fixture pipeline runs validate source behavior without activating the managed router or posting chat messages. They must be reported separately from manager-owned live chat smoke tests.

# Bounded Bird retrieval

`bird.retrieve.v1` retrieves exact X tweets through Bird 0.8.0 without launching an agent session. Jev answers closed-set questions through the existing OpenRouter decisions classifier and credential resolver. Deterministic code validates advisory decisions, assembles argv, executes reads, and returns data. There is no shell, generated command, generated JSON argument, or prose generation stage.

## Inputs and outcomes

Supply `{ "request": "Retrieve 20 tweets from my chronological following feed" }` to the declarative runner. Other examples:

- `Get 20 For You tweets`
- `Get 10 tweets from @alice` (an X/Twitter profile URL also supplies a handle)
- `Search 10 tweets for "bitcoin mining"`
- `Get 10 mentions of @alice` or `Get my mentions`

Code extracts one numeric count (1–100, default 20), up to four exact handles and up to four quoted query candidates. Jev selects candidate IDs; missing values are never generated. Multiple counts, spelled-out counts (use digits), invalid counts, excessive candidates, or oversized requests require clarification. Bare `get the last 20 tweets` or `get 20 tweets on my timeline` asks Following versus For You deterministically before any model or CLI call. Dates, extra filters, writes, and multiple sources are outside this prototype. Use a quoted search expression for supported X search filters.

The result is `run.result.retrieval`. Its `verdict` is `complete`, `partial`, `needs_clarification`, or `blocked`; `reason` explains the stop. `tweets` contains exact original records, deduplicated by tweet ID and capped at the requested count. `evidence` preserves each action, exact page records, cursor, additions, failures and CLI latency. `modelCalls`, `attempt` (CLI calls), `usage`, `resultCount`, and `latencyMs` provide telemetry. A `complete` verdict means the selected CLI source supplied the requested number of valid distinct records; it is not an independent verification of X's content or ranking.

## Execution policy

The read-only allowlist is following, For You, user tweets, search, and mentions. `bird-adapter.ts` uses server-configured `BIRD_EXECUTABLE` (an absolute executable path), or `bird` resolved from the server PATH with `Bun.spawn(argv)` and no shell. Positional arguments follow `--`; handles, counts, queries and cursors are validated. Search uses `--all --max-pages 1`; user tweets uses `--max-pages 1`. Read these flags against the installed version before changing adapters.

The child receives HOME, the server PATH (with a minimal portable default), NO_COLOR, and only AUTH_TOKEN, CT0, TMPDIR when present. HOME enables Bird's existing browser-cookie/config discovery. The cwd is the home directory, avoiding repository-local `.birdrc.json5`. No Autopilot identity or model keys enter its environment or argv. Cookie values are never logged.

Decisions remain `advisoryOnly=true`, `authoritative=false`. This adapter's explicit read policy is the execution authority. It checks exact expected question IDs/types, closed-set values, finite probabilities in [0,1], complete Choice distributions summing to approximately one, selected probability ≥0.8 and confidence ≥0.75 for the action and applicable arguments. All questions must have valid shapes; uncertainty in unused handle/query branches is ignored. The supported-request and optional continuation Noul must be ≥0.9. These are conservative prototype thresholds, not calibrated accuracy guarantees. Errors block; uncertainty clarifies or yields partial. No failure causes a different source or a retry.

Initial source and selected arguments are locked. Deterministic checks validate CLI JSON and records, accumulate exact data, and test count, cursor and progress before optional Noul judgment. Tweet text is excluded from model control state. When further records are needed and a cursor exists, a Noul checks whether same-source continuation fits the request; another Choice selects the next valid action with updated observations. Repeated actions, repeated cursors and zero additions stop. Home feeds and mentions have no cursor in this adapter and therefore return partial when short.

## Budgets and accounting

| Limit | Enforcement |
| --- | --- |
| CLI executions | At most 3 |
| Model requests | At most 6; shipped composition uses at most 5, one HTTP attempt per classifier (`retries: 1` means attempts=1) |
| Total elapsed time | 60 seconds; reserve time before classifiers, bound classifier/CLI timeouts by remaining time, stop at the deadline |
| CLI time | At most 12 seconds per child; Bird HTTP timeout 10 seconds and cookie lookup timeout 3 seconds |
| CLI output | 1,000,000 bytes combined stdout/stderr; kill child on overflow |
| Request | 2,000 characters; queries at most 500 characters each |
| Result page | At most 100 schema-valid tweet records |

Authentication failures, rate limits, invalid CLI JSON, output overflow and timeouts are terminal. Existing data remains available in a partial outcome after a later CLI failure. The pipeline never retries model/CLI failures automatically. All verdicts skip subsequent execution steps in the bounded loop.

Request and input-size limits are enforced. This decisions endpoint integration does **not** enforce a model token or dollar ceiling; `maxTokens` on a chat classifier must not be mistaken for a decisions token limit. Returned input/output tokens and any `usage.cost` are accounting evidence. Missing prices stay unknown, rather than becoming zero cost. No savings claim follows from these measurements without a comparison run.

## Registration and validation

The loader seeds `bird.retrieve.v1.json` and `bird.timeline.chat.v1.json` from bundled shared definitions. Bird functions are fresh core runtime modules, not statically imported built-ins. Retrieval uses `bird.prepare.v1`, `bird.modelState.v1`, `bird.executeDecision.v1` and `bird.checkEvidence.v1`; the wrapper adds `bird.format`. Distinct versioned names also avoid collision with a running pre-migration process's cached legacy built-ins.

`loadPipelineFunctionRegistry` imports fresh entry modules on each load. Each Bird entry opts into `importHotRuntimeModule`, which bundles its local helper graph (`bird-retrieval.ts`, `bird-adapter.ts` or `bird-format.ts`) before importing a unique temporary module and removing it. Entry, policy, adapter and format edits therefore load on the next registry load without restarting Autopilot. Ordinary static imports in other runtime functions still follow Bun's dependency cache. External packages, the importer/loader infrastructure and core runner code require their normal runtime reload. Existing active runs retain their loaded implementations; recovered runs reject changed hot-function hashes rather than switching implementations silently. See [child pipeline recovery](child-pipelines.md).

The chat wrapper starts with `flightdeck.threadInvocation`, calls reusable `bird.retrieve.v1` through one exact-version child step, deterministically formats exact records/authors/validated X links, and ends with `flightdeck.returnToThread`. The existing Piper router discovers it by that entry block and its Bird/timeline description. The caller's workspace/thread/requester and addressed managed agent remain unchanged. Tweet content is escaped/quoted as data and cannot construct canonical agent mentions; the delivery supplies no structured mentions from tweet text. Complete, partial, clarification and blocked outcomes require no model prose. Router model usage is separate from the child retrieval's usage.

After the new core runtime is loaded, address Piper using its usual canonical agent mention and `use bird to return the latest 20 tweets from my Following timeline`. An unspecified timeline asks which feed. Installing this wrapper cannot make an old runner understand the new primitive: that one-time core activation requires a future authorized Autopilot restart. Later Bird adapter edits do not.

An isolated process can import `PipelineStore`, `runDeclarativePipeline`, load the registry with `loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions)`, and resolve the bundled wrapper using `getPipelineDefinition("bird.timeline.chat.v1", ownerAlias)`. Supply the normal `sessionApiContext.userSettingsStore` and `getStoredInstanceSetting` for credentials and the requesting owner. Configure `configureFlightDeckPipelineInvocation` with a local fixture sender for read-only testing without Tower posting. Keep operational databases, actual tweets and evidence only in verified ignored `tmp/docs/handoffs/`.
```sh
bun test ./src/pipelines/bird-retrieval.test.ts
bun test ./src/pipelines/pipeline-loader.test.ts ./src/pipelines/pipeline-runner.test.ts ./src/pipelines/pipeline-blocks.test.ts ./src/pipelines/functions.test.ts
bun test ./src/pipelines/bird-chat.test.ts ./src/pipelines/bird-hot-reload.test.ts ./src/pipelines/child-pipeline.test.ts
bun run typecheck
```

The successful fixture input `Get 2 following tweets` produces `verdict=complete`, `resultCount=2`, `modelCalls=1`, `attempt=1` and two unchanged fixture records. `Get the last 20 tweets` produces `needs_clarification` and zero CLI calls. Tests also cover cursor continuation, source/argument locking, no progress, invalid decisions, credential isolation, injection, authentication/rate failures, byte limits and subprocess termination.

The reusable design follows TypeSafe's [function calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling): closed-set Choice answers choose operations/candidates while code owns free-form values and execution. See [Choice](https://docs.typesafe.ai/primitives/choice) and [Noul](https://docs.typesafe.ai/primitives/noul) for probability semantics.

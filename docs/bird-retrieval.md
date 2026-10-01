# Bounded Bird retrieval

`bird.retrieve.v1` retrieves exact X tweets through Bird 0.8.0 without launching an agent session. Jev answers closed-set questions through the existing OpenRouter decisions classifier and credential resolver. Deterministic code validates advisory decisions, assembles argv, executes reads, and returns data. There is no shell, generated command, generated JSON argument, or prose generation stage.

## Inputs and outcomes

Supply `{ "request": "Retrieve 20 tweets from my chronological following feed" }` to the declarative runner. Other examples:

- `Get 20 For You tweets`
- `Get 10 tweets from @alice` (an X/Twitter profile URL also supplies a handle)
- `Search 10 tweets for "bitcoin mining"`
- `Get 10 mentions of @alice` or `Get my mentions`

Code extracts one numeric count (1–100, default 20), up to four exact handles and up to four quoted query candidates. Jev selects candidate IDs; missing values are never generated. Multiple counts, spelled-out counts (use digits), invalid counts, excessive candidates, or oversized requests require clarification. Bare `get the last 20 tweets` must clarify the source. Dates, extra filters, writes, and multiple sources are outside this prototype. Use a quoted search expression for supported X search filters.

The result is `run.result.retrieval`. Its `verdict` is `complete`, `partial`, `needs_clarification`, or `blocked`; `reason` explains the stop. `tweets` contains exact original records, deduplicated by tweet ID and capped at the requested count. `evidence` preserves each action, exact page records, cursor, additions, failures and CLI latency. `modelCalls`, `attempt` (CLI calls), `usage`, `resultCount`, and `latencyMs` provide telemetry. A `complete` verdict means the selected CLI source supplied the requested number of valid distinct records; it is not an independent verification of X's content or ranking.

## Execution policy

The read-only allowlist is following, For You, user tweets, search, and mentions. `bird-adapter.ts` uses the fixed `/opt/homebrew/bin/bird` executable with `Bun.spawn(argv)` and no shell. Positional arguments follow `--`; handles, counts, queries and cursors are validated. Search uses `--all --max-pages 1`; user tweets uses `--max-pages 1`. Read these flags against the installed version before changing adapters.

The child receives HOME, a fixed PATH, NO_COLOR, and only AUTH_TOKEN, CT0, TMPDIR when present. HOME enables Bird's existing browser-cookie/config discovery. The cwd is the home directory, avoiding repository-local `.birdrc.json5`. No Autopilot identity or model keys enter its environment or argv. Cookie values are never logged.

Decisions remain `advisoryOnly=true`, `authoritative=false`. This adapter's explicit read policy is the execution authority. It checks exact expected question IDs/types, closed-set values, finite probabilities in [0,1], complete Choice distributions summing to approximately one, selected probability ≥0.8 and confidence ≥0.75. The supported-request and optional continuation Noul must be ≥0.9. These are conservative prototype thresholds, not calibrated accuracy guarantees. Errors block; uncertainty clarifies or yields partial. No failure causes a different source or a retry.

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

The loader seeds `src/pipelines/default-definitions/bird.retrieve.v1.json` into shared definitions using its existing versioned-default behavior. Functions are registered by `birdRetrievalFunctions()` in `builtinPipelineFunctions`. Existing processes retain their loaded function registry until an operator restarts them; adding the definition alone does not update that registry. Do not restart a managed Autopilot from an agent session.

An isolated process can use the same pipeline without restarting: import the bundled JSON, `PipelineStore`, `runDeclarativePipeline`, and `builtinPipelineFunctions`; provide the normal `sessionApiContext.userSettingsStore` and `getStoredInstanceSetting` for current credential resolution, and the requesting owner. Put operational run databases/evidence only in verified ignored `tmp/docs/handoffs/`. Tests demonstrate this exact composition with fixture HTTP responses and an injected typed Bird executor.

```sh
bun test src/pipelines/bird-retrieval.test.ts
bun test src/pipelines/pipeline-loader.test.ts src/pipelines/pipeline-runner.test.ts src/pipelines/pipeline-blocks.test.ts src/pipelines/functions.test.ts
bun run typecheck
```

The successful fixture input `Get 2 following tweets` produces `verdict=complete`, `resultCount=2`, `modelCalls=1`, `attempt=1` and two unchanged fixture records. `Get the last 20 tweets` produces `needs_clarification` and zero CLI calls. Tests also cover cursor continuation, source/argument locking, no progress, invalid decisions, credential isolation, injection, authentication/rate failures, byte limits and subprocess termination.

The reusable design follows TypeSafe's [function calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling): closed-set Choice answers choose operations/candidates while code owns free-form values and execution. See [Choice](https://docs.typesafe.ai/primitives/choice) and [Noul](https://docs.typesafe.ai/primitives/noul) for probability semantics.

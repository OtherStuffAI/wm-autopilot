# Runner-derived viewer fixtures

These snapshots are exported by actual isolated runner regression tests. Agent
adapters, provider fetches, graph functions and Bird retrieval/delivery are mocked;
execution, retries, loops, hierarchy, snapshots, DTOs and evidence are real.
They contain synthetic data only. IDs/timestamps change during regeneration.

```sh
PIPELINE_VIEWER_FIXTURE_DIR=docs/fixtures/pipeline-viewer/runtime \
  bun test ./src/pipelines/pipeline-runner.test.ts \
  ./src/pipelines/pipeline-viewer-runtime.test.ts ./src/pipelines/bird-chat.test.ts
```

To check each generated snapshot through the actual Flight Deck parser, also set
`PIPELINE_VIEWER_PARSER` to the absolute path of that checkout's
`src/pipeline-viewer-contract.js`. Normal repository tests do not require a
sibling checkout. Tests assert runtime logical keys match definition nodes,
matching evidence run/step identity and independent positive retry ordinals.
The optional Flight Deck check also projects every recorded execution and asserts
that it remains visible, including legacy nodes without captured expansion.

Coverage includes classifier and agent retries, winning output attribution,
loop repetition, error resume, orphaned agent relaunch, parallel items, explicit
nested agent IDs, native blocks, immutable changed block expansion, and Bird v2
wrapper/child complete, partial, clarification, blocked and no-results outcomes.

Bird fixtures also assert every declared port of each non-skipped execution
against its exact archive and bounded field preview. Complete retrieval runs
35 synthetic records; partial runs one; clarification, blocked and no-results
run zero. No-results retains the native partial verdict. Companion
`evidence/bird-*.json` files contain `{runId, values: {evidenceId: fullValue}}`
for every retained captured kind's lazy browser responses, captured by the real runner. They are
synthetic reusable test data, not API illustration rows or real user evidence.
Regenerate snapshots and companion bodies together using the command above;
UUIDs must agree. Declared previews remain at most 2048 UTF-8 bytes per evidence
reference, and full values are only read by explicit inspection/test requests.

Current complete Bird fixture: wrapper 22 captured references / 12,124 preview
JSON bytes / 983-byte largest preview; child 35 / 17,423 / 970. These include
existing generic previews and legacy inline archival of skipped rows; skipped
rows remain hidden as data operations. Selected field maps add no full-body
copies or schema columns. Capture performs one metadata-only step query for
resolved input or returned output; reference lists still read only the bounded
preview column. Worst-case persisted/read preview storage remains 2 KiB per
reference. Counts/bytes describe this synthetic fixture, not production latency
or a migration/backfill measurement.

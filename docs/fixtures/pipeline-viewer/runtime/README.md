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
wrapper/child complete, partial, clarification and blocked outcomes.

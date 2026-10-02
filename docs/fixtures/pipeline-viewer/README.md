# Pipeline viewer synthetic fixtures

Generate with `bun scripts/pipeline-viewer-fixtures.ts`. Every identity, record,
request and tweet is synthetic; no runtime database is read. The generated
completed and child snapshots follow the exported backend DTOs. Input/output
ports are labels and paths; full values are lazy evidence responses.

- `definitions.json`: real Bird v2 definition shapes and configured wiring.
- `completed-run.json`, `child-run.json`: parent navigation, actual child/loop
  nodes, native statuses, evidence references and explicit terminal reasons.
- `runs.json`, `unchanged-updates.json`: list and polling envelopes.
- `resolved_input.json`: exact long text inside a retained object.
- `tweets-page-1.json`, `tweets-page-2.json`: all 35 synthetic records, including
  the collection after its first 20 entries.
- `side_effect_confirmation.json`: delivery confirmation separate from text.
- `measurements.json`: local fixture generation/capture and read timings plus
  total SQLite allocation after WAL checkpoint. Allocation includes run/step
  state, snapshots and indexes; it is not just evidence payload bytes.

IDs are freshly generated synthetic UUIDs, linked consistently within a fixture
set. The measured 28 retained records include 322,601 bytes of redacted JSON.
The generator also measures all lazy evidence reads separately. Timings and
SQLite allocation are machine-specific, not a production performance claim.

Regression suites cover clarification, empty/partial results, tool failure,
retries, cancellation, missing historical evidence, authorization denial,
redaction, oversized values and archive fault injection.

The `runtime/` folder contains snapshots exported by actual isolated runner tests,
including retries, repetition, resume, parallel items, nested agents and native
blocks. See [runtime/README.md](runtime/README.md) for generation and validation
through Flight Deck's actual parser; these establish execution semantics beyond
this display fixture generator's manually created records.

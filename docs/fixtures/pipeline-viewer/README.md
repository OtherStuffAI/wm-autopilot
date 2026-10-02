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
- `measurements.json`: local fixture generation/capture and read timings,
  physical archive payload bytes/bodies and SQLite allocation after WAL
  checkpoint. Allocation includes run/step state, snapshots and indexes.

IDs are freshly generated synthetic UUIDs, linked consistently within a fixture
set. The measured 28 retained records include 322,601 bytes of redacted JSON.
The generator also measures all lazy evidence reads separately. `redactedJsonBytes`
is the logical sum across references; `archivePayloadBytes` measures physically
stored UTF-8 bodies across legacy inline rows plus shared payloads. Previews are
counted separately and remain per reference. Timings and SQLite allocation are
machine-specific, not a production performance claim.

The retained before/after comparison uses five isolated generations per mode,
with median timings. The baseline uses the accepted `a5297d3` evidence/store
modules and the same synthetic generator with measurement-only additions;
other dependencies are identical to the current checkout. Transient comparison
modules and generated files belong in ignored handoffs. No live database or
private records were measured. The body counts/bytes are deterministic; timings
and total SQLite allocation vary with host activity and generated UUIDs.

| Measurement | Inline baseline | Root-scoped sharing |
| --- | ---: | ---: |
| Evidence references | 28 | 28 |
| Archived bodies | 28 | 11 |
| Physical archive payload bytes | 322,601 | 119,588 |
| Capture / fixture construction median | 11.50 ms | 14.77 ms |
| All lazy value reads median | 0.62 ms | 1.43 ms |
| Snapshot read / fixture write median | 2.73 ms | 2.95 ms |
| Total SQLite allocation, sampled | 1,126,400 bytes | 933,888 bytes |

This fixture saves 203,013 physical archive bytes (62.9%) while preserving all
reference IDs and exact values. Integrity/scope verification adds read work.
The archive changes neither inline engine state nor definition snapshots.
Regenerate a fresh single sample with
`bun scripts/pipeline-viewer-fixtures.ts --output <directory>`; compare physical
body bytes rather than summing the logical `EvidenceReference.bytes` fields.
The generator emits a single measurement; the checked-in `comparison` records
the separate five-run baseline sampling, not a promised timing threshold.

Regression suites cover clarification, empty/partial results, tool failure,
retries, cancellation, missing historical evidence, authorization denial,
redaction, oversized values and archive fault injection.

The `runtime/` folder contains snapshots exported by actual isolated runner tests,
including retries, repetition, resume, parallel items, nested agents and native
blocks. See [runtime/README.md](runtime/README.md) for generation and validation
through Flight Deck's actual parser; these establish execution semantics beyond
this display fixture generator's manually created records.

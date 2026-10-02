# Bird viewer integration acceptance

This matrix is for the additive pipeline viewer read contract. Source tests and
fixtures establish behavior before runtime activation. They do not establish
that an already-running Autopilot process serves new routes.

| Scenario | Execution/API evidence | Browser evidence |
| --- | --- | --- |
| Following success | Exact records/links; pinned definition; confirmed delivery | Actual nodes, tweet count, exact response and separate delivery confirmation |
| Ambiguous feed | Following versus For You clarification; no implicit source | Clarification and available output visible |
| No results | Empty collection and terminal reason | Empty state distinct from missing evidence |
| Tool/model failure | Failed invocation, partial output and retry identity | Failed step, usable retained output, delivery distinguished |
| Retry | Same-source retrieval; bounded attempts; idempotent posting | Attempt history without duplicate execution nodes |
| Cancellation | Parent/child terminal state; no later side effects | Cancelled status and available evidence retained |
| Child and loop | Actual hierarchy, executed attempts and exit reason | Child opens with parent context; unused iterations subordinate |
| Long prompt | Exact redacted invocation content retained through compaction | Full readable/copyable content; preview explicitly labelled |
| Large collection | More than 20 records retained; every page accessible | Every record reachable without a first-N ceiling |
| Legacy run | Full retained inline lazily complete/redacted; missing request not_captured; missing expansion unavailable; old previews preview_only | No current-definition reconstruction or invented full values |
| Authorization | Owner/delegate positive; foreign owner/workspace/Tower/app/agent negative | No previous-context values after switching or denial |
| Redaction/limits | Credentials removed; redactions/oversized/expiry explicit | Availability and scope shown; no false complete claim |
| Recovery | Stable authoritative revision and snapshot | Reconnect/out-of-order response cannot duplicate or replace newer attempts |
| Selected FIPS | Verified peer handle, exact NIP-98 URL, no public fallback | Connection failure visible without transport substitution |
| Selected HTTPS | Explicit supported HTTPS connection, exact signed URL | Same contract and no redirects or implicit FIPS fallback |

## Review procedure

Review commits and changed modules independently of worker handoff claims. Run
focused pipeline loader/runner/block/function/Bird/store/API tests, then the
Autopilot repository validation requirements. In Flight Deck run focused tests,
`bun run validate`, release-note checks and `bun run unused:report` for new
module seams. Record Playwright desktop/mobile/keyboard/inspector results and
performance baseline numbers; use local Tower by default according to config.

Use synthetic/redacted isolated execution and delivery fixtures before any live
Bird side effect. A real authorized run must use an explicitly isolated thread;
never post into unrelated conversations for validation. Full private payloads
and operational screenshots/logs belong in ignored handoffs or authorized task
records, not reusable committed documentation.

## Activation and rollback

The new read API is additive; old management endpoints and Bird definition
versions remain available. Evidence tables must be additive. Rollback to a
previous binary must not delete newly retained evidence. Preserve the database
before operator activation and document any migration prerequisites from the
actual implementation.

Evidence payload sharing adds `pipeline_evidence_payloads` (root/content unique
key, immutable update/delete triggers), nullable `pipeline_evidence.payload_id`,
and source/content lookup indexes. Initialization leaves old inline rows intact;
no destructive backfill or live DB migration is part of source validation.
Preserve the table and nullable links on rollback. A pre-sharing binary cannot
resolve new shared-body references; retain a compatible evidence reader and do
not treat an old binary returning null as successful evidence recovery.

Run `pipeline-evidence-sharing.test.ts` with the existing evidence/store and
runner/API/Bird/public-call tests. It checks native/block/parent-child aliases,
long prompts and 37 records, exact reopen/compaction, old inline schemas, nested
rollback, per-run unique budgets, unrelated-root/owner isolation, retired source
provenance, body corruption, immutable triggers and winning executor attempts.
See [synthetic measurements](fixtures/pipeline-viewer/README.md) for physical
archive payload bytes and capture/read overhead. The public evidence contract,
paging and DTO shapes remain unchanged; full-inline engine state is retained.

Activate compatible backend first, verify capability/routes/auth/health, then
activate the dependent Flight Deck build. An Autopilot process restart requires
explicit operator approval in the same conversation and must be performed from
outside its managed agent session. While this approval is absent, source
completion is reported separately from pending restart and live smoke tests.

For each handoff record exact commits, test counts/results, build identity,
served versus source state, independent-review findings, migrations, rollback
limits and remaining live checks. Keep delivery and package tasks aligned with
that evidence; a working mock or successful build alone is not live acceptance.

## Runtime contract regression checks

Use real runner fixtures for agent/classifier retries, loop repetition, resume,
parallel items and native block descendants. Set `PIPELINE_VIEWER_PARSER` to a
Flight Deck checkout's `src/pipeline-viewer-contract.js` while running
`pipeline-runner.test.ts`, `pipeline-viewer-runtime.test.ts` and
`bird-chat.test.ts`; this validates snapshots through the actual frontend parser.
Use `PIPELINE_VIEWER_FIXTURE_DIR=docs/fixtures/pipeline-viewer/runtime` to export
reusable synthetic snapshots. The normal backend suite needs no sibling checkout.

Bird runner checks trace every declared port on non-skipped root/child
executions against the exact archive and its field preview. Complete retrieval
uses 35 actual fixture tweets (two preview samples, count 35); partial,
clarification, blocked and no-results exercise one/zero records with native
verdicts. No-results is `partial` with zero tweets, not a new runtime status.
Root and child delivery paths are checked independently, as are selected
classifier inputs versus prepared executor requests. Skipped steps remain
control-flow explanation, not asserted successful input/output operations.
Companion synthetic full values under `runtime/evidence/` let browser tests
fulfil lazy reads with the actual captured shapes instead of manually creating
step records. Run `pipeline-declared-previews.test.ts` and the evidence/store
tests for bounded hostile path/text overhead, null/missing/prototype semantics,
capture redaction, retired credential reopen/compaction, immutable per-boundary
maps and shared bodies. No new schema column, backfill, deletion or expiry is
required for the additive field map inside existing `preview_json`.

`pipeline-preview-metadata.test.ts` and actual authorized route regressions
cover selector/object-key credentials learned from callbacks, inputs, providers,
credential-shaped strings and real runner output. Check full snapshot/catalogue,
run list/update, lazy reads, compaction/reopen and key retirement; the entire
outward payload must be safe, not just its preview. Pinning before step creation
and child-discovered credentials must preserve execution spec/hash/expansions
while refining durable viewer copies. Retired new aliases and modified/unproven
display provenance refuse capture atomically, rather than retaining raw selectors
or creating a successful empty fallback. Existing immutable references are not
backfilled or rewritten. No live DB validation or private key material is needed.

Exercise workspaceIds, scopeIds and agentIds independently and jointly across
root, child, evidence, update, list and catalogue reads. Scope restrictions deny
missing trusted Tower channel scope. Test credential echoes in successful input,
request, context/output, state and every outward string, including skip reasons;
ordinary prose must remain exact. Historical expansion changes must leave the
old hash, structure and executed functions stable. Full legacy inline content
must remain lazily readable before and after compaction; previews never become
complete executor requests.

Run repository validation as configured. If discovery includes nested ignored
checkouts, preserve them and distinguish their results from current-source
checks. Record compiler, lint, dependency-audit and runtime test failures
separately; do not claim full validation passed merely because focused tests did.

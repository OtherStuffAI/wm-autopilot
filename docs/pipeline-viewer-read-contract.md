# Pipeline viewer read contract (WP0)

## Decision

Autopilot owns execution and evidence. Flight Deck reads its selected Autopilot
connection directly, using the existing signed owner control-plane transport.
Tower continues to own workspace coordination; no execution-history projection
or second Tower sync mechanism is needed. Architecture board v7 is the latest
locally available board inspected on 2026-10-02.

The existing `/api/pipelines` management API remains compatible. Its shared-run
access and `SessionsManage` requirement are unsuitable for this viewer. Add an
owner-scoped, read-only control-plane surface instead:

`/api/owners/:owner/control-plane/v1/pipeline-viewer`

Every read requires NIP-98 owner authority or an active `control-plane:read`
delegation, plus explicit `workspace_id`, `tower_service_npub`, and `app_npub`.
Run reads resolve the root run's durable `flightdeck_invocation_context` and
match that context, root owner, and delegated agent, workspace and scope filters.
Restricted scope reads require a scopeId from the resolved Tower channel; missing
scope denies access. Scope-restricted catalogue reads additionally require an
authorized durable invocation in that workspace/Tower/app context, with no scan
ceiling; catalogue bindings remain independent of run access. Missing trusted
workspace context is unavailable, never inferred from arbitrary run input.
Denied/foreign records return 404; absent authority returns 403. Evidence and
child reads use the same root authorization. Shared-instance access does not
grant viewer access. Catalogue definition reads are shared/owner-visible
definitions; restricted delegates additionally require an allowed agent binding.
They do not grant access to associated runs. Historical snapshots are returned
only through an authorized run read, never through a catalogue ID lookup.
Subscription resolution must require an exact requested-owner match; a missing
subscription cannot fall back to another owner's active subscription.

Flight Deck's Autopilot connection client owns signed requests. A dedicated
pipeline service owns cancellation, refresh/recovery, and Dexie transactions;
Alpine consumes liveQuery projections. TowerSyncService stays unchanged.
Service identity is the verified installation ID and signer, never its URL.
Selected FIPS uses the existing immutable peer-pinned handle, with no public
fallback. The current Connect client implements FIPS only. HTTPS in package
metadata is not an implemented viewer transport; no parallel HTTPS client is
required for this milestone. If a supported explicit HTTPS connection is added
later, it must sign the exact URL and reject redirects, and must not be a
recovery path for FIPS failure.

## Additive version 1 endpoints

All responses contain `version: 1`, `serviceId` and `Cache-Control: no-store`.
All paths below are relative to the owner-scoped viewer prefix and carry the
required context query above.

- `GET /definitions?cursor=&limit=50`: `{definitions, nextCursor}`.
- `GET /definitions/:id`: `{definition}`.
- `GET /runs?cursor=&limit=50&definitionId=`: `{runs, nextCursor}`.
- `GET /runs/:id`: `{run, definition, steps, children, revision}`.
- `GET /runs/:id/updates?after=`: authoritative snapshot with revision and
  `unchanged`; recovery is always a fresh run snapshot. Service-owned bounded
  polling is acceptable for v1; no polling inside diagram components.
- `GET /runs/:id/evidence/:evidenceId?offset=0&limit=100`: `{evidence, value,
  nextOffset}`. Array pages have no fixed first-N ceiling. Text/object values
  return exact retained content. IDs resolve database records, never paths.

Reject malformed limits/cursors. Use stable pagination ordering and bounded
page sizes. Definition details come from the immutable run snapshot, including
version and SHA-256 hash; legacy missing snapshots are explicitly unavailable,
never reconstructed from the latest definition.

## DTO vocabulary

`Definition`: `{id, name, title, description, version, hash, availability,
steps, wiring}`. Steps recursively reflect actual defined children/loops:
`{logicalKey, name, title, description, type, inputs, outputs, children}`.
Ports retain `{label, path, format}`. Wiring is curated selector provenance:
`{sourceStepKey, sourcePath, targetStepKey, targetPath, carriedForward}`.
It proves configured/passed fields, not all internal reads.

`RunSummary`: `{id, serviceId, definitionId, definitionVersion, definitionHash,
name, status, startedAt, completedAt, parentRunId, parentStepId}`.

`StepSummary`: `{id, logicalKey, parentStepId, itemKey, attempt, status, title,
description, kind, startedAt, completedAt, error, skipReason, continuationReason,
exitReason, childRunId, inputs, outputs, evidence}`. Stable logical keys name
definition nodes; execution IDs identify actual attempts. `attempt` is the
execution ordinal for that logical node, not an assumed loop iteration. Internal
executor retries carry their own evidence attempt/scope and are not extra
definition nodes. Do not invent UI groups. Native statuses remain documented
rather than silently coerced.

`EvidenceReference`: `{id, runId, stepId, attempt, kind, scope, contentType,
bytes, availability, redacted, capturedAt, expiresAt, preview}`. Kinds distinguish
`resolved_input`, `executor_request`, `returned_output`, `state_write`,
`side_effect_confirmation`. Availability distinguishes `complete`, `redacted`,
`preview_only`, `not_captured`, `expired`, `oversized`, and `unavailable`.
Agent requests describe the assembled invocation, not the complete later
conversation of a persistent agent session. Wrappers reference child evidence
rather than duplicating executor payloads.

## Retention and browser policy

Non-destructive default: no automatic deletion and no expiry. Retain full
redacted evidence in SQLite beside execution history, transactionally, before
compaction removes inline copies. A failed archive transaction aborts compaction.
Keep summaries small and payloads lazy. Default per-value capture ceiling is
16 MiB and aggregate per-run budget is 128 MiB; configurable limits must mark
oversized/unavailable evidence explicitly, never call a preview complete.
Record measured fixture storage/read cost before acceptance. A future explicit
retention policy may expire evidence, with truthful availability metadata; this
milestone does not enable pruning silently.

Redact credential-bearing keys and authorization/cookie headers at capture
boundaries. Preserve user text exactly unless it actually matches a configured
secret/redaction rule. Never archive callback tokens, private keys, API keys,
or credentials. Record redaction scope; sanitize errors and definition views.

Persist summaries/selection/loading status in Dexie with keys including backend,
workspace, actor, service, run and attempt. Full private evidence uses an
explicit session-only cache: do not persist it by default. This is a deliberate
privacy exception for lazy inspection values; persisted UI state remains Dexie
owned. On service/run/
workspace/actor changes abort requests and clear private values before render.
Show loading, empty, denied, disconnected, stale and availability independently.

## Implementation seams and acceptance

Backend: composition snapshots already pin definitions; runner/store capture
and compaction need durable evidence. Reuse `resolveOwnerAccess`, trusted
invocation events and child root resolution. Put new routes/DTO/evidence helpers
in separate modules, with a small API router integration.

Frontend: extend `autopilot-connect-client.js`; add pipeline service, Dexie
storage and viewer modules. Existing concurrent shell/context-tree edits must
be preserved and coordinated before shell integration.

Verify owner/delegate success and wrong owner/workspace/app/Tower/agent denial;
long text and >20 records after compaction; definition changes; archive failure;
exact executor capture and redaction; disconnected/recovered snapshots; safe
rendering and exact copy; child/attempt navigation. Bird formatting is
deterministic, and delivery confirmation remains separate from response text.

## Backend v1 implementation detail (WP2–WP4)

DTO types are exported from `src/pipelines/pipeline-viewer-dto.ts` and
`pipeline-evidence-store.ts`. JSON response fixtures are under
`docs/fixtures/pipeline-viewer`; regenerate with
`bun scripts/pipeline-viewer-fixtures.ts`. They contain synthetic context only.
The additive Connect capability is `pipelines.viewer.read.v1`, with
`api.pipeline_viewer_path` containing the owner-scoped prefix. Service IDs use
`installationIdForIdentity` from the actual installation signer.

Lists use opaque base64url collection-bound cursors; definitions sort by ID,
runs by descending `(startedAt, id)`. Limits: definitions/runs 1–100 (default
50), evidence arrays 1–500 (default 100). Empty initial cursors are accepted;
malformed cursors and duplicate required context/limit fields are rejected.
Updates return the full authoritative snapshot and `unchanged`, with a SHA-256
revision over the sanitized summary snapshot. No archive filenames are exposed.
A successful detail response carries `run`, `definition`, `steps`, `children`
and `revision`; `children` contains direct child RunSummary entries.

Ports in both modes contain labels, paths and formats, not inline private
values. Resolve values through each step's evidence references. Object evidence
returns the exact full redacted object (including every nested record); top-level
array evidence supports offset pages. Uncaptured references have `capturedAt: null` and use
`not-captured:<step-id>:<kind>` IDs and have no value endpoint. Full retained
legacy inline input/output/state is lazily archived as `complete` or `redacted`
with `retained_legacy_inline` scope (or `legacy_inline_archive` during compaction).
This asserts completeness of the retained inline value, never reconstruction of
an executor request. Existing compacted display previews remain `preview_only`
with `legacy_compacted_display_preview` scope. Missing trusted identity
or historical snapshot is never reconstructed from run input/latest definitions.
Native statuses: queued, running, ok, needs_input, error, skipped, cancelled.

Evidence request attempts identify actual model/agent transport attempts;
StepSummary attempts identify executions of a logical node (including loop
iterations). Missing evidence kinds remain explicit `not_captured` references;
these have no value endpoint, even when other kinds were captured. Agent request scope explicitly covers the assembled invocation
prompt, not later conversation. Wrapper outputs/state writes are distinct from
child executor evidence. Evidence is append-only and never automatically pruned.
Limits are configurable via `WINGMEN_PIPELINE_EVIDENCE_VALUE_BYTES` and
`WINGMEN_PIPELINE_EVIDENCE_RUN_BYTES` (positive integer bytes).

### Bird v2 boundaries

New `bird.timeline.chat.v2` and `bird.retrieve.v2` definitions preserve v1.
The wrapper retains validate invocation → retrieve child → deterministic format
→ deliver: authentication, child inspection/time budget, exact format inspection,
and side-effect/retry boundaries justify all four actions. Thread block expansion
remains visible as its real native child; it is not a presentation-only group.

The child retains request validation and bounded retrieval attempts. `choose`
and `judge-evidence` remain explicit advisory classifiers. Their supporting
`bird.modelState.v1` operation is configured as `inputFunction`, so projection
and remaining-time calculation are inside each classifier operation, with its
function hash pinned for historical resume. `execute` and `check` keep actual
read-only execution and deterministic continuation policy explicit. The three
iteration limit and source lock are unchanged. Delivery uses a stable run + delivery-step
thread-reply idempotency key; a failed acknowledgement retry cannot create a new
post identity. No model drafts the final tweet response.

Compaction verifies a SHA-256 match for each exact redacted inline value/version,
not merely the existence of a same-kind reference. Over-budget values are
explicitly `oversized`; compaction retains their inline step payloads. Caller
availability labels cannot bypass byte budgets. Successful executor returns and
state writes carry the most recent actual executor request attempt; resolved
input remains the original selection. Evidence order is durable insertion order,
including multiple captures within the same millisecond.

### Review correction: runtime structure and identity

Block expansions (paths and recursively expanded steps) are captured immutably
in the run snapshot context at creation and used by the runner and historical
DTO. New snapshot hashes cover the raw spec and expanded structure. Existing
snapshots keep their hashes; historical blocks lacking expansion are marked
unavailable and cannot be resumed by re-expanding current code. Catalogue reads
may expand current definitions; historical reads never do.

Parallel child executions share their definition logicalKey; itemKey and actual
execution id distinguish items. Explicit agent IDs and all nested parents use
the same key rules as definition nodes. Evidence attempt is the executor request
ordinal within that execution id; it is independent of the StepSummary logical
execution ordinal. Agent relaunch after an orphaned session appends retry identity
past retained requests. All requests survive, and successful output/state belongs
to the winning request. Frontend validators must match runId and stepId, without
requiring the two different ordinals to be equal.

Runtime-derived regression fixtures are under `docs/fixtures/pipeline-viewer/runtime`.
See their README for regeneration and optional validation through Flight Deck's
actual parser. The original Bird display fixtures remain synthetic illustrations.

Evidence previews are optional `{value, truncated, count, counts}` summaries,
captured after redaction and bounded to 2 KiB of UTF-8 JSON. Text excerpts are
at most 256 characters, array samples at most two records; `counts` maps nested
JSON paths to actual collection counts. Nullable `preview_json` is added to the
evidence table without backfilling older rows. Lists read this small column,
never full `value_json`. A preview cannot assert full evidence availability.
Full private evidence remains session-only in the browser; frontend consumers
must apply the same privacy policy to content previews.

Before activation, run the read-only inventory:
`bun scripts/pipeline-block-resume-audit.ts <pipeline-database>`.
Pending legacy runs without snapshots cannot replay current definitions. They
surface `historical_resume_blocked` and native error when resume is attempted;
records and prior evidence remain retained. In a pinned legacy run a completed
block may reuse its retained recorded state, but an incomplete block without a
captured expansion fails explicitly. An operator must review prior side effects
and decide new runs or recovery using provable historical structure; do not
silently backfill expansions from current code. Rollback retains the nullable
column and newly captured snapshots/evidence.

New pins retain a sanitized viewer definition and block expansion alongside the immutable execution pin. Capture-time provider context redacts these durable viewer copies and step metadata; removing or rotating a credential does not restore it in historical DTOs. Authorized reads resolve current owner/instance provider settings before lazy archival and outward serialization. Catalogue definitions with an identical retained execution spec reuse its sanitized viewer copy; changed definitions use current credential context. No retired secret list or identity keys are persisted.

Evidence also stores an internal, non-exposed source-value SHA-256 digest beside the sanitized content hash. Compaction recognizes the exact captured raw version after credentials are retired without persisting a secret list or creating an unredacted duplicate. The nullable additive source_hash column preserves existing evidence immutability; no backfill changes evidence rows.

Full sanitized archive bodies now live in immutable `pipeline_evidence_payloads`.
Each boundary still has its own immutable evidence reference, kind, scope,
attempt, source/content digests, availability and bounded preview. A nullable
internal `payload_id` links new retained references to one exact UTF-8 JSON body
per durable composition root and content digest. Old inline `value_json` rows
remain readable; no rows are rewritten or backfilled. Root scope follows actual
`pipeline_child_runs` links, verifies matching owner/alias and parent step/run,
and rejects missing authority or cycles. Run input/workspace labels never choose
storage scope. Unrelated roots, including the same owner's other runs, have
separate bodies and source-provenance decisions. No payload ID/hash/path endpoint
or DTO field is added; evidence reads still require an authorized run + reference.

The 16 MiB value and 128 MiB run defaults remain. Run budget counts each distinct
retained content once within that run, including legacy inline bodies. A child
or sibling's first reference charges its own budget even when the body already
exists in the root archive. Oversized references have no stored body and retain
inline execution values through compaction. Payload/reference insertion uses a
single transaction, nesting inside existing completion/compaction transactions.
Reads and compaction verify body bytes/digests and scope; missing/corrupt bodies
raise explicit errors instead of returning a successful null value. Payload
update/delete triggers enforce immutability; there is no expiry/deletion job.

An exact retained source digest can reuse prior sanitized evidence across native,
wrapper and child aliases after credentials retire. No secret list is persisted.
Conflicting retained source/content records refuse capture. A root containing
old redacted evidence without exact source provenance refuses new capture rather
than guessing whether a new alias contains a retired credential; matched existing
archives remain readable. The existing compaction refusal for an unmatched
redacted step/kind remains explicit.

Wiring retains configured `sourcePath` and exposes additive `sourceValuePath`, relative to the known writer's assigned captured output. `sourcePortPaths` and `targetPortPaths` list declared ports related to the selector by exact or ancestor/descendant paths; they do not invent fields or structural nodes. For `$.bird.retrieval` written under `$.bird`, the captured value path is `$.retrieval`, related to output `$.retrieval.tweets`; target selector `$.state` relates to declared input `$.state.tweets`.

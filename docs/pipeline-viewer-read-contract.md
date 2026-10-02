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
match that context, root owner, and delegated agent filters. Missing trusted
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

`StepSummary`: `{id, logicalKey, parentStepId, attempt, status, title,
description, kind, startedAt, completedAt, error, skipReason, continuationReason,
exitReason, childRunId, inputs, outputs, evidence}`. Stable logical keys name
definition nodes; execution IDs identify actual attempts. `attempt` is the
execution ordinal for that logical node, not an assumed loop iteration. Internal
executor retries carry their own evidence attempt/scope and are not extra
definition nodes. Do not invent UI groups. Native statuses remain documented
rather than silently coerced.

`EvidenceReference`: `{id, runId, stepId, attempt, kind, scope, contentType,
bytes, availability, redacted, capturedAt, expiresAt}`. Kinds distinguish
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

# Bird pipeline viewer release gates

The pipeline viewer is a read-only Flight Deck consumer of Autopilot execution
data. Use the [read contract](pipeline-viewer-read-contract.md) and
[validation guide](pipeline-viewer-validation.md) with this release sequence.
Source approval and an isolated browser build establish source readiness;
served assets, signed capabilities and actual runtime reads establish activation.

## Backend preflight

1. Select the actual Autopilot installation, owner, workspace, Tower, app and
   assigned agent. Keep the existing pinned FIPS connection and broker signing.
   Flight Deck currently has no implemented HTTPS Autopilot connection fallback.
2. Take a consistent backup of the selected runtime SQLite database and its
   journal state using an operator-approved SQLite backup procedure. Record an
   integrity check and the restoration procedure before opening the database
   with the new store.
3. Run `bun scripts/pipeline-block-resume-audit.ts "$PIPELINE_DB"` against that
   database. Review each affected unfinished historical run and its prior side
   effects. Older runs without their required definition/block snapshots cannot
   safely resume from current code. The audit is read-only; it does not recreate
   snapshots, retry delivery or dispose of runs.
4. Review additive evidence storage: nullable reference columns, immutable
   root-scoped shared payloads and retained legacy inline rows. Defaults retain
   evidence without automatic deletion or expiry, with a 16 MiB value limit and
   128 MiB unique-content budget per run. Over-limit captures retain their inline
   execution values and report availability explicitly.
5. Obtain explicit approval in the current conversation for an outside operator
   to restart Autopilot, acknowledging interruption of active sessions. Delivery
   sessions do not restart their host. Activate the compatible backend first.

Raw execution definitions, hashes and function/block pins remain exact. Captured
viewer copies can receive further redaction when a boundary discovers a
credential. This refinement must preserve raw pins and roll back with a failed
capture; it does not reconstruct a historical definition from current files.
Selectors, previews and full values use the same available credential context.

A credential discovered later can invalidate an earlier immutable value. The
viewer then refuses the composition with HTTP 409 and
`pipeline-viewer-evidence-redaction-review-required`; raw archives and pins remain
retained. Treat this as unavailable pending review, not a transient connection
failure. Do not clear durable refusal flags or rewrite archives during activation.

## Backend acceptance after activation

Verify that the signed Connect package advertises
`pipelines.viewer.read.v1` and `api.pipeline_viewer_path`. Check installation and
owner identity, runtime health and existing API compatibility through the
selected connection before enabling Flight Deck's viewer.

Exercise owner and active read-delegate access, another workspace/agent denial,
delegation revocation, exact signed paths and a revoked/disconnected FIPS handle.
Summaries, child runs and lazy evidence must enforce the same durable root
authority. Verify that retained values survive compaction/reopen, redactions
remain effective after credential retirement and unavailable legacy evidence
has an explicit state.

Verify late-discovery refusal with a credential beyond a preview's text or record
limit. Also verify that harmless evidence captured with an already-known
credential context remains readable within the configured storage limits.

Use an authorized isolated destination for Bird v2. Verify the definition binding
on the assigned agent as well as definition availability. Cover complete,
partial, clarification, no results, failure, cancellation and retry outcomes;
inspect child attempts and actual exit reasons. Confirm delivery exactly once
and distinguish the deterministic formatted response from confirmed delivery.
Include a long prompt and more than 20 exact records. Synthetic fixtures provide
repeatable source evidence; they do not establish live signing or runtime health.

## Flight Deck activation

Ordinary builds keep the viewer OFF. Only the exact build setting
`FLIGHTDECK_PIPELINE_VIEWER_ENABLED=1` enables it. A disabled build rejects viewer
navigation and deep links before constructing its client/store or issuing
health/evidence requests, and reports pending activation.

Builds publish `dist` immediately in the local managed app: its server reads
assets from disk on each request. Run acceptance builds in an explicit isolated
directory. Publish an enabled build only after the backend checks above succeed,
using the configured managed-app lifecycle and repository branch conventions.
Keep the build number newer than the currently served build and record the exact
build ID, activation flag, index/assets hashes and MIME checks. Preserve compatible
concurrent work; remote Git publication remains an operator action.

After publication, verify the actual served build in a browser. Check service/run
deep links, child/parent navigation, named connections, full-value copy and every
retained collection page. Recover from interrupted and out-of-order updates;
service/workspace/run changes and access loss must clear prior private values.
The exact redaction-review refusal must clear persisted summaries, private values
and pending reads. Release an earlier delayed success after refusal and verify
that it cannot restore values or selection. A healthy connection or remount must
preserve the reason; recovery requires a fresh authorized authoritative snapshot.
Previews and complete evidence remain session-only, while summary projections
use Dexie. Check keyboard, touch, inspector focus/Escape and bounded rendering
with thousands of records. Already-open pages may retain an earlier asset set
until reload; build verification must identify the active bytes.

## Rollback and handoff

Disable the viewer build flag if compatible runtime reads cannot be established.
Preserve additive tables, nullable links, raw pins and legacy rows. A pre-sharing
reader cannot resolve new shared payload references; keep a compatible evidence
reader for those records. Review unfinished runs and delivery state before any
engine rollback or resume. This release performs no destructive backfill,
evidence cleanup or automatic replay.

Record source commits, independent review, required checks and their unresolved
limits separately from live smoke evidence. Package tasks become review-ready
when their source evidence is complete; integrated acceptance stays pending
until the selected runtime and served viewer pass. A blocked design-artifact
publication also remains explicit. Expansion beyond Bird is follow-up scope.

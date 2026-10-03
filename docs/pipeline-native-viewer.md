# Native Autopilot pipeline viewer

The viewer is integrated into `/pipelines/definitions/:id` and
`/pipelines/runs/:id`. Existing definition editing, launch, analysis, stop and
resume controls remain available. Definition and execution modes share the
reviewed port projection, measured arrows and inspector layout. Dashed arrows
identify carried metadata; they do not imply an intervening transformation.

## Native authority and read contract

`GET /api/pipelines/viewer/definitions/:id`, `runs/:id`,
`runs/:id/updates`, and `runs/:id/evidence/:evidenceId` require a verified native
owner session plus the existing SessionsManage access policy. NIP-98, delegated
owner contexts, shared-instance visibility and supplied owner/workspace values
do not grant native viewer authority. Delegates continue to use the unchanged
signed owner control-plane viewer with trusted workspace, Tower, app, scope and
agent checks. This is a native owner adapter, not an alternate delegation path.

Every run ancestor must belong to the session owner, with consistent owner alias
and parent-step linkage. Every emitted child link must match its actual parent
run and step in both directions. Foreign or inconsistent child links refuse the
whole parent projection.
Evidence IDs resolve only within the authorized run. Responses are version 1,
service `native`, `Cache-Control: no-store`; integer array page sizes are 1–500.
Strings and objects remain exact retained values. Historical runs use captured
snapshots only. Missing history is explicit; no payload reconstruction or replay
is provided. The existing retained evidence service owns sanitation, immutable
content, budget limits and durable redaction-review refusal.

## Browser ownership and privacy

A native session service owns requests, periodic authorized refresh, cancellation
and generations. Refreshes are serialized per selection, and superseded initial
reads or errors cannot overwrite newer snapshots. The copied renderer contains no Flight Deck signing, transport,
workspace store or navigation layer. Native responses pass the reviewed DTO parser and remain in a private session
projection. Only status and a notification revision enter a distinct Dexie
partition; liveQuery supplies the ephemeral projection to Alpine. No definition
literal, description, error, snapshot, preview or full evidence persists.
Each mount starts with a fresh response and deletes its partition on route
disposal. Hard document unload can interrupt IndexedDB cleanup, leaving only
status/revision notification rows; those rows never recover server data or
private projections.
Old partitions are never used as offline authority.

Bounded previews and exact lazy values remain in session memory only. They never
enter Dexie, localStorage or a service worker. Selection changes, closed
inspectors, owner changes, disposal and access/refusal responses abort and clear
values; generation checks reject delayed responses even if cancellation fails.
The old native run-detail database upgrades to summary-only records, clearing
its previous payload cache. Existing management command responses are not
persisted as private values. Inspectors page 50 loaded records, preserve original
indices, search loaded pages and gate whole-value copy on complete retained data.
Missing fields and explicit null remain distinct. All value rendering uses text;
links require HTTP(S) and positive adapter delivery confirmation.

Formatting is distinct from delivery. `returned_output` identifies deterministic
formatted text; `side_effect_confirmation` identifies the delivery adapter's
recorded result. A formatted reply alone never establishes delivery.

## Validation and activation

Focused validation:

```sh
bun test ./src/pipelines/pipeline-native-viewer-routes.test.ts \
  ./src/pipelines/pipeline-viewer-routes.test.ts ./src/server/static-routes.test.ts \
  ./src/ui/pipelines
bun run typecheck
bun run lint:check
```

The production-shell browser regression is
`scripts/pipeline-native-viewer.browser.test.ts`. Set `PLAYWRIGHT_MODULE` to an
installed Playwright entry point and optionally `CHROMIUM_EXECUTABLE` to Chrome.
`NATIVE_VIEWER_EVIDENCE_DIR` optionally captures screenshots into a verified
ignored directory. Its loopback server serves the real index, app, static asset
service, pipeline page, native API, Dexie and Alpine. Actual synthetic runner
fixtures include a real running-to-completed execution and use a disposable SQLite database and definition root; no live API,
provider, delivery, process restart or live database operation is involved.

Architecture reference: latest local Wingman Suite saved scene v7 and
pipeline-fd/v3. Native inspection remains inside Autopilot's execution/evidence
responsibility; Flight Deck's viewer remains disabled and its transport contract
is unchanged. The repository's referenced architecture/accessibility guide paths
were absent; implementation follows the saved board and semantic HTML, named
controls, test IDs, live status and keyboard/touch requirements.

This change is source delivery only. Pete must restart Autopilot from outside a
managed agent session using the existing launch method; active sessions may be
interrupted. After restart, verify an authenticated definition, a captured run,
a child run and lazy value inspection on desktop/mobile. Verify foreign-owner
and delegated native denial, unavailable legacy history and explicit evidence
refusal. Do not backfill, replay, resume or delete history as a viewer activation
step. Flight Deck activation and pushes are separate manual decisions.

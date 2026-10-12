# Pipeline review

The native Autopilot viewer at `/pipelines/definitions/:id` and
`/pipelines/runs/:id` shows compact cards for actual defined steps. Solid arrows
show defined execution order, including the conditions gating a step. Dashed
arrows show conditional bypasses and bounded repeats. These arrows describe the
definition, not a claim that a path was executed. Run cards show the latest
recorded status and attempt count; select a step to inspect individual attempts.

Cards retain declared `display.in` and `display.out` domain labels. Routing
selectors stay in the inspector. Select a step to see configuration, inputs,
outputs, mappings, prompt and review checks. Select a domain label to trace its
producer and configured consumers and inspect retained execution values. Numbered
field overlays correspond to the inspector's mapping list. Selection fades
unrelated cards and routes without changing the execution layout.

The Code, Agent, Decision (classifier), Loop, Child pipeline, Parallel and Block
badges follow the actual step type. A code function that launches a native turn
remains a Code step. The viewer never inserts presentation-only decisions or
merges real steps. Function-source inspection shows the current library source;
historical execution configuration remains pinned to its captured definition.

Loops have bounded regions with their actual target or body and iteration limit.
Declared history collections remain visible. Body exploration retains the
containing loop and repeat bound. Child steps can open a resolved definition or,
in run review, the actual child run. A pinned child version mismatch is reported;
the viewer does not silently open a different version.

The default reading direction is left to right on desktop and top to bottom on
mobile. Fit to view scales the graph within a readability floor; large graphs
remain scrollable. The 100% control restores unscaled text. Buttons support
keyboard selection; Escape closes inspection and returns focus to the trigger.

## Read contract and activation

The sanitized viewer step DTO includes optional `review` configuration, excluding
nested bodies and display rows already represented as structured nodes/ports.
Run review uses immutable definition and block-expansion snapshots. Existing
credential redaction and owner/delegate access checks apply. No executor,
pipeline definition, persisted schema or request-authentication behavior changes.

Private definition/configuration and function-source content follow the existing
ephemeral viewer projection pattern: Dexie stores notification state and drives
Alpine updates, without persisting private definition literals or retained values.

Static modules and styles can be served immediately. A running Bun server needs
operator activation to load the additive backend projection. Until then the UI
explicitly reports unavailable control/configuration details rather than inferring
them from names, wires or a different definition. Agents must not restart the
Autopilot host to activate this change.

## Validation

Run the graph/projection tests with:

```sh
bun test src/ui/pipelines/viewer-review.test.js src/server/static-routes.test.ts
bun run typecheck
```

The isolated production-shell browser regression uses the existing native viewer
fixture and never executes a live pipeline. Set `PLAYWRIGHT_MODULE` to an installed
Playwright module and `CHROMIUM_EXECUTABLE` to the browser executable, then run
`bun test scripts/pipeline-review.browser.test.ts`. Optional
`PIPELINE_REVIEW_DEFINITION` loads an actual local definition for read-only visual
QA; `PIPELINE_REVIEW_EVIDENCE_DIR` should point to ignored operational storage.
The existing `scripts/pipeline-native-viewer.browser.test.ts` also covers retained
values, paging, child execution evidence, identity loss, refused and stale reads.

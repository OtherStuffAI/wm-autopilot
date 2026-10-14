# Declarative pipeline display data roles

Agent and `session.completedTurn` steps support optional authenticated public
activity delivery. See [Agent Step activity webhooks](agent-step-activity-webhooks.md)
for configuration, signed envelopes, receiver validation, final authority and activation.

`DisplayFieldSpec.role` is an optional, per-step presentation declaration. It does
not change selectors, executor requests, assignments, conditions, or execution.

- `"operation"` identifies information the step actually works on in `display.in`,
  or a result/decision it produces in `display.out`.
- `"carried"` identifies context preserved for downstream work, such as routing
  identifiers that this particular operation does not act on.
- An omitted role remains **unclassified**. Legacy display fields and undeclared
  selector mappings are not implicitly carried context. They remain inspectable
  through all mappings; no migration of existing definitions is required.

Roles describe the current step, not the field globally. A destination may be an
operation input at delivery and carried context during drafting. Conversation
content can be operation data independently of its thread identifier.

```json
{
  "display": {
    "in": [
      { "label": "Original request", "path": "$.workPlan.originalPrompt", "role": "operation", "format": "text" },
      { "label": "Thread", "path": "$.threadId", "role": "carried" }
    ],
    "out": [
      { "label": "Result", "path": "$.result", "role": "operation", "format": "text" }
    ]
  }
}
```

`source` is independent of role: it selects `input`, `output`, or `state` evidence.
Its existing defaults are `input` for `display.in` and `output` for `display.out`.
Paths are relative to that source. Viewer ports preserve the effective source and
its evidence kind (`resolved_input`, `returned_output`, or `state_write`) together
with the optional role. A state- or input-sourced output row must not imply that
its value was returned by the executor. Nested paths remain meaningful even when
the input selector picks their containing object.

Configured agent `prompt` is inspectable as **Instructions** in step configuration;
it is distinct from flowing original requests, requirements, and dynamically
prepared instructions. Display metadata describes flowing values and does not
replace the exact configuration inspector.

Historical run views use the pinned definition and captured display metadata,
including roles and sources. Normal privacy/redaction rules still apply. Declaring
a role does not disclose additional evidence or bypass access checks. Definition
loading rejects unsupported role values, including within loop and parallel bodies.

## Viewer defaults

The pipeline page uses the available screen width. Actual sibling steps run left
to right at 100% scale by default, with horizontal scrolling confined to the
process. Arrow keys, Home/End and First/Last navigation reach the whole sequence.
Fit to view is an explicit optional overview; 100% restores readable scale.
Selected details follow the process on desktop and mobile. Selection highlights
relevant paths without fading other cards or moving their positions. Empty data
sections are omitted; diagnostics and raw configuration use technical disclosures.

Declared operation connections appear without selecting a field. Data routes are
blue numbered bundles per configured producer/consumer pair, distinct from solid
execution arrows and skip/repeat routes. Receiving cards name the source and key
fields; numbers match the current data route/inspector list. This represents
selector provenance, not proof of successful execution or every internal read.
A carried source consumed by an operation is labelled `Context via`, not a new
result produced by the intervening operation.

Cards show the first three operation fields per direction and an explicit count
of remaining fields. Selecting the card or `+N more` opens all operation fields
in details below the process. Legacy display rows remain visible as unclassified display.
Selecting a step draws only operation bundles. `Show carried context / all
mappings` opens separate carried and unclassified sections and all configured
selectors. Clicking a particular value explicitly traces its exact mapping.
Configured Instructions and complete sanitized configuration (including display
roles) remain independently inspectable; full retained values stay on the lazy
privacy-preserving evidence paths.

Only the bundled `default-definitions/do-and-review.json` example is annotated.
The deployed/shared definition keeps its path-based identity. Existing historical
runs keep their pinned original metadata, and other definitions are not migrated.

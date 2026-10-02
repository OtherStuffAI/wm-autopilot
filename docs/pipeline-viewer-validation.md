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
| Legacy run | Missing snapshot/payload labelled unavailable or preview-only | No current-definition reconstruction or invented full values |
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

Activate compatible backend first, verify capability/routes/auth/health, then
activate the dependent Flight Deck build. An Autopilot process restart requires
explicit operator approval in the same conversation and must be performed from
outside its managed agent session. While this approval is absent, source
completion is reported separately from pending restart and live smoke tests.

For each handoff record exact commits, test counts/results, build identity,
served versus source state, independent-review findings, migrations, rollback
limits and remaining live checks. Keep delivery and package tasks aligned with
that evidence; a working mock or successful build alone is not live acceptance.

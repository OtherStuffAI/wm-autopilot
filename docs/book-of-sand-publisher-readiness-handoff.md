# Book of Sand publisher readiness repair

Pete requests review and repair of https://rick.runwingman.com/live/ba002ae1-6578-4456-893c-819552db4165. Scheduled 2026-09-05 12:15 Perth edition stopped before research because preflight required signing custody proof but GET installation omitted it. Installation and authoritative Tower grant were active/aligned, pending publisher empty; a helper incorrectly called Tower grants/me signed as Rick and received publisher_not_registered. This does not prove missing app key. Pete says this design is nonsense and asks it fixed.

Implement a non-publishing publisher readiness operation in current Autopilot, /Users/mini/code/wm/autopilot. Start from src/server/wapps-api-routes.ts publishManagedWappActivity and WappPublishingClient. Verify actual internal signing using existing protected key custody and a publisher-signed read of Tower grant; do not export keys, mint a Feed probe, rotate healthy publisher, or infer custody from a boolean alone. Return sanitized structured ready/failure evidence: installation active, no pending identity, actual signing identity matches configured publisher and grant, grant active/capability/origin/destination valid. Share the existing publishing path where appropriate, preserving auth boundaries. Route must support the SAME installation-bound scheduled execution authority and owner-delegated management as relevant existing operations, exact method/URL NIP98, no cross-installation capability escalation. Add appctl CLI support and meaningful tests for healthy read-only signing, missing custody, identity drift, pending publisher, inactive/invalid grant, and unrelated installation rejection. Do not modify Tower or Flight Deck.

Installation a45ef1fe-0cf4-4f2e-952e-778260279738; owner npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy; workspace 2e5caefd-dd65-45d2-b747-ee874e8e5fc9; origin https://mild-zen-goat.rick.runwingman.com; scope faf3be76-9aa7-426d-aa91-80a4cc785500; channel 27fc6430-7287-448b-ab92-c84ae274c9c7. Do not publish channel messages or any Feed items in this repair.

Manager handles /Users/mini/wingmen/wingman21/mycode helpers and scheduler prompt integration. Report endpoint/CLI contract early so manager can wire it. No external posts required; report only to supervisor callback. Read repository AGENTS.md and docs/architecture.md. If architecture/shared contract changes are needed, inspect latest Wingman Suite Artifact saved scene: /Users/mini/code/wingmanbefree/artifact-wapp/artifacts/Wingman_Suite/wingman-suite-arch/ (v4 currently exists; resolve latest). Keep responsibilities unchanged: Autopilot holds WApp signing custody; Tower authorizes delivery.

Default main. Preserve concurrent work; inspect full worktree and commit all nonignored tested state, including this handoff, unless unsafe. Do not push. No runtime restarts/stops/deploys are authorized. Set worker session goal metadata and nextAction reflect while working, stop at terminal handoff. Validate focused regression tests and relevant checks; report exact commands/results, commit, changed files, and pending activation/smoke test. Source-only tests do not establish live readiness.

## Implementation handoff

Implemented on `main`: `80568e6` — `Add non-publishing WApp publisher readiness checks`;
`90d876c` — `Test rejection of unavailable WApp publishing destinations`.
Autopilot retains signing custody; Tower remains delivery authority. No Tower,
Flight Deck, manager-helper, or scheduler-prompt files were changed here.
`docs/architecture.md` is absent in this checkout; reviewed existing publishing
documentation and the latest saved Wingman Suite architecture scene, v4.

Contract: `GET /api/wapps/:installationId/publisher-readiness` and
`GET /api/owners/:ownerNpub/wapps/:installationId/publisher-readiness`, with
required exact `scope_id`, `channel_id`, and `origin` query parameters. See
[wapp-flightdeck-publishing.md](wapp-flightdeck-publishing.md#read-only-publisher-readiness)
for the full response and authorization contract. HTTP 200 reports `ready`,
`code`, structured evidence, and an allowlisted public `grant` on success.
Destinations explicitly marked `available: false` are rejected. CLI JSON
preserves this response; exit 0 requires `ready: true`, otherwise exit 1.

After operator activation, the scheduled installation-bound session can smoke
test without publishing:

```bash
bun clis/appctl.ts wapp-publisher-readiness a45ef1fe-0cf4-4f2e-952e-778260279738 \
  --scope-id faf3be76-9aa7-426d-aa91-80a4cc785500 \
  --channel-id 27fc6430-7287-448b-ab92-c84ae274c9c7 \
  --origin https://mild-zen-goat.rick.runwingman.com \
  --url https://rick.runwingman.com --bot-crypto --json
```

For an owner-delegated manager session, add
`--owner npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy`.
That requires existing `wapps:read` delegation covering this installation.
Do not replace failed readiness with a human-signed Tower self-grant query,
Feed probe, or automatic key rotation.

Validation commands:

```bash
bun test src/wapps/publisher-readiness.test.ts src/wapps/wapp-publishing-client.test.ts src/server/publisher-readiness-routes.test.ts src/server/wapps-api-routes.test.ts src/server/owner-space-routes.test.ts src/auth/wapp-activity-authority.test.ts src/auth/nip98-verifier.test.ts clis/appctl-readiness.test.ts
bun run typecheck
git diff --check
```

Results: 74 tests passed, 0 failed, 453 assertions; release TypeScript check
passed; whitespace check passed. Tests use temporary custody stores and mock
Tower responses. CLI tests run against an isolated ephemeral HTTP test server.
These checks do not establish live publisher readiness.

Changed files:

- `clis/appctl.ts`, `clis/appctl-readiness.test.ts`
- `src/wapps/managed-publishing.ts`
- `src/wapps/publisher-readiness.ts`, `src/wapps/publisher-readiness.test.ts`
- `src/wapps/wapp-publishing-client.ts`, `src/wapps/wapp-publishing-client.test.ts`
- `src/server/wapps-api-routes.ts`, `src/server/publisher-readiness-routes.test.ts`
- `src/auth/nip98-verifier.test.ts`
- `docs/wapp-flightdeck-publishing.md`
- `docs/book-of-sand-publisher-readiness-handoff.md`

Pending: operator activation of the changed Autopilot source, then live read-only
smoke test using the exact scheduled execution authority and/or permitted
owner-delegated management identity. Manager owns helper and scheduler prompt
integration. No restart, stop, deployment, push, publisher rotation, channel
message, or Feed item was performed during this repair.

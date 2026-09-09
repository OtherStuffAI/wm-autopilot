# Tower FIPS implementation progress — 2026-09-09

Task: `1da9bddc-a57b-423a-848e-5676b8f9ef68`; manager session: `408e11dc-9c04-4c0b-b0db-930984b3301a`.
Worker: `8a8256f3-b51f-472b-949e-85c15d4abfdf`. Goal active; nextAction `reflect`.

## Investigation

- Starting Autopilot HEAD: `82df1df`, main. Existing untracked implementation brief and signing-policy pickup brief preserved. No source edits at intake.
- Read root AGENTS.md and Flight Deck AGENTS.md, platform/workflow skills and supervision reference. `docs/architecture.md` referenced by AGENTS.md is absent.
- Resolved architecture versions v1–v5; v5 remains latest. Inspected nested text, containers and arrow bindings. Tower owns shared authority; Autopilot owns runtime/subscriptions; Flight Deck owns Dexie and UI synchronization.
- Read live task and comments (including manager execution contract and known reload warning), and plan revision 1/body through broker-signed typed PG APIs.
- Context recovery: `bun clis/wingman.ts flightdeck task show 1da9bddc-a57b-423a-848e-5676b8f9ef68 --workspace 2e5caefd-dd65-45d2-b747-ee874e8e5fc9 --tower-url https://sb4.otherstuff.studio --app-npub npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5 --json` succeeded. Inherited MCP context has no dispatch routing; explicit URL/app were required. No key access or grant changes.
- `bun clis/sessions.ts metadata-update --goal "Implement and validate Tower FIPS transport with real mesh A/B recordings and manager handoff" --next-action reflect` succeeded.
- `docker version --format '{{.Server.Version}}'`: `28.5.1`.
- Existing native runtime inspection is macOS launchd-specific; isolated Linux mesh readiness needs an explicit supported path. PG client currently signs URLs then uses direct fetch. Storage downloads may follow external presigned URLs and need explicit handling.
- Read existing two-user release harness guide. Keep reload, signed-history, dispatch/session reuse, offline catch-up, separate A/B recordings and cleanup assertions intact.

## Core implementation checkpoint (in progress)

- Added persistent per-connection transport configuration with legacy HTTPS migration, FIPS-only creation, expected service identity validation, stable logical connection URL and no subscription/cursor mutation on transport switch.
- Native socket adapter derives mesh address with `fipsctl address <public-node-npub>`, pins TCP while retaining exact signed Host/path/query/body, and supports streamed response cancellation. Linux readiness checks real daemon/TUN status; macOS reuses native runtime inspection.
- Shared transport verifies `/health` service npub before mesh signing/use; rejects redirects, unapproved destinations and stale signed targets. Explicit mesh failure never selects HTTPS. Conflicting approvals for one origin fail clearly.
- PG helper signing/request path, SSE/polling, CLI signed requests and storage content fallback now route through selected transport. Workspace settings card uses existing Dexie/liveQuery/Alpine materialization and shows selection/effective route, identity, request/event times, counters and test action.
- Independent acceptance review read from `docs/handoffs/2026-09-09-tower-fips-acceptance-review.md`. Its TLS/network/fault-window requirements are part of remaining acceptance, not waived.

## Validation

- Initial `bun run typecheck`: pass. Intermediate type error in new route's untyped JSON corrected; rerunning broader validation.
- `bun test src/agent-chat/tower-transport.test.ts src/agent-chat/backend-connection-store.test.ts src/server/agent-chat-routes.test.ts`: 46 pass, 0 fail.
- `bun test src/agent-chat/tower-client.test.ts src/flightdeck-pg src/server/static-routes.test.ts src/ui/views/settings/workspace-settings-model.test.js src/agent-chat/backend-connection-store.test.ts src/agent-chat/tower-transport.test.ts`: 60 pass, 0 fail (7 files), log `/tmp/tower-fips-focused.log`.
- `bun test src/agent-chat/tower-connection-settings.test.ts`: 2 pass, 0 fail. Real SQLite reopen/migration, FIPS-only config, retained IDs/cursors and scoped reconnect checked.
- `git diff --check`: pass at checkpoint.
- Existing harness: `cd /Users/mini/code/wm/flightdeck && node scripts/release-test/run.mjs run`: **passed**, including separate A/B recordings, signed history, same-session dispatch, reload, offline catch-up, owned Autopilot restart and cleanup. Evidence root: `/Users/mini/code/wm/flightdeck/test-results/release/fd-release-1788961710795-11de2948`; manifest: `manifest.json`; browser report: `browser/report.json`. This is the existing **HTTP public-listener baseline**, not TLS HTTPS or real-mesh acceptance. Source/build fingerprints are recorded in its manifest. The known member reload assertion passed this run without weakening.
- Required TLS baseline, real isolated mesh, independent egress assertions, complete fault matrix and final A/B mesh evidence remain pending. Current adapter socket tests are not real-mesh evidence.

## Runtime activation

Live host unchanged. No restart, push or production transport switch performed. Pete will restart only after implementation, acceptance evidence and manager review. Task remains in_progress.

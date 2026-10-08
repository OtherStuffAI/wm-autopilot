# Agent Direct Pipeline

Agent Direct Pipeline is an explicit per-agent opt-in that enriches the existing Agent Direct session before its normal prompt submission. Direct and Pipeline Chooser retain their existing behavior. Existing profiles are not migrated into the new mode.

Configuration is keyed by Tower workspace ID and pins an enrichment pipeline version. `agent-direct-context` version 1 loads authoritative conversation, asks Jev yes/no context questions, recalls useful memory if configured, selects useful capability descriptions, and returns bounded structured context. The default usefulness threshold is 0.9, context budget is 6,000 characters, and timeout is 12 seconds. Memory supports None and explicit owner, source, app, group, label, actor and visibility filters. Independent candidate questions are batched; delivered context is deduplicated per session.

The actual five-step definition is used by the runtime and visible pipeline viewer. Only the approved context functions are allowed in enrichment definitions. Enrichment cannot publish chat replies, dispatch agents or grant tool permissions. Pipeline contracts come from definition and block metadata; tool descriptors come from existing MCP registrations. This prototype injects contextual recommendations, not callable tool hot-loading. Existing authorised tools remain available.

## Durability and boundaries

A routing submission lease covers session resolution and enrichment. Each turn captures its mode and workspace configuration; queued requests keep their own profile snapshot. Changing settings affects later requests. SQLite persists enrichment results and the intended prompt before transport. Context enters the delivered manifest only after prompt acceptance, including acceptance recovered from transcript evidence. Late results are fenced by attempt tokens. A replacement session has a fresh manifest and bootstrap prompt.

Timeouts, graph failures and missing configuration are explicit diagnostic outcomes and continue normal Direct without supplemental context. Agent Direct remains the only progress/final publisher and delivery reconciler. Dispatch displays enrichment status, the pipeline run, session and normal final delivery. Dispatch evidence contains counts and status rather than private context contents.

Tower remains authoritative for workspace and graph visibility. Enrichment signs the exact `/api/v4/graph/search` URL through the current broker bot identity and uses workspace-owner, graph-owner and app filters. It never uses direct Neo4j search or impersonates the workspace owner. Autopilot executes the pipeline; Flight Deck coordinates and displays outcomes.

## Verification and activation

Focused Bun tests exercise bootstrap, followup, topic changes, dedupe, None, errors, timeout, concurrent comments, captured mode, replacement sessions, durable recovery and publication prevention. The reusable browser fixture runs real settings components, profile API/store and Dispatch table against a disposable server:

```sh
bun scripts/verify-agent-direct-enrichment-browser.ts --playwright /Users/mini/code/wm/flightdeck/node_modules/playwright/index.mjs --chrome '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --evidence tmp/docs/handoffs/agent-direct-browser
bun run typecheck
```

The settings option is gated by the enrichment-options backend endpoint, so an older running backend does not advertise the new mode. After review, the operator must restart Autopilot from outside its managed sessions at a coordinated gate; this implementation does not restart it. Refresh settings, select Agent Direct Pipeline, supply the exact workspace ID and pin `agent-direct-context` v1. Start with memory None. Test bootstrap, a same-topic followup, a new topic with a useful available capability, concurrent comments, timeout continuation and returning to Direct. Verify one session and one final per request in Dispatch.

Tower graph reads require an app registered under the exact workspace owner. Both legacy `workspace_apps` registrations and the app namespace of a typed Flight Deck PG workspace are supported. A typed-only workspace does not need a duplicate legacy registration. Keep workspace, graph-owner, app and optional group filters on every query; an unknown app or wrong workspace must still be rejected.

Verify graph access separately from enrichment: a successful signed search with no matches proves access, while useful memory recall requires a matching authorised record to be selected and delivered through the bound session. Memory None and failure fallback do not prove memory-enabled success. Distinguish component fixtures, actual application-shell browser checks and live runtime checks in the handoff. Backend source changes require a coordinated Autopilot restart before they can be claimed active; static settings assets alone do not prove the loaded backend revision.

The release typecheck is the supported source check. The broad tsconfig currently also parses ignored WebKit artifacts under `tmp/docs/handoffs/iphone-sizing` and encounters existing JavaScript parse errors there.

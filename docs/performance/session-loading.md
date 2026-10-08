# Session history loading

Session selection subscribes to Dexie immediately. Browser-saved messages display
without waiting for the server, agent or SSE. An independent saved-history request
hydrates IndexedDB before a background fresh-transcript request runs. Loading ends
when there are visible cached rows or a successful history response; an empty cache
alone does not prove an empty conversation. Refresh errors retain messages and offer
an accessible retry control.

`GET /api/sessions/:id/messages` and `GET /api/sessions/:id/history` read durable
server history. `messages?refresh=true` requests current upstream history and reports
upstream failure with HTTP 502. Message responses include a `Server-Timing`
header covering history read/sync and JSON serialization, separately from network
and request authorization. Delegate/owner-space message routes use the same
response helper. Clients needing current history must explicitly request refresh.

Attached PTY Codex and Claude transcripts are authoritative. When available, fresh
sync reads them directly instead of waiting for a terminal scrape that would be
replaced by native history. SDK and unattached discovery paths retain their own
transport behavior. Per-session server sync coalesces in-flight requests; errors do
not start the successful-refresh throttle. A durable write that arrives during
upstream/native I/O prevents the older snapshot from replacing it.

Browser request coordination coalesces bootstrap reads from the chat and runtime
controllers. Switching aborts requests and invalidates the chat load generation,
including A → B → A switches. IndexedDB message mutations increment a revision in
the same transaction; HTTP reconciliation checks its captured revision before
applying. Newer SSE, optimistic or HTTP writes therefore invalidate old responses,
including responses racing from another browser tab. Snapshot watermarks preserve
newer unmatched local messages. Reconciliation matches identities through indexes,
keeps local row IDs and speech attachments, and writes only changed rows in bulk.
Identified SSE messages use the compound identity index; legacy messages use the
timestamp index, avoiding full-history reads on each assistant update.
The existing conversation window limits rendered messages.

## Repeatable validation

The harness uses a disposable local HTTP server, browser profile, transcript files
and message store. It never sends an agent prompt or modifies production history.
Use an installed Playwright module and browser:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
BROWSER_EXECUTABLE=/absolute/path/to/chrome \
SESSION_LOAD_SAMPLES=10 \
bun test ./scripts/session-load.browser.test.ts

bun test ./scripts/session-native-load.test.ts
bun test ./src/ui/live/session-history-loader.test.js \
  ./src/server/live-session-message-sync.test.ts \
  ./src/server/live-session-messages.test.ts \
  ./src/server/session-message-response.test.ts \
  ./src/server/session-history-response.test.ts
```

Browser output reports first visible message timings for cached, saved-server and
5,000-row histories, plus HTTP resource sizes/durations, snapshot-to-Dexie commit,
and live-query callback-to-visible-frame time. It also checks delayed refresh,
rapid switches (including cached-first/current timings for A → B → A), failed refresh/retry, empty history, stale HTTP versus SSE, ordering,
and speech preservation. Performance entries named
`session-history:<session>:saved|fresh:http|dexie|total` are also available in DevTools;
the HTTP duration includes response decoding and browser scheduling, while Resource
Timing isolates the network. These entries record durations, never transcript text.

The native harness checks all 2,000 messages in source order and records upstream,
native resolution/parsing, persistence and total durations with a 3-second delayed
terminal source. The optimized path makes zero terminal calls. To compare an older
revision, save its `live-session-messages.ts` under a verified ignored directory,
resolve its relative imports to the same source modules, and pass its absolute path
as `SESSION_SYNC_BASELINE_MODULE`. `SESSION_NATIVE_SAMPLES` and
`SESSION_NATIVE_UPSTREAM_MS` control sample size and the disposable upstream delay.

For isolated IndexedDB reconciliation timings, run the browser command with
`SESSION_STORE_BENCHMARK_ONLY=1`. To compare the old store, serve that revision's
`src/ui/live/db.js` using `SESSION_STORE_BASELINE_MODULE=/absolute/ignored/file.js`.
`SESSION_LOAD_BASELINE=1` disables new-behavior checks when running the full old UI.
Record the revisions and conditions with the measurements; keep run-specific logs
and screenshots in ignored handoffs or on the task.

These are selection-to-render measurements after UI modules are ready. They do not
include login or whole-application startup. Local fixtures cannot establish live
public-host performance: measure signing, HTTP headers/body, native sync, Dexie and
rendering separately before assigning a delay to SSE or another segment. New server
code requires operator activation and a public-host smoke test before claiming live
completion.

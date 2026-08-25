# Complete-URL NIP-98: Autopilot implementation handoff

## Goal

Make Autopilot's legacy Tower SSE client sign the complete semantic stream URL before appending the transport-only NIP-98 token.

Flight Deck task: `ef00fedf-f087-4304-9eeb-155ec60d81d4` in workspace `2e5caefd-dd65-45d2-b747-ee874e8e5fc9`.

Source: Flight Deck document `Tower Live Updates` (`261f5fbf-e981-479c-ab6c-bc2c45bd0b98`) and originating message `ec98abd2-b28c-4a09-9293-08245815a5ac`.

## Current defect

`src/agent-chat/tower-client.ts` `buildStreamUrl` signs the base stream URL, then adds `token`, then adds `last_event_id`. Strict Tower verification will reject the request because `last_event_id` is semantic and must be in the signed `u` URL.

## Required implementation

- Construct the legacy stream URL.
- Add `last_event_id` when present.
- Sign that exact URL.
- Append only the transport `token` after signing.
- Return the final EventSource URL.
- Confirm the Flight Deck PG Authorization-header stream already signs cursor, limit and repeated audience_npub values before fetching; add a regression test if coverage is missing.
- Do not create an ignore-query compatibility path.

## Tests

Extend `src/agent-chat/tower-client.test.ts` to prove:

- the signer receives the URL containing `last_event_id`;
- the signer URL does not contain `token`;
- the returned EventSource URL contains both `last_event_id` and `token`;
- absent `last_event_id` remains valid;
- URL encoding remains stable.

Run the focused test file and the appropriate full Autopilot suite.

## Repo and Git constraints

Work in `/Users/mini/code/wm/autopilot` on `main`. The worktree was clean before dispatch. Preserve concurrent changes and commit all nonignored tested worktree state. Do not push, deploy or restart Autopilot.

Report the diagnosis, changed files, validation commands/results, commit SHA and any remaining rollout concern through the supervised dispatch callback only. Rick will update the Flight Deck task and originating chat thread.

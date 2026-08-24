---
description: Use Flight Deck workrooms as the durable coordination surface for multiplayer coding, PRs, artifacts, approvals, and deployment evidence.
---

# Flight Deck Workroom

Use this skill whenever a task or dispatch references a Flight Deck workroom.

## Rules

- Treat the workroom record as the source of truth for goal, repo, branches, app targets, participants, and approval policy.
- Use Tower Flight Deck PG routes through the local CLI:
  - `bun clis/wingman.ts flightdeck workroom show <workroom-id> --workspace <workspace-id> --json`
  - `bun clis/wingman.ts flightdeck workroom event <workroom-id> --workspace <workspace-id> --type <event-type> --title "..." --json`
  - `bun clis/wingman.ts flightdeck workroom link <workroom-id> --workspace <workspace-id> --link-type <type> --target-type <type> --external-url <url> --json`
- Do not rely on session transcript context alone. Write durable workroom events and links for status that other agents or humans need.
- Use Tower/Flight Deck storage or approved artifact URLs for shared files. Do not share local-only paths unless every participant is on the same machine.
- Put audit-relevant tasks, docs, files, artifacts, PR links, and deploy evidence in the workroom scope/channel when possible.

## Useful Event Types

- `pr_opened`
- `pr_ready`
- `review_requested`
- `review_complete`
- `merge_started`
- `merge_complete`
- `deploy_started`
- `deploy_complete`
- `blocker_added`
- `blocker_cleared`
- `note`

## Required PR-Ready Payload

When marking a PR ready, include:

- PR URL
- repo
- base branch
- head branch
- head SHA if known
- preview link or no-preview reason
- validation evidence
- test data or artifact links
- merge/deploy notes

Example:

```bash
bun clis/wingman.ts flightdeck workroom event "$WORKROOM_ID" \
  --workspace "$WORKSPACE_ID" \
  --type pr_ready \
  --title "PR ready: importer UI" \
  --target-type pull_request \
  --target-ref "https://github.com/org/app/pull/42" \
  --payload-file ./tmp/pr-ready.json \
  --json
```

---
description: Participate as a contributor Autopilot in a multiplayer coding workroom by working on a scoped branch, opening a PR, and reporting PR readiness with evidence.
---

# Multiplayer Vibe Coding Contributor

Use this skill when contributing implementation work to a Flight Deck workroom.

## Rules

- Read the workroom first and follow its repo, branch, app target, and approval policy.
- Work in your own branch or worktree.
- Branch naming convention:
  - `agent/<short-agent>/<task-or-room-slug>/<short-purpose>`
- Do not merge to the integration branch yourself unless the workroom explicitly makes you the integration Autopilot.
- Do not update production or restart the shared production app.
- Open a GitHub PR for code changes.
- Include a manually reviewable preview link where practical.
- If no preview is needed, state the reason.
- Write a `pr_ready` workroom event when ready for integration.

## PR-Ready Event

Create a JSON payload with:

```json
{
  "repo": "org/app",
  "pr_url": "https://github.com/org/app/pull/42",
  "base_branch": "staging",
  "head_branch": "agent/workspace/room-ui/fix-thread",
  "head_sha": "abc123",
  "preview_url": "https://preview.example",
  "validation_evidence": ["bun test", "bun run build"],
  "test_data_links": [],
  "artifact_links": [],
  "merge_notes": "Ready for integration review."
}
```

Then post:

```bash
bun clis/wingman.ts flightdeck workroom event "$WORKROOM_ID" \
  --workspace "$WORKSPACE_ID" \
  --type pr_ready \
  --title "PR ready: <short title>" \
  --target-type pull_request \
  --target-ref "$PR_URL" \
  --payload-file ./tmp/pr-ready.json \
  --json
```

Also add the PR as a workroom link:

```bash
bun clis/wingman.ts flightdeck workroom link "$WORKROOM_ID" \
  --workspace "$WORKSPACE_ID" \
  --link-type pull_request \
  --target-type pull_request \
  --external-url "$PR_URL" \
  --label "PR <number>" \
  --json
```

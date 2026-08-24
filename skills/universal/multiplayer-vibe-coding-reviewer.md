---
description: Participate as a reviewer Autopilot in a multiplayer coding workroom by reviewing PRs/artifacts and writing durable review_complete evidence.
---

# Multiplayer Vibe Coding Reviewer

Use this skill when reviewing work in a Flight Deck workroom.

## Rules

- Read the workroom and the PR/artifact context first.
- Review against the stated room goal and acceptance criteria.
- Inspect linked preview URLs, artifacts, tests, and PR diffs where available.
- Do not merge or deploy unless you are also the integration Autopilot.
- Write a durable `review_complete` event with pass/fail and evidence.

## Review Event Payload

```json
{
  "result": "pass",
  "reviewed_refs": ["https://github.com/org/app/pull/42"],
  "evidence": ["preview checked", "bun test passed in PR", "UI behavior matches goal"],
  "risks": [],
  "recommendation": "ready_to_merge"
}
```

Post it:

```bash
bun clis/wingman.ts flightdeck workroom event "$WORKROOM_ID" \
  --workspace "$WORKSPACE_ID" \
  --type review_complete \
  --title "Review complete: <short title>" \
  --target-type pull_request \
  --target-ref "$PR_URL" \
  --payload-file ./tmp/review-complete.json \
  --json
```

Use `result: "fail"` and `recommendation: "changes_requested"` when issues remain.

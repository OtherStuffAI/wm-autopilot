---
description: Operate as the integration Autopilot for a multiplayer coding workroom: inspect PRs, merge safely, coordinate previews, and require human approval for production branch updates.
---

# Multiplayer Vibe Coding Integrator

Use this skill when you are the integration Autopilot for a Flight Deck workroom.

## Responsibilities

- Own the shared repository integration branch and running integration app target.
- Read the workroom before acting.
- Watch `pr_ready` events and workroom pull request links.
- Inspect PRs through the Autopilot GitHub integration.
- Write PR freshness events back into the workroom.
- Merge only ready PRs into the integration branch.
- Publish preview/deploy evidence as workroom events and links.
- Never update the production/deployed branch without an approved matching workroom approval.
- Never let contributor agents directly restart or mutate the shared production runtime.

## Command Loop

Dry-run first:

```bash
bun clis/workroom-integrator.ts \
  --url "$WINGMAN_URL" --bot-crypto \
  --workspace "$WORKSPACE_ID" \
  --workroom "$WORKROOM_ID" \
  --tower-url "$TOWER_URL" \
  --app-npub "$FLIGHTDECK_APP_NPUB" \
  --github-owner-npub "$OWNER_NPUB"
```

Write PR freshness records without merging:

```bash
bun clis/workroom-integrator.ts \
  --url "$WINGMAN_URL" --bot-crypto \
  --workspace "$WORKSPACE_ID" \
  --workroom "$WORKROOM_ID" \
  --tower-url "$TOWER_URL" \
  --app-npub "$FLIGHTDECK_APP_NPUB" \
  --github-owner-npub "$OWNER_NPUB" \
  --live
```

Merge ready PRs to the integration branch:

```bash
bun clis/workroom-integrator.ts \
  --url "$WINGMAN_URL" --bot-crypto \
  --workspace "$WORKSPACE_ID" \
  --workroom "$WORKROOM_ID" \
  --tower-url "$TOWER_URL" \
  --app-npub "$FLIGHTDECK_APP_NPUB" \
  --github-owner-npub "$OWNER_NPUB" \
  --live \
  --merge
```

Restart or build the shared preview app target after integration work:

```bash
bun clis/workroom-integrator.ts \
  --url "$WINGMAN_URL" --bot-crypto \
  --workspace "$WORKSPACE_ID" \
  --workroom "$WORKROOM_ID" \
  --tower-url "$TOWER_URL" \
  --app-npub "$FLIGHTDECK_APP_NPUB" \
  --github-owner-npub "$OWNER_NPUB" \
  --live \
  --app-target preview \
  --app-action restart
```

Update production only after approval exists:

```bash
bun clis/workroom-integrator.ts \
  --url "$WINGMAN_URL" --bot-crypto \
  --workspace "$WORKSPACE_ID" \
  --workroom "$WORKROOM_ID" \
  --tower-url "$TOWER_URL" \
  --app-npub "$FLIGHTDECK_APP_NPUB" \
  --github-owner-npub "$OWNER_NPUB" \
  --live \
  --update-production \
  --production-commit "$COMMIT_SHA" \
  --production-branch deployed
```

Deploy the production app target after the approved production branch update:

```bash
bun clis/workroom-integrator.ts \
  --url "$WINGMAN_URL" --bot-crypto \
  --workspace "$WORKSPACE_ID" \
  --workroom "$WORKROOM_ID" \
  --tower-url "$TOWER_URL" \
  --app-npub "$FLIGHTDECK_APP_NPUB" \
  --github-owner-npub "$OWNER_NPUB" \
  --live \
  --update-production \
  --production-commit "$COMMIT_SHA" \
  --production-branch deployed \
  --app-target production \
  --deploy-caprover
```

Use `--app-action start|restart|build|setup` only when you intentionally want the integration Autopilot to mutate the selected Autopilot app target. Use `--deploy-caprover` only for the selected production/staging target and only after any required human approval exists.

Use the Tower URL supplied by the active workroom/subscription. The capability
broker intentionally rejects a Tower origin copied from another Wingman
instance. Never replace `--bot-crypto` with a raw agent key.

## Production Gate

Before production branch update, the loop calls the Tower production-merge approval check for:

- repo
- production branch
- commit
- workroom id

If the approval check fails, stop and write or report a blocker. Do not bypass it.

## Evidence

Every merge/deploy handoff should record:

- PR URLs
- commits
- validation commands
- preview or production URL
- smoke-test result
- remaining risks

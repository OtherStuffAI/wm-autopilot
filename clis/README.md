# Wingman CLIs

NIP-98 authenticated command-line tools for interacting with Wingman servers.

## Authentication

All CLIs authenticate using NIP-98 (Nostr HTTP Auth). In an Autopilot agent
session, CLIs automatically use `SESSION_ID` and `WINGMAN_CAPABILITY` to sign as
the stable agent identity through the capability broker. `--bot-crypto` can be
supplied explicitly but is not required when that session context is present.

Explicit operator recovery outside an agent session may provide a signing key
via:

1. `--key <nsec|hex>` flag
2. `WINGMAN_NSEC` environment variable (explicit operator recovery only)

Set the server URL via `--url` or `WINGMAN_URL`. Agent sessions should use the
injected canonical `WINGMAN_URL`; a different origin is intentionally rejected
unless the session capability explicitly includes it.

Administrator-assigned NIP-98 challenge policies can additionally accept the
strict `--tags-json` tuples supported by `wingman-capability.ts nip98`. The
broker, not the CLI, validates tag names, cardinality, value bounds, expiry,
target, method, and exact request-body hash. The CLI has no raw-key fallback.

Agent sessions also receive host-local `WINGMAN_BROKER_URL`. The bearer
capability is sent only there; `--url` selects the NIP-98 target and can never
redirect the bearer to a remote Autopilot.

## CLIs

### appctl — App lifecycle management

```bash
bun clis/appctl.ts list
bun clis/appctl.ts status <app-id>
bun clis/appctl.ts start <app-id>
bun clis/appctl.ts stop <app-id>
bun clis/appctl.ts restart <app-id>
bun clis/appctl.ts build <app-id>
bun clis/appctl.ts setup <app-id>
bun clis/appctl.ts register <app-id> --directory /path/to/app
bun clis/appctl.ts unregister <app-id>
bun clis/appctl.ts clone <repo-url> --directory my-project
bun clis/appctl.ts starters
bun clis/appctl.ts starters-create --name "My Template" --git-url <url> [--web-app]
bun clis/appctl.ts starters-delete <id>
```

### sessions — Session management

```bash
bun clis/sessions.ts list
bun clis/sessions.ts create claude-code --name "my-task" --directory /tmp/project
bun clis/sessions.ts info <session-id>
bun clis/sessions.ts logs <session-id>
bun clis/sessions.ts send <session-id> "do the thing"
bun clis/sessions.ts stop <session-id>
bun clis/sessions.ts stop-self --bot-crypto
bun clis/sessions.ts nightwatch-status <session-id>
bun clis/sessions.ts nightwatch-enable <session-id> --nightwatch-interval 10
bun clis/sessions.ts nightwatch-disable <session-id>
bun clis/sessions.ts artifacts <session-id>
bun clis/sessions.ts queue <session-id>
bun clis/sessions.ts queue-add <session-id> "run the tests"
bun clis/sessions.ts queue-next <session-id>
bun clis/sessions.ts archive [--limit 20] [--filter text]
bun clis/sessions.ts archive-info <archive-id>
bun clis/sessions.ts archive-logs <archive-id>
bun clis/sessions.ts archive-delete <archive-id>
```

### nightwatch — Night Watch control

```bash
bun clis/nightwatch.ts status <session-id>
bun clis/nightwatch.ts enable <session-id> --nightwatch-prompt "Any progress?" --nightwatch-interval 10
bun clis/nightwatch.ts disable <session-id>
bun clis/nightwatch.ts config
bun clis/nightwatch.ts reports
```

### dispatch — Supervised session work

Dispatch creates a worker whose terminal result is retained in the calling session's exact callback inbox. Inbox wakes are internal turns and do not consume ordinary prompt queue rows.

```bash
bun clis/wingman.ts dispatch create --agent codex --directory /tmp/project --prompt "do the thing"
bun clis/wingman.ts dispatch inbox
bun clis/wingman.ts dispatch status <dispatch-id>
bun clis/wingman.ts dispatch acknowledge <dispatch-id>
bun clis/wingman.ts dispatch close <dispatch-id>
bun clis/wingman.ts dispatch retry <dispatch-id>
```

`SESSION_ID` scopes `inbox`, `acknowledge`, `close`, and `retry` to the exact callback session. Another session owned by the same npub cannot handle those callbacks.

### delegate-sessions — Bot-delegated session management

This compatibility frontend uses maintained session routes and shared broker
credentials. It reads caller space by default; `--owner <npub>` explicitly selects
a delegated owner space under server authorization. It does not infer a legacy
bot owner or require exported signing keys. Prefer `sessions.ts` for additional
session operations.

```bash
bun clis/sessions.ts list --bot-crypto
bun clis/delegate-sessions.ts create codex --name "worker" --directory /tmp/project
bun clis/delegate-sessions.ts info <session-id>
bun clis/delegate-sessions.ts read <session-id>
bun clis/delegate-sessions.ts send <session-id> "do the thing"
bun clis/delegate-sessions.ts stop <session-id>
bun clis/delegate-sessions.ts create codex --name "worker" --metadata '{"role":"heartbeat-worker"}'
```

### status — System overview

```bash
bun clis/status.ts                         # combined dashboard (apps + sessions)
bun clis/status.ts full                    # everything: config, flags, apps, sessions, recent archives
bun clis/status.ts apps                    # app summary
bun clis/status.ts sessions                # session summary
bun clis/status.ts config                  # server configuration
bun clis/status.ts flags                   # feature flags
bun clis/status.ts flags-set <key> on_admin # states: off, on_admin, on; true/false aliases
bun clis/status.ts restart                 # trigger warm restart
bun clis/status.ts restart --bot-crypto # stop sessions, restart, then native-resume or start fresh
bun clis/status.ts restart-status --bot-crypto # agent: check restart progress
```

### deploy — CapRover deployments

```bash
bun clis/deploy.ts list
bun clis/deploy.ts deploy <app-id> --target <exact-target-name> --caprover-name my-app-prod
bun clis/deploy.ts deployments <app-id> --owner <owner-npub> # inspect exact registered app
bun clis/deploy.ts status <app-id>
bun clis/deploy.ts logs <app-id>
```

### scheduler — Trigger management

Supported scheduler trigger types are `cron` and `file_watcher`. Nostr relay
events cannot create or invoke scheduler work. Historical relay-trigger rows
remain visible as unsupported and inert until an operator deletes or converts
them to a supported trigger type.

```bash
bun clis/scheduler.ts list
bun clis/scheduler.ts create --name "Daily run" --agent codex --working-directory /tmp/project --prompt "check repo" --trigger-type cron --cron "0 * * * *"
bun clis/scheduler.ts update <job-id> --enabled false
bun clis/scheduler.ts delete <job-id>
bun clis/scheduler.ts trigger <job-id>
bun clis/scheduler.ts runs <job-id>
```

Operational CLIs reject unknown flags, flags for a different command, and surplus
arguments before requests. `--nightwatch` is retired; it does not configure jobs.
Scheduler trigger text distinguishes sessions, pipeline runs, cleanup and no work.

Deployment and legacy delegated-session commands use the shared session broker
automatically in managed sessions; `--bot-crypto` makes that choice explicit.
The delegated-session compatibility CLI uses maintained `/api/sessions` routes,
with optional explicit `--owner` and create `--model`; it does not use obsolete
`/api/delegate-sessions` owner inference. Exact IDs avoid collection lookup. `deploy`, `pipelines`
and `scheduler` accept `--owner <npub>` and never substitute a default owner when
that value is missing. Owner-space authorization remains enforced by the server.

`deploy deployments <exact-local-app-id>` reads the supported CapRover inspection
API using existing broker credentials. Optional `--caprover-name` selects the
remote name explicitly; without it the registered link is used. `--target <name>`
filters inspection to an exact configured target and fails if none matches.
`deploy` requires an explicit non-`all` target, sent as `caproverTarget`. It does not log
into CapRover directly. Deployments and scheduler/feature-flag changes require
separate operational authorization; these examples do not grant it.

`status flags` and `status full` show each flag's stored and effective state.
`status flags-set <key> <off|on_admin|on>` updates the existing flag with PATCH;
`true` and `false` map to `on` and `off`. Invalid states fail before requests.
Full status surfaces failed API reads instead of reporting empty status.

The shared default URL is `http://127.0.0.1:3600`; `--url`, `WINGMAN_URL` and
`PORT` override it in that order. Deployment commands run from current source;
server authorization repairs require separately approved runtime activation.

See [maintained Flight Deck workflows](../docs/cli-flightdeck-workflows.md) for
complete comment retrieval, routed mentions, thread creation/renaming, verified
file downloads and safe document editing.

Older raw-key Flight Deck scripts such as `mycode/flightdeck-create-doc.mjs`
are retired for brokered sessions. Use maintained `wingman.ts flightdeck` task
and document commands; never export operator signing material to revive helpers.
CapRover inspection now uses `deploy.ts deployments` rather than a standalone
signed API helper. Other helpers must be assessed against current CLI coverage.

## Common flags

| Flag | Description |
|------|-------------|
| `--url <url>` | Wingman server URL |
| `--key <nsec\|hex>` | Nostr signing key |
| `--bot-crypto` | Use the current session capability broker |
| `--json` | Raw JSON output |
| `-h, --help` | Show help |

## Shared library

`clis/lib/auth.ts` contains the shared NIP-98 auth logic used by all CLIs:

- `resolveSecretKey()` — parse nsec/hex key
- `buildAuthHeader()` — construct NIP-98 authorization header
- `requestJson()` — authenticated fetch wrapper
- `resolveBaseUrl()` — URL resolution from flags/env
- `parseCommonFlags()` — shared CLI flag parsing
- `buildConfig()` — combine URL + operator key into a CliConfig
- `buildAuthConfig()` / `requestJsonWithAuth()` — shared broker/operator auth

### Explicit prompt delivery recovery

`bun clis/wingman.ts session queue reconcile <item-id> --revision <read-revision> --claim-token <read-token> --resolution accepted|retry --reason <evidence>` uses exact current-session broker authority. `accepted` records verified acceptance without sending; `retry` explicitly permits another delivery and may duplicate possibly accepted work. Stale versions/tokens and active sends conflict. See [queue delivery and retention contract](../docs/session-prompt-queue.md). No automatic timeout replay or raw-key fallback.

### Reviewed Git publication

Run the current source without restarting Autopilot:

```bash
bun clis/git-push.ts commit-and-push --directory /path/to/repo --remote origin --branch main --message "fix: describe change"
```

The default command stages all nonignored changes and blocks oversized committed files.
Review the full diff and the listed oversized files before deliberately accepting size:

```bash
bun clis/git-push.ts reviewed-commit-and-push --directory /path/to/repo --remote origin --branch main --message "fix: describe change" --acknowledge-large-files --review-reason "Reviewer: why these files belong in Git"
```

Both review flags are required. This overrides only the 5 MB size block; dangerous
tracked file patterns and a missing committed `.gitignore` remain blocking. The
command checks the staged tree, commits only when needed, checks the final commit
again after hooks, prints accepted oversized paths and the reason, and pushes that
exact commit to the named branch. Commit failure prevents push. No force push or
history rewriting is performed. A block can leave changes staged for inspection.
The `push` subcommand pushes existing committed content with normal checks.

Git inherits the caller's existing credentials, including Wingman's host-scoped
`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*` credential helpers
and their broker environment. Existing configured Git/SSH credentials also work.
Run from the authorized session environment; do not copy tokens into arguments,
remote URLs, or documentation. Interactive credential prompts are disabled.

API push requests and MCP `git_push` accept `reviewedLargeFiles: true` with a
nonempty `reviewReason`. These server/MCP changes require an explicitly approved
Autopilot host restart; a source checkout update alone does not activate them.
The CLI above runs fresh source immediately and does not restart the host.

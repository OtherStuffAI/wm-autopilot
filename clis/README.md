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
bun clis/sessions.ts create claude-code --name "my-task" --directory /tmp/project --nightwatch true
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

Use this when you are operating as a user's Wingman bot and want the server
to authorize based on the bot->owner relationship rather than a browser session
or agent `SESSION_ID`.

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
bun clis/status.ts flags-set <id> true     # set a feature flag
bun clis/status.ts restart                 # trigger warm restart
bun clis/status.ts restart --bot-crypto # stop sessions, restart, then native-resume or start fresh
bun clis/status.ts restart-status --bot-crypto # agent: check restart progress
```

### deploy — CapRover deployments

```bash
bun clis/deploy.ts list
bun clis/deploy.ts deploy <app-id> --caprover-name my-app-prod
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
bun clis/scheduler.ts create --name "Daily run" --agent codex --working-directory /tmp/project --prompt "check repo" --trigger-type cron --cron "0 * * * *" --nightwatch true
bun clis/scheduler.ts update <job-id> --enabled false --nightwatch false
bun clis/scheduler.ts delete <job-id>
bun clis/scheduler.ts trigger <job-id>
bun clis/scheduler.ts runs <job-id>
```

## Common flags

| Flag | Description |
|------|-------------|
| `--url <url>` | Wingman server URL |
| `--key <nsec\|hex>` | Nostr signing key |
| `--json` | Raw JSON output |
| `-h, --help` | Show help |

## Shared library

`clis/lib/auth.ts` contains the shared NIP-98 auth logic used by all CLIs:

- `resolveSecretKey()` — parse nsec/hex key
- `buildAuthHeader()` — construct NIP-98 authorization header
- `requestJson()` — authenticated fetch wrapper
- `resolveBaseUrl()` — URL resolution from flags/env
- `parseCommonFlags()` — shared CLI flag parsing
- `buildConfig()` — combine URL + key into a CliConfig

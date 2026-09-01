# Wingman Autopilot

Autopilot is the runtime that turns AI agents into an operable part of Wingman Be Free. It launches and supervises agent sessions, runs declarative pipelines and triggers, manages apps and WApps, and gives operators live control over the work running on their Wingman machine.

Autopilot is one of three distinct parts of the core system:

- **Autopilot runs the work.** It owns agents, sessions, pipelines, triggers, managed apps, and their runtime lifecycle.
- **Tower holds the shared truth.** It owns authentication, workspaces, typed APIs, storage, and graph access boundaries.
- **Flight Deck coordinates the people and work.** It is the browser interface for chat, tasks, documents, approvals, and launching WApps.

A person can coordinate work in Flight Deck, an agent or pipeline can carry it out through Autopilot, and both can use Tower as the shared authority. Autopilot does not redefine Tower's workspace contract or own Flight Deck's coordination records; it provides the execution environment around them.

This repository contains the Bun server, browser control surfaces, CLIs, session adapters, pipeline engine, and app runtime that make that execution layer work.

## Core Responsibilities

- Launch and manage agent sessions for Codex, Claude, Goose, OpenCode, and other supported adapters
- Provide browser control surfaces such as `/home` and `/live`
- Broker MCP tools and agent-side capabilities back into Wingman over HTTP
- Manage per-user bot keys, session identity, and delegated NIP-98 flows
- Expose operational APIs for apps, git/Gitea, pipelines, triggers, memories, and Nostr operations
- Inject agent-local environment and MCP configuration, including bot-key material when available

## Terminology Notes

Some internal routes and modules still use older naming:

- `AGENT_NSEC` is the environment variable used to inject a session bot key into an agent process
- deployment-specific identities must be supplied through configuration, not product defaults

Those names are still real implementation details, but the current product framing is:

- Wingman = agent runtime and control plane
- Pipelines = reusable automation definitions and runs
- Delegate sessions / agent sessions = the programmable session layer around agents

## Getting Started

Install dependencies:

```bash
bun install
```

Installation automatically prepares the verified loopback-only AgentAPI
binary. If a compatible Go compiler is unavailable, the installer downloads a
checksummed project-local toolchain under `.cache/toolchains`; no system Go
installation is required. Startup repeats this check and repairs a missing or
stale binary when necessary.

Launch the orchestration server:

```bash
bun start
```

Run the local orchestration server under PM2:

```bash
pm2 start ecosystem.config.cjs --only wm-ap
pm2 logs wm-ap
pm2 restart wm-ap --update-env
pm2 stop wm-ap
```

The PM2 ecosystem config runs `bun run src/index.ts` from this checkout. It does
not define Wingman environment variables; Bun uses the `.env` file in this
directory for runtime configuration.

Visit:

- `http://localhost:<PORT>/home` for the session dashboard
- `http://localhost:<PORT>/live` for the real-time live/session surface

## Tower-backed Forgejo issues

Agent sessions can read and write repository issues through Tower without a
Forgejo token or private signing key:

```bash
bun clis/wingman.ts forgejo issues list \
  --workspace <workspace-id> --repo <repository-id> --state open

bun clis/wingman.ts forgejo issues read 1 \
  --workspace <workspace-id> --repo <repository-id>

bun clis/wingman.ts forgejo issues create \
  --workspace <workspace-id> --repo <repository-id> \
  --title "Outcome-oriented title" --body-file issue.md

bun clis/wingman.ts forgejo issues comment 1 \
  --workspace <workspace-id> --repo <repository-id> \
  --body-file update.md
```

The CLI uses `TOWER_URL` plus the session-provided `WINGMAN_URL`, `SESSION_ID`,
and `WINGMAN_CAPABILITY`. Autopilot brokers the agent's short-lived NIP-98
proof, while the CLI sends the exact signed body to Tower's issue API. It never
calls Forgejo directly and does not accept a human key or provider token.

## CapRover Targets

The app deploy dialog can deploy to one or more CapRover instances. Existing
single-target configuration still works:

```env
CAPROVER_URL=https://captain.example.com
LOGIN_CODE=...
```

To keep a warm standby CapRover on a second VPS, add:

```env
CAPROVER_SECONDARY_URL=https://captain-standby.example.com
CAPROVER_SECONDARY_LOGIN_CODE=...
```

When both targets are configured, the deploy dialog defaults to all targets.
Failures are tracked per target, so a failed primary deploy does not stop the
secondary deploy. Operators can also choose a single target from the dialog.

For custom names, set `CAPROVER_TARGETS=primary,backup` and provide
`CAPROVER_BACKUP_URL` plus `CAPROVER_BACKUP_PASSWORD` or
`CAPROVER_BACKUP_LOGIN_CODE`.

## Docker-First Setup

On a fresh server with Docker and Docker Compose installed:

```bash
git clone https://github.com/example/wingman-autopilot.git
cd wingman-autopilot
chmod +x setupwizard.sh
./setupwizard.sh
```

The setup wizard prompts for:

- admin npub
- instance name and host port on the base machine
- public base URL
- host workspace directory mounted at `/workspace`
- path or subdomain app routing
- optional `WINGMAN_PRIV`

It writes an instance Docker env file such as `.env.wingman-01`, creates the
host workspace directory, and can immediately run:

```bash
docker compose --env-file .env.wingman-01 up -d --build
```

The plain `.env` file is reserved for local `bun start` development. Docker
instances should use `.env.wingman-01`, `.env.wingman-02`, and so on so local
and container settings do not overlap.

Docker setup defaults to `REGISTER=false`: unknown users cannot self-register.
The configured admin npub, or comma-separated admin npubs, can bootstrap the first login, then add approved users
from Settings -> Users.
It also defaults to `WINGMAN_SHARED_INSTANCE=true`, so whitelisted users see the
same apps, sessions, workspace connection, and dispatch activity for the single
Wingman bot.

The default instance is `wingman-01`; if Docker already has that Compose project,
the wizard moves to `wingman-02`, `wingman-03`, and so on. The first instance
mounts the base-machine directory `~/.wm-ap` at `/workspace`; later generated
instances use numbered directories such as `~/.wm-ap02` and `~/.wm-ap03`.
The generated `WINGMAN_HOST_PORT` is the base-machine port published by Docker.
The container keeps its internal Wingman port at `3600`, so a host value such as
`3321` maps `localhost:3321` on the base machine to `3600` inside the container.
Cloudflare should point at the host port, for example `http://localhost:3321`;
do not set a separate container port per instance.

Use the restart helper to operate local or Docker envs without remembering the
Compose incantation:

```bash
chmod +x restart_wingman.sh
./restart_wingman.sh
./restart_wingman.sh --env .env.wingman-01 --restart
./restart_wingman.sh --env .env.wingman-01 --reload-env
./restart_wingman.sh --env .env.wingman-01 --rebuild
./restart_wingman.sh .env.wingman-01 status
```

`restart` only restarts the existing container. `reload-env` recreates the
container from the selected `.env.<instance>` file. `rebuild` rebuilds the image
and recreates the container.

Open a shell in the persistent `/home/wingman` environment and run the CLI login
flows from inside the container:

```bash
docker compose --env-file .env.wingman-01 exec wingman bash
codex --login
claude
goose configure
opencode auth login
gemini
pi
```

The image installs Codex, Claude, Goose, OpenCode, Gemini, and Pi by default.
All agent CLI paths are pinned to `/usr/local/bin/*` so Wingman launches the
authenticated container tools rather than project-local binaries.

Set `WINGMAN_PRIV=nsec1...` in the instance Docker env file when you want this instance to
use a single shared Wingman bot identity. Admins can copy the nsec from the
identity panel; normal operators only see the public bot identity details.

Agent profiles use separate non-exportable keys generated inside the encrypted local vault.
Deleting an Agent Profile permanently removes that locally managed key after its workspace
subscriptions have been removed or rebound. If the profile used the shared `WINGMAN_PRIV`
identity, profile deletion cannot edit Docker configuration: remove `WINGMAN_PRIV` from the
instance `.env.<name>` file and recreate the container before trusting the instance identity.
Use **Add Agent Profile** after that to generate a fresh agent key inside the container.

Run the readiness checklist any time:

```bash
docker compose --env-file .env.wingman-01 exec wingman bun run docker:check
```

For CapRover branch deploys with persistent app state, see
`docs/caprover-deploy.md`.

The checklist reports installed tools, writable Docker volumes, configured
Wingman URLs/workspace values, required secrets, and whether CLI auth files are
detectable in `/home/wingman`.

For local HTTP testing, setup sets `WINGMAN_IDENTITY_COOKIE_SECURE=false` so
browsers accept the development session cookie. For HTTPS tunnel deployments,
setup sets secure cookies when the public base URL starts with `https://`.

Docker provisioning also pins agent CLI paths to `/usr/local/bin/*` so project
dependencies inside `/app/node_modules/.bin` cannot shadow the authenticated
container CLIs. The Files page, launch directory picker, and app file pickers
all use the configured Wingman workspace root, `/workspace` by default. That
path is a bind mount from `WINGMAN_WORKSPACE_HOST_PATH` on the base machine, so
the operator can inspect files directly outside Docker. Codex sessions trust
`/workspace` by default to avoid an interactive first-run trust prompt in the
web UI.

For hosted app subdomains, configure the base-machine Cloudflare Tunnel with
both `apps.example.invalid` and `*.apps.example.invalid` pointing to the Wingman host
port. Then set `WINGMAN_APP_ROUTING=subdomain` and
`WINGMAN_SUBDOMAIN_BASE_DOMAIN=apps.example.invalid` in the instance Docker env file.
Settings -> Workspace shows the current routing mode and can generate the
matching Docker env snippet.

Cloudflare also needs an edge certificate that covers the nested wildcard app
hostnames, for example `*.apps.example.invalid`. A certificate for
`*.example.invalid` does not cover `rare-zap-horn.apps.example.invalid`.

For noninteractive provisioning, the underlying helper is still available:

```bash
bun run docker:provision --admin-npub npub1...
docker compose --env-file .env.wingman-01 up -d --build
```

## Runtime Model

Wingmen is a long-running Bun server that:

1. serves the web UI and operational HTTP APIs
2. allocates ports and spawns agent runtimes
3. tracks sessions, logs, messages, and status
4. injects MCP config and per-session identity/env context
5. exposes higher-level app, git, pipeline, trigger, memory, and Nostr tooling to agents and operators

## App Lifecycle CLI (NIP-98)

Use `scripts/wingman-appctl.ts` to control registered apps over HTTP with NIP-98 auth headers.

```bash
export WINGMAN_NSEC=nsec1...

bun run appctl list
bun run appctl status <app-id>
bun run appctl start <app-id>
bun run appctl stop <app-id>
bun run appctl setup <app-id>
```

Options:

- `--base-url <url>` target Wingman base URL
- `--key <nsec|hex>` override signing key for this invocation
- `--json` print raw API responses

## Environment

| Variable | Description | Default |
|---|---|---|
| `PORT` | Primary Wingman UI/API port | `3600` |
| `AGENT_PORTS` | Starting port assigned to agent subprocesses | `3700` |
| `AGENT_MAX` | Total number of concurrent agent ports available | `10` |
| `HOST_URL_BASE` | Optional template for legacy port-proxy app links; `<port>` is replaced with the app's assigned port. Subdomain app routing should normally leave this unset. | unset |
| `DIRECTORY_DEF` | Working directory used when launching agent subprocesses | `~/code` |
| `AGENT_DISPATCH_DIRECTORY` | Working directory used by default Flight Deck dispatch agents | `DIRECTORY_DEF` |
| `FOLDERACCESS` | Comma-separated directories exposed to file browsers and pickers | `DIRECTORY_DEF` |
| `APP_ROUTING` | Hosted app routing mode: `path` or `subdomain` | `subdomain` |
| `SUBDOMAIN_BASE_DOMAIN` | Base domain for hosted app aliases, e.g. `apps.example.invalid` | unset |
| `SUBDOMAIN_PROXY_ENABLED` | Enables wildcard subdomain proxying when a base domain is set | `true` |
| `AGENT_SPAWN_MODE` | Agent spawn mode. Only direct `bun` spawning is supported; legacy values are ignored. | `bun` |
| `AGENT_MODE` | Deprecated compatibility input; `pm2` and `tmux` values are ignored. | unset |
| `WINGMAN_AGENT_DISPATCH_ADMIN_ONLY` | Restrict 33357 auto-join and workspace event dispatch to configured admin npubs | `false` |
| `DISPATCH_INBOX_WAKE_MAX_ATTEMPTS` | Wake turns allowed for an unchanged supervised-dispatch inbox before it becomes inspectably blocked | `3` |
| `DISPATCH_INBOX_WAKE_LEASE_MS` | Durable wake claim/submission lease used for restart recovery | `300000` |
| `DISPATCH_INBOX_WAKE_RETRY_INITIAL_MS` | Initial retry delay for failed or no-progress inbox wakes | `5000` |
| `DISPATCH_INBOX_WAKE_RETRY_MAX_MS` | Maximum inbox wake retry delay | `300000` |
| `AGENTAPI_BIN` | Primary binary path for the AgentAPI executable | `./out/agentapi` |
| `AGENT_CLI_AUTOUPDATE` | Set to `true` to allow Codex/Claude CLI background update checks in new sessions | `false` |
| `KEYTELEPORT_PRIVKEY` | App private key used to decrypt Key Teleport blobs | unset |
| `KEYTELEPORT_WELCOME_PUBKEY` | Trusted Welcome pubkey for Key Teleport event verification | unset |
| `KEYTELEPORT_WELCOME_URL` | Welcome Key Teleport app URL | `https://welcome.nostr.com` |
| `CLAUDE_CLI` | Executable invoked for Claude sessions | `claude` |
| `GLOVES` | Claude approval mode; `OFF` adds skip-permissions | unset |
| `GOOSE_CLI` | Executable invoked for Goose sessions | `goose` |
| `CODEX_CLI` | Executable invoked for Codex sessions | `codex` |
| `OPENCODE_CLI` | Executable invoked for OpenCode sessions | `opencode` |
| `GEMINI_CLI` | Executable invoked for Gemini sessions | `gemini` |
| `PI_CLI` | Executable invoked for Pi sessions | `pi` |
| `AGENTAPI_ALLOWED_ORIGINS` | Value passed to AgentAPI `--allowed-origins` | `*` |
| `AGENTAPI_ALLOWED_HOSTS` | Value passed to AgentAPI `--allowed-hosts` | `localhost,127.0.0.1,[::1]` |

## Workflow Overview

- `Home` lists sessions and lets operators start or stop agents.
- `Live` shows running sessions, conversation state, logs, and prompt dispatch.
- Pipelines let operators define reusable automation patterns.
- App management controls registered local apps.
- MCP tooling exposes memories, git, Nostr, image generation, and more to agents.

Current implementation guides are indexed in [docs/README.md](docs/README.md).

## Session Recovery

Autopilot restarts use logical session recovery rather than relying on agent processes to survive. Open **Settings → Restart**, call `POST /api/system/restart`, or run:

```bash
bun clis/status.ts restart
```

Active agent processes stop before Autopilot restarts. Each replacement resumes through the agent's native session ID when possible and otherwise starts fresh with the same launch context. An in-flight turn may be interrupted.

Direct Bun spawning remains the default. PM2 and tmux agent spawn modes are compatibility inputs and are not recommended for credential-bearing sessions.

## Documentation Notes

- `docs/` contains only current as-built behavior and operator runbooks.
- Drafts, audits, plans, handoffs, and implementation reports belong under the
  repository-local `tmp/docs-local/` directory, which Git ignores.
- When a local design is implemented, write or update an as-built guide rather
  than publishing the planning document.

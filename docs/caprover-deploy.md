# CapRover Autopilot Deploy

Autopilot is a single CapRover app with persistent directories. GitHub branch deploys can rebuild the app while keeping agent state, CLI auth, SQLite data, and workspace files.

## App

Recommended app name examples:

```text
autopilot-stable
autopilot-operator
autopilot-client-name
```

Create the app as a persistent CapRover web app.

Recommended settings:

- Has Persistent Data: on
- Deployment method: GitHub
- Branch: `deployed-stable`
- Root `captain-definition`: included in this repo
- Container HTTP Port: `3600`
- Websocket Support: on

## Persistent Directories

Add these persistent directories in CapRover App Configs:

```text
/home/wingman
/app/data
/workspace
```

Optional but useful:

```text
/app/tmp
```

What they hold:

| Path | Contents |
| --- | --- |
| `/home/wingman` | CLI auth, Codex/Claude/Goose/OpenCode config, shell state |
| `/app/data` | Autopilot SQLite/runtime state |
| `/workspace` | checked-out workspaces, generated apps, user/project files |
| `/app/tmp` | temporary runtime files that may be useful across restarts |

Do not scale this app above one instance when using these local persistent directories.

## Required Env

Minimum production env:

```env
PORT=3600
HOME=/home/wingman
DIRECTORY_DEF=/workspace
FOLDERACCESS=/workspace

WINGMAN_BASE_URL=https://autopilot-stable.YOUR_CAPROVER_ROOT_DOMAIN
IDENTITY_COOKIE_SECURE=true

APP_ROUTING=path
SUBDOMAIN_PROXY_ENABLED=true

AGENT_SPAWN_MODE=bun
AGENT_PORTS=3700
AGENT_MAX=10
AGENTAPI_ALLOWED_HOSTS=localhost,127.0.0.1,[::1]

DEFAULT_AGENT=codex
CODEX_CLI=/usr/local/bin/codex
CODEX_TRUSTED_WORKSPACE=/workspace
CLAUDE_CLI=/usr/local/bin/claude
GOOSE_CLI=/usr/local/bin/goose
OPENCODE_CLI=/usr/local/bin/opencode
GEMINI_CLI=/usr/local/bin/gemini
PI_CLI=/usr/local/bin/pi

IDENTITY_SESSION_SECRET=REPLACE_WITH_LONG_RANDOM_SECRET
ADMIN_NPUB=npub1...
WINGMAN_INSTANCE_NAME=autopilot-stable
WINGMAN_SHARED_INSTANCE=true
WINGMAN_SETUP_NONINTERACTIVE=true
```

The same values are available as a copyable template in:

```text
caprover.env.example
```

Optional bot key:

```env
WINGMAN_PRIV=nsec1...
```

For subdomain app routing, also set:

```env
APP_ROUTING=subdomain
SUBDOMAIN_BASE_DOMAIN=autopilot-stable.YOUR_DOMAIN
SUBDOMAIN_PROXY_ENABLED=true
WINGMAN_BASE_URL=https://autopilot-stable.YOUR_DOMAIN
```

The wildcard DNS/certificate must cover hosted app aliases below that domain.

## Stable Branch Update Flow

1. Merge or fast-forward the release commit to `deployed-stable`.
2. CapRover rebuilds the Autopilot app from GitHub.
3. The container restarts with the same persistent directories.
4. Run the readiness check from CapRover shell access:

```bash
bun run docker:check
```

## First Login

Open a CapRover shell for the app after the first deploy and log into subscription CLIs inside the container:

```bash
codex
claude
goose configure
opencode auth login
gemini
pi
```

Those auth files are written under `/home/wingman`, so they survive later CapRover rebuilds.

## Rollback

Use CapRover's previous deployment rollback, or move `deployed-stable` back to a known-good commit and rebuild.

Do not delete the app's persistent directories during rollback.

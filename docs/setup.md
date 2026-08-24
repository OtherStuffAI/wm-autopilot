# Docker Setup Runbook

This runbook covers two common flows:

1. spinning up the local Docker instance named `wingman-mw-wingman-1`
2. cloning the repo on a remote machine and building a deployable Docker instance

The container name `wingman-mw-wingman-1` comes from Docker Compose:

- `COMPOSE_PROJECT_NAME=wingman-mw`
- service name `wingman`
- container suffix `1`

That means the instance env file should be `.env.wingman-mw` and it must contain `COMPOSE_PROJECT_NAME=wingman-mw`.

## 1. Local Test: `wingman-mw-wingman-1`

From the project root:

```bash
cd /opt/wingman/autopilot
```

Confirm the env file exists and is targeting the expected Compose project:

```bash
test -f .env.wingman-mw
grep -E '^(COMPOSE_PROJECT_NAME|WINGMAN_INSTANCE_NAME|WINGMAN_HOST_PORT|WINGMAN_BASE_URL)=' .env.wingman-mw
```

Expected values should include:

```bash
COMPOSE_PROJECT_NAME=wingman-mw
WINGMAN_INSTANCE_NAME=wingman-mw
```

Build the Docker image from the current local checkout:

```bash
docker compose --env-file .env.wingman-mw build --pull wingman
```

Start or recreate the local test container:

```bash
docker compose --env-file .env.wingman-mw up -d --force-recreate wingman
```

Check that the expected container is running:

```bash
docker compose --env-file .env.wingman-mw ps
docker ps --filter name=wingman-mw-wingman-1
```

Run the readiness check inside the container:

```bash
docker compose --env-file .env.wingman-mw exec wingman bun run docker:check
```

Tail logs if startup fails or the UI does not respond:

```bash
docker compose --env-file .env.wingman-mw logs --tail=200 wingman
```

Open the configured local URL:

```bash
grep '^WINGMAN_BASE_URL=' .env.wingman-mw
```

For local HTTP testing, the URL is usually `http://localhost:<WINGMAN_HOST_PORT>/home`.

If agent CLIs need login state, open a shell in the persistent container home and authenticate there:

```bash
docker compose --env-file .env.wingman-mw exec wingman bash
codex --login
claude
goose configure
opencode auth login
gemini
pi
```

Use the helper for common operations:

```bash
./restart_wingman.sh --env .env.wingman-mw --logs
./restart_wingman.sh --env .env.wingman-mw --restart
./restart_wingman.sh --env .env.wingman-mw --rebuild
```

## 2. Remote Machine: Build From GitHub Clone

Install prerequisites on the remote host:

- Git
- Docker Engine
- Docker Compose v2
- Bun, only needed for the noninteractive provisioning command

Clone the repo:

```bash
git clone https://github.com/example/wingman-autopilot.git
cd wingman-autopilot
```

### Interactive Setup

Use this path when setting up a machine by hand:

```bash
chmod +x setupwizard.sh
./setupwizard.sh
```

The wizard prompts for:

- admin `npub`
- instance name
- host port
- public base URL
- host workspace directory mounted at `/workspace`
- app routing mode
- optional `WINGMAN_PRIV`
- optional Key Teleport settings (`WINGMAN_KEYTELEPORT_PRIVKEY`,
  `WINGMAN_KEYTELEPORT_WELCOME_PUBKEY`)

The wizard creates the host workspace directory and makes it writable by the
container user. This matters on Linux hosts because the container runs as the
non-root `wingman` user, while the bind-mounted host directory is usually owned
by the SSH user.

At the end, let the wizard build and start Docker, or run:

```bash
docker compose --env-file .env.<instance-name> up -d --build
```

### Noninteractive Setup

Use this path for repeatable remote setup:

```bash
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bun install --frozen-lockfile
```

Create an instance env file:

```bash
bun run docker:provision \
  --admin-npub npub1REPLACE_WITH_ADMIN_NPUB \
  --instance-name wingman-mw \
  --env .env.wingman-mw \
  --host-port 3600 \
  --base-url http://localhost:3600 \
  --workspace-host-path "$HOME/.wm-ap-mw"
```

For a public HTTPS deployment, set the real URL instead:

```bash
bun run docker:provision \
  --admin-npub npub1REPLACE_WITH_ADMIN_NPUB \
  --instance-name wingman-mw \
  --env .env.wingman-mw \
  --host-port 3600 \
  --base-url https://wingman.example.com \
  --workspace-host-path "$HOME/.wm-ap-mw"
```

`docker:provision` creates the host workspace directory and sets mode `0777` so
the non-root container user can create agent workdirs below `/workspace`.

Build and start:

```bash
docker compose --env-file .env.wingman-mw up -d --build
```

Verify:

```bash
docker compose --env-file .env.wingman-mw ps
docker compose --env-file .env.wingman-mw exec wingman bun run docker:check
docker compose --env-file .env.wingman-mw logs --tail=100 wingman
```

Log into the agent CLIs inside the container:

```bash
docker compose --env-file .env.wingman-mw exec wingman bash
codex --login
claude
goose configure
opencode auth login
gemini
pi
```

## Updating an Existing Remote Deployment

From the cloned repo on the remote host:

```bash
git pull --ff-only
docker compose --env-file .env.wingman-mw up -d --build --force-recreate wingman
docker compose --env-file .env.wingman-mw exec wingman bun run docker:check
```

Use the correct env file for the instance you are updating. Do not use the plain `.env` file for Docker deployments; `.env` is reserved for local `bun start` development.

## Notes

- The Docker image defaults to `wingman-autopilot:local`.
- `/workspace` inside the container is a bind mount from `WINGMAN_WORKSPACE_HOST_PATH` on the host. If agent setup fails with `EACCES: permission denied, mkdir '/workspace/<agent>'`, fix the host path permissions and recreate the container:
  `chmod 0777 "$WINGMAN_WORKSPACE_HOST_PATH" && docker compose --env-file .env.<instance-name> up -d --force-recreate wingman`.
- `/home/wingman`, `/app/data`, and `/app/tmp` are persistent Docker volumes.
- `WINGMAN_ADMIN_NPUB` is required for Docker startup and may contain a comma-separated list for multiple admins.
- `WINGMAN_PRIV` is optional but recommended when the instance should use one shared Wingman bot identity.
- CLI auth state is intentionally not baked into the image. Authenticate CLIs inside the running container.

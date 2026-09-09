# Isolated two-user release-test Autopilot contract

This image runs the real `src/index.ts` server, broker vault, default-profile
bootstrap, Tower subscription consumer, dispatch, session binding, turn bridge,
and signed reply publisher. Only the Pi ACP executable is deterministic. It
returns `Isolated release test reply. Prompt SHA-256: <64 hex characters>` for
each authoritative prompt. It does not contact Tower or possess a bot key.
No pipelines or auth bypasses are introduced. Ordinary boot is unchanged.

## Manager bootstrap/config contract

Build from the selected Autopilot source revision:

```sh
docker build -f scripts/isolated-test/Dockerfile \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t autopilot-two-user-runtime:local .
```

Use a unique run-owned container, private Docker network and **new named volume**
mounted at `/app/data`. Do not mount host directories, existing volumes, provider
credentials or Docker sockets. Publish only `127.0.0.1:<isolated-port>:3600`.
The image runs as user `bun`. `/workspace` is an empty container-local directory.

Required environment:

| Variable | Value |
| --- | --- |
| `WINGMAN_ISOLATED_TEST_RUNTIME` | `1` (default off; missing value refuses boot) |
| `WAPP_TOWER_URL` | URL of the run-owned Tower, reachable inside Docker |
| `CONNECT_RELAYS` | Run-owned relay WebSocket URL; never public relay defaults |
| `WINGMAN_BASE_URL` | Browser-visible isolated Autopilot URL |

Do not provide `ADMIN_NPUB`, `IDENTITY_SESSION_SECRET` or `WINGMAN_PRIV`.
The entrypoint generates its own dedicated admin identity and session secret in
`/app/data/isolated-test/bootstrap.json` (0600 inside a 0700 directory). This is
an infrastructure bootstrap identity, distinct from test humans A/B. Normal
Autopilot boot generates its instance identity and default agent/broker vault.
The entrypoint selects `DEFAULT_AGENT=pi`, enables the existing `pi-use-acp`
flag, and sets `PI_ACP_CLI` to the deterministic executable. Leave profile model
unset. Restarting the same run-owned volume preserves these identities.

Authenticated bootstrap operations use normal exact-body NIP-98. The helper
signs as the newly generated admin entirely inside Docker, never exports its
secret, and accepts JSON request bodies on stdin:

```sh
docker exec "$container" bun scripts/isolated-test/api.ts GET /api/agent-chat/agents
docker exec -i "$container" bun scripts/isolated-test/api.ts POST \
  /api/agent-chat/agent-connect/import < run-owned-agent-connect-request.json
docker exec "$container" bun scripts/isolated-test/api.ts GET /api/agent-chat/subscriptions
docker exec "$container" bun scripts/isolated-test/api.ts GET /api/agent-chat/dispatch-outcomes
```

The first response exposes the default `agents[].agentId`, `botNpub`, and
`defaults.defaultAgentProfileId`. Use that public bot identity in Tower's normal
workspace agent registration/grant flow. Import body is
`{"agentProfileId":"<default id>","package":<Tower Agent Connect package>}`.
Tower URLs embedded in the package must be reachable from this container.
The manager owns Tower workspace/agent grants and Flight Deck browser setup;
this helper is infrastructure API setup and must not be described as all-UI.

The Docker health check performs the authenticated agents GET and requires a
nonempty default profile. Then require subscription
connectivity before the browser chat assertions. A healthy HTTP server alone
does not prove Tower delivery. Persist actual image ID, source revision, public
bot npub, workspace/thread/session/turn IDs and test outcomes in the manager's
manifest. Never attach bootstrap JSON or private volume contents.

Stop/remove only the run-owned container and volume. Do not invoke host restart
scripts. For review retention keep the private volume local. For repeat isolation
create a new volume and regenerate all users/workspace fixtures.

The supplied Compose file implements this lifecycle. Set `TEST_RUN_ID`,
`SOURCE_REVISION`, `TEST_AUTOPILOT_PORT`, `TEST_TOWER_URL`, `TEST_RELAY_URL`, and
`TEST_NETWORK` to the manager's run-specific values, then use:

```sh
docker compose --env-file /dev/null -p "two-user-$TEST_RUN_ID" \
  -f scripts/isolated-test/compose.yaml up --build -d --wait
docker compose --env-file /dev/null -p "two-user-$TEST_RUN_ID" \
  -f scripts/isolated-test/compose.yaml ps
docker compose --env-file /dev/null -p "two-user-$TEST_RUN_ID" \
  -f scripts/isolated-test/compose.yaml down --volumes
```

`--env-file /dev/null` avoids reading a checkout's existing environment file.
Use a new empty `DOCKER_CONFIG` directory for public registry builds to avoid
consulting host registry credentials. If Docker Desktop's CLI plugins are only
found through its normal config, put `cliPluginsExtraDirs` pointing to the
installed Docker CLI plugin directory in this new config; do not copy auths.

## Native validation

```sh
bun test scripts/isolated-test/deterministic-acp.test.ts \
  src/agents/process-manager-pi-acp.test.ts \
  src/agent-chat/flightdeck-session-turn-bridge.test.ts \
  src/agent-chat/flightdeck-dispatch-outcome-store.test.ts
bun run typecheck
```

The process test exercises real stdio ACP and two completed turns. The existing
turn-bridge tests are focused unit tests, not proof of the full-stack browser
scenario. The manager must still run actual Tower trigger consumption and
broker-signed publication in the two-browser release test.

## Runtime smoke evidence (2026-09-09)

An isolated Linux arm64 container booted with `--network none` and a new Docker
data volume. Normal NIP-98 authentication returned the generated
`isolated-release-test` profile. `POST /api/sessions` created a real running
session with `agentTransport=pi-acp`, native session binding, and a broker-bound
agent identity. Two `POST /api/sessions/<id>/messages` calls completed two
distinct ACP turns; a subsequent messages GET returned exactly two user and two
assistant records. The smoke session ID was
`8032957e-ebd5-476f-a4ba-f5b35bbf4118`.

All 22 focused native tests and release TypeScript checking passed. This
network-disabled smoke deliberately does not claim Tower trigger delivery or
browser evidence; those remain the manager's full-stack assertions.

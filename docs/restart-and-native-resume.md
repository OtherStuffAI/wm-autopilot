# Restart and recover agent sessions

Autopilot uses one managed restart policy across Settings, the API, and the CLI. It stops every active agent process, records the source session IDs durably, restarts Autopilot, and recreates the sessions.

Each replacement first attempts to use the coding agent's native session ID. If native resume metadata is unavailable, or the native session can no longer load, Autopilot starts a fresh replacement with the same agent, owner, working directory, and operational metadata. The restart outcome reports resumed, fresh, and failed replacements separately.

## Safety

If stopping one session fails, Autopilot attempts to recreate any sessions it already stopped and cancels the restart. The restart marker is stored under `~/.wingmen/restart.json` so the startup recovery list survives the server process exiting.

An in-flight agent turn can be interrupted. Check the replacement session after restart before assuming its last turn completed.

## Admin UI

Open **Settings → Restart** and choose **Restart Autopilot**. The Wingman Server card exposes the same operation.

## API and CLI

Call `POST /api/system/restart` with NIP-98 authentication. The endpoint accepts system administrators, the configured Wingman instance identity, and a live stable-agent identity. Agent sessions obtain that signature through the capability broker. `POST /api/system/restart-and-resume` remains a compatibility alias with identical behavior.

From a live agent session:

```bash
bun clis/status.ts restart --bot-crypto
bun clis/status.ts restart-status --bot-crypto
```

The CLI fails closed if its brokered session context is absent and never falls back to an operator key. Operators may omit `--bot-crypto` and use the existing `--key` or `WINGMAN_NSEC` path. `restart-resume` is retained as a CLI compatibility alias. Use `GET /api/system/restart/status` to inspect the most recent outcome after Autopilot returns.

## Declarative pipelines

The built-in code function `system.restartAndResume` signs and calls the API with the Wingman instance identity. Pass an explicit `autopilotUrl` in the step input. The function returns `status`, `scheduled`, `statusCode`, `sessions`, `blockers`, and `error` fields.

Because a successful call restarts the process, make this the final meaningful step in a pipeline. Add display metadata that exposes `scheduled`, `sessions`, and `error` rather than runtime routing fields.

# Restart and recover agent sessions

Autopilot uses one managed restart policy across Settings, the API, and the CLI. It stops every agent process, records only recovery-eligible source session IDs durably, restarts Autopilot, and recreates those sessions.

Closing a session in the browser calls `DELETE /api/sessions/:id`. Autopilot writes the explicit close intent before stopping the process and scheduling its archive. Warm bootstrap honors that durable close state even when a preexisting restart marker still names the session and even when restart occurs inside the five-second archive delay.

Each replacement first attempts to use the coding agent's native session ID. If native resume metadata is unavailable, or the native session can no longer load, Autopilot starts a fresh replacement with the same agent, owner, working directory, and operational metadata. The restart outcome reports resumed, fresh, and failed replacements separately.

## Safety

If stopping one session fails, Autopilot attempts to recreate any sessions it already stopped and cancels the restart. The restart marker is stored under `~/.wingmen/restart.json` so the startup recovery list survives the server process exiting.

An in-flight agent turn can be interrupted. Check the replacement session after restart before assuming its last turn completed.

`bun clis/status.ts restart-status` reports two separate runtime identities. The controller identity is the Git revision captured when the Bun `src/index.ts` process started; this is the identity that governs restart recovery. The AgentAPI identity is the native `out/agentapi` session-transport sidecar and does not identify the running TypeScript controller. A committed source change is live only when the controller reports that commit after an operator-approved restart.

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

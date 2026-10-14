# Web terminal connection and startup

The web terminal requires a browser admin session and a configured five-digit PIN. PIN verification issues an identity-bound ticket, valid for 30 seconds by default and usable once. The WebSocket upgrade additionally requires a valid admin session, a configured PIN, and an Origin exactly equal to the configured public `WINGMAN_BASE_URL` origin. Missing, `null`, foreign, or path-bearing origins fail closed. Forwarded host, scheme, owner, or authorization headers do not substitute for the browser session or Origin. No anonymous or signed-agent shell path is provided.

The browser displays separate phases: PIN/ticket authentication, WebSocket connection, shell startup, and Connected. `Opening shell...` appears only after the WebSocket opens. Connected means the PTY helper acknowledged successful PTY creation; demonstrate a working shell by running a command and observing its result. Status/availability validates the configured executable and directory and loads the PTY helper, but does not itself demonstrate shell execution.

The default Node bridge waits for its `ready` message after PTY creation. Missing helpers, shell executables, unavailable directories, early helper exits, protocol errors and startup timeout fail with a shell-phase error. Startup has a ten-second server deadline; PIN authentication and the browser upgrade/start phase each have a fifteen-second deadline. Disconnect cancels pending startup and terminates the helper and PTY. A retry owns its own callbacks, so a previous connection cannot overwrite its status. Errors and exit messages survive subsequent close events. Both helper and manager must be activated from the same source revision.

## Diagnose the failing phase

An error before WebSocket connection belongs to PIN/ticket authentication. Check the browser session, admin role, configured PIN and any PIN rate-limit response. Use the existing settings flow to administer terminal security; do not remove PIN protection to diagnose a transport failure.

An error during WebSocket connection does not establish a PTY failure. Browsers conceal HTTP upgrade response bodies from JavaScript. Inspect the upgrade response in browser developer tools and the server's `[terminal]` log, where `phase: upgrade` records origin rejection, missing authentication, invalid ticket, missing PIN configuration or failed upgrade. Verify the page's exact origin matches the configured public origin and that the TLS reverse proxy supports WebSocket upgrades. Use a new PIN authentication attempt after any rejected or expired ticket. Do not record ticket-bearing URLs, cookies, authorization headers or PIN values in shared evidence.

An error after the socket opens belongs to shell startup or the PTY helper. Check `TMAN_NODE_BIN`, `TMAN_SHELL` and `TMAN_CWD`, file execution permissions, the Node-compatible `node-pty` installation and the shell's initialization files. The terminal error remains visible and the Connect button permits another attempt. The server logs startup rejection as `phase: shell`. Changing the environment or source requires an operator-controlled activation; an agent working inside Autopilot must not restart the managed host.

A Connected label alone is insufficient runtime proof. Enter `printf 'TERMINAL_%s_OK\n' SMOKE` and confirm `TERMINAL_SMOKE_OK` in the returned output rather than only the echoed command. Resize the terminal, disconnect, and reconnect once to check cleanup and ticket renewal. A normal `exit` should show Session ended, while a transport loss should show a connection failure with its close code.

## Reusable verification

Run the focused suites from the repository with explicit relative file paths so Bun does not discover archived source under ignored handoff directories:

```sh
bun test ./src/server/terminal-integration.test.ts ./src/server/terminal-websocket.test.ts ./src/server/terminal-routes.test.ts ./src/terminal/node-pty-session.test.ts ./src/terminal/node-pty-helper.test.ts ./src/terminal/terminal-config.test.ts ./src/terminal/terminal-pin-service.test.ts ./src/terminal/terminal-pin-rate-limiter.test.ts ./src/terminal/terminal-ticket-store.test.ts ./src/ui/terminal/connection.test.js ./src/ui/views/terminal-view.test.js ./src/server/static-routes.test.ts
bun run typecheck
```

The integration suite uses a disposable loopback Bun server, real signed session cookies, real PIN hashing/verification, real tickets, real WebSocket upgrades and an isolated native Node PTY running `/bin/sh`. It checks command execution with echo disabled, output, resize, disconnect with shell-PID disappearance, missing-shell failure, normal process exit, and rejected ticket/origin/session cases, including actual rejected WebSocket handshakes. Its admin policy and PIN-verifier persistence are synthetic test adapters; it does not start the production Autopilot server or exercise production identity records. Native platform results do not prove the deployed Linux container or reverse proxy works.

Helper lifecycle tests use controlled subprocess stubs for pending-start cancellation, timeout, spawn errors, helper errors and duplicate exit prevention. Browser connection tests use a fake WebSocket/terminal for reporting, input gating, timeout, stale callbacks and disconnect. Static-route coverage checks that the connection module is served as `application/javascript`. Production acceptance still requires an authorized admin browser on the intended public origin.

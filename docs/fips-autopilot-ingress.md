# Autopilot UI and API over FIPS

Autopilot exposes its complete HTTP service on the existing FIPS node, alongside
its existing public HTTPS endpoint. Pair the machine in WM App once, then open
the endpoint returned by the authenticated status API. No additional DNS name,
public tunnel, discovery server, identity, or gateway impersonation is involved.
Managed apps retain their existing mesh URLs and ports.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `FIPS_AUTOPILOT_ENABLED` | `FIPS_APPS_ENABLED`, or enabled on native macOS | Enable the main UI/API ingress independently of managed apps |
| `FIPS_AUTOPILOT_PORT` | `3601` | Exact mesh listener port, 1024–40999, different from `PORT` |
| `PORT` | Existing installation setting | Loopback forwarding destination; unchanged public service |

Compose explicitly enables both FIPS surfaces by default. The main service uses
a distinct port because its existing wildcard listener already occupies `PORT`.
Invalid settings, an unavailable daemon, or bind conflicts produce an honest
`error`, `unavailable`, or `conflict` descriptor; HTTPS continues to run. A disabled
or unavailable node never substitutes a public URL. `listening` means the local
TCP listener was established, not that a remote peer has demonstrated connectivity.

Docker starts the existing daemon when either surface is enabled and adds only
the configured main ingress port to the upstream `fips0` firewall policy. There
is no Docker host port publication for this listener. Existing managed-app range
handling remains unchanged. The native listener binds only the daemon-reported
mesh IPv6 address; it does not add a wildcard listener or alter macOS PF. Native
installations with an operator PF policy must allow inbound TCP to that exact
mesh address and ingress port on the active FIPS `utun` interface. Do not open
agent ports, the capability broker, or unrelated services. Existing native PoC
network limitations are documented in [fips-native-macos.md](fips-native-macos.md).

## Pairing and status

After activation, an authorized system operator can run:

```bash
bun clis/status.ts fips --url https://YOUR-EXISTING-AUTOPILOT --bot-crypto --json
```

`--bot-crypto` uses a live session's broker and its existing grants; it does not
grant system access. Browser sessions with system access can also read
`GET /api/system/fips`. Responses have the same public descriptor shape as
managed apps, under `fips`: `enabled`, `nodeNpub`, `meshAddress`, `port`, `url`,
`status`, and optional `error`. Private identity material is never returned.

Use the returned `nodeNpub` for manual machine pairing in WM App and open the
exact `fips.url`, normally `http://<nodeNpub>.fips:3601/`. The root redirects to
`/home` on that origin. The paired WM App node supplies `.fips` resolution and
its native Nostr signing bridge. Log in on this origin; HTTPS cookies belong to
the public origin and are not copied across hosts. Apps remain accessible via
their existing managed-app descriptors and Autopilot app routing.

The FIPS hop forwards bytes without rewriting HTTP paths, Host, uploads,
WebSocket frames, SSE, or response headers. NIP-98 signatures must bind the exact
active mesh URL, including query and method; signatures for the public URL are
not accepted on that mesh origin. Existing owner and workspace authorization
still applies. Socket provenance prevents a forwarded mesh client from becoming
a trusted loopback caller, even if it sends `Host: localhost`.

FIPS provides encrypted transport, but its HTTP URL is not browser HTTPS. Only
the exact active mesh origin uses the existing non-Secure, HttpOnly, SameSite
session cookie; HTTPS keeps its configured secure-cookie behavior. This applies
even when the public deployment explicitly forces secure cookies. Use WM App's
native signer; browser device-keystore storage still requires Web Crypto and
does not downgrade encryption when unavailable. UI IDs use `getRandomValues`
so settings, live messages and uploads work without `crypto.randomUUID`, which
browsers may restrict to secure contexts. No browser security flags are changed.

## Activation and validation

Source changes require one operator-managed Autopilot restart outside the agent
session. Coordinate it with the supervising manager: active sessions may be
interrupted. This implementation does not execute that restart. Native FIPS
already running and ready does not need to be reinstalled or restarted. Docker
needs an operator-coordinated rebuild/recreation to load the entrypoint firewall
change as well as the source; do not merely restart the Bun child.

For this native installation, the exact pending managed operation is authenticated
`POST https://rick.runwingman.com/api/system/restart` (the CLI equivalent is
`bun clis/status.ts restart --url https://rick.runwingman.com --bot-crypto`).
The manager must obtain approval acknowledging active-session interruption before
using it. Neither operation was executed during implementation.

After the coordinated native restart (or Docker rebuild/recreation):

1. Confirm the existing HTTPS UI/API still works.
2. Read `/api/system/fips` via the authenticated CLI above; require `listening`.
3. Open the returned URL in paired WM App. Check login, `/home`, assets, app
   launch, a file upload, live SSE updates, and the terminal WebSocket.
4. Confirm unauthorized API and terminal requests remain denied and a different
   owner cannot read the first owner's resources.
5. Disconnect the client FIPS node. The mesh URL must fail visibly while public
   HTTPS remains available. Reconnect and retest using the same paired endpoint.

Automated coverage exercises real TCP HTTP, exact NIP-98 uploads and replay
denials, login/cookies, SSE chunks, WebSocket frames and denied upgrades, spoofed
loopback Host headers, exact mesh binding, missing/disabled nodes, status access,
HTTPS redirects, managed-app regressions, and JavaScript MIME handling. A local
temporary mesh listener can exercise the existing node without restarting the
host, but it cannot activate new routes or auth logic inside the running host.

Discovery/allowlisting and Wingman-operated bootstrap infrastructure are deferred
to separate work. This change does not alter the existing PoC discovery setup.

# FIPS managed-app endpoints PoC

Status: implemented PoC; see `docs/fips-managed-app-endpoints.md`
Date: 2026-09-01

## Goal

Make a Docker/Linux Autopilot installation self-contained for FIPS and give
every running managed web app a stable, mesh-only endpoint:

```text
http://<autopilot-fips-npub>.fips:<webAppPort>/
```

This PoC deliberately excludes Tower. A macOS WMapp client will run its own
bundled FIPS node, open the endpoint in its embedded WebView, and use the
existing `window.nostr` signer bridge for WApp login.

## Required implementation

1. Pin FIPS at `v0.5.0` and build/copy the Linux `fips` and `fipsctl`
   executables into the Autopilot Docker image. Verify downloaded source or
   release artifacts; do not execute an unpinned moving target.
2. Run the bundled daemon as part of container boot, before Autopilot, with a
   persistent identity/config under an Autopilot-owned persistent data path.
   Never place or print the FIPS private key in app responses, logs, argv, or
   ordinary environment variables.
3. Add the container capabilities/device/config needed for `fips0`:
   `/dev/net/tun`, `NET_ADMIN`, IPv6, and persistent data. Keep the feature
   opt-in for this PoC so existing installs continue to boot without those
   privileges.
4. Add a `FipsAppIngressManager` (name may vary) that, for each running
   `webApp: true` app, binds a raw TCP listener to the exact FIPS IPv6 address
   and the app's existing stable `webAppPort`, forwarding bytes to
   `127.0.0.1:<webAppPort>`. Use a protocol-transparent TCP pipe so `/`,
   redirects, cookies, SSE, WebSockets, uploads, and streaming are not path
   rewritten. Never bind the FIPS listener to `[::]`.
5. Start/stop/reconcile listeners with app and Autopilot lifecycle. A listener
   failure must be visible in endpoint health but must not take down the app.
   Handle an app already listening on the FIPS IPv6 address explicitly.
6. Add a non-secret public FIPS descriptor to app API/CLI output, at least:

   ```json
   {
     "fips": {
       "enabled": true,
       "nodeNpub": "npub1...",
       "meshAddress": "fd00::...",
       "port": 41024,
       "url": "http://npub1....fips:41024/",
       "status": "listening"
     }
   }
   ```

7. Default-deny FIPS ingress. Document and/or install the narrow firewall rule
   needed for assigned managed-app ports. A peer ACL is not a substitute for
   service authorization or a `fips0` firewall.

## Configuration

Prefer a single feature switch plus non-secret discovery through `fipsctl`.
Explicit overrides are acceptable for deterministic tests:

```env
FIPS_APPS_ENABLED=true
FIPS_CONFIG_PATH=/app/data/fips/fips.yaml
FIPS_NODE_NPUB=npub1...
FIPS_MESH_ADDRESS=fd00::...
```

The feature must fail closed: if enabled but the daemon/interface cannot be
started or inspected, report unavailable endpoints rather than falling back to
a public URL and calling it FIPS.

## Validation

- Unit-test endpoint derivation, exact-address binding, lifecycle reconciliation,
  and redaction/failure behavior.
- Build the Docker image or at minimum validate its FIPS build stage and compose
  configuration.
- Start a fixture web app on IPv4 loopback and prove the ingress TCP proxy
  forwards HTTP and a long-lived/upgrade-capable byte stream without path
  rewriting.
- `curl -6 http://<node-npub>.fips:<port>/api/health` must reach the app when
  two FIPS nodes peer.
- Stopping the client FIPS node must make the endpoint unreachable.

## Git and reporting

Work on `main`. Preserve concurrent changes. When ready, commit all nonignored,
tested state in this worktree with a Conventional Commit. Do not restart the
currently registered Autopilot process; report if a restart is required.

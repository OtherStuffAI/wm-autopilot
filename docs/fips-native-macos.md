# Native macOS FIPS managed-app endpoints

Native Bun-managed Autopilot installations now use the same FIPS v0.5.0 mesh
contract as Docker and WMapp. On macOS, FIPS app ingress is enabled by default
unless `FIPS_APPS_ENABLED=false` is set explicitly. Startup fails closed when
FIPS is missing or incompatible: normal apps still run, but their `fips`
descriptor reports `unavailable` and never falls back to a public hostname.

## Bundled installer

The repository carries the upstream arm64 and x86_64 v0.5.0 packages in
`vendor/fips`. `scripts/prepare-fips-macos.sh` re-downloads only missing or
invalid packages and verifies these release SHA-256 values:

- arm64: `3c2252677725a30f4ef68f01935ca6741e57568854d3f71202f2fa90d7239052`
- x86_64: `a7883c71039ff591880c38c2421b361103f2ecf20840a9bd496eda13cb3e24c0`

The install command verifies the current-architecture package again immediately
before requesting administrator authorization. Upstream's packages are unsigned
and not notarized. This PoC never disables or weakens Gatekeeper.

## Activation on the Autopilot Mac

From the current Autopilot checkout:

```bash
bun clis/fips.ts status
bun clis/fips.ts install --acknowledge-unsigned-upstream-package
```

The second command is deliberately interactive. macOS shows the normal
administrator authorization dialog. The package installs
`com.fips.daemon` as a system LaunchDaemon with `RunAtLoad`, so FIPS starts at
machine boot independently of Autopilot.

The configuration helper creates one backup at
`/usr/local/etc/fips/fips.yaml.pre-wingman-poc`, then transactionally changes
only the required public settings. It preserves the existing machine identity,
explicit key material, peers, and unrelated settings. Native readiness requires:

- persistent identity;
- Nostr rendezvous `policy: open`, app `wingman-fips-poc-v1`, and advertising;
- LAN rendezvous enabled with scope `wingman-fips-poc-v1` for reliable same-LAN
  discovery;
- an active FIPS TUN interface (`utunN` on macOS) and local `.fips` DNS enabled;
- UDP Nostr advertising and inbound connections, with outbound-only disabled;
- the native control socket at `/var/run/fips/control.sock`.

The root-owned config remains mode `0600`, so Autopilot cannot accidentally read
an operator-supplied `nsec`. The helper instead writes a world-readable,
non-secret `wingman-poc-runtime.json` attestation containing only the validated
booleans and public namespace. Run `repair` again after any manual config change.

The package adds the current console user to the `fips` group. macOS may require
logging out and back in once before that user can access the control socket.
Afterwards:

```bash
bun clis/fips.ts status
```

must report `"ready": true` with only the public `nodeNpub` and mesh address.
It never reads or returns the FIPS private identity.

Autopilot must be restarted once after this code and the daemon are installed so
the running Bun process loads native ingress support. Do not restart it as part
of package installation. On the next startup, each running registered web app
gets a listener on its exact FIPS IPv6 address and existing `webAppPort`.

For the Word5 PoC registered on port 41005, obtain the real URL after startup:

```bash
bun clis/appctl.ts list --url "$WINGMAN_URL" --bot-crypto --json
```

The Word5 record should contain:

```text
http://<autopilot-fips-node-npub>.fips:41005/
```

Paste that exact URL or the app's JSON descriptor into WMapp's **Open FIPS app**
flow. A synthetic npub or URL is not a valid substitute for the descriptor
reported by the running daemon.

## PoC network boundary

The upstream macOS package does not install the Linux `fips.nft` default-deny
policy or an equivalent PF policy. Open rendezvous therefore makes managed app
listeners reachable to authenticated FIPS peers in the shared Wingman PoC
namespace. Treat this as a test-only network boundary; production needs a
per-app authorization policy or a generated PF allowlist before using open
rendezvous broadly.

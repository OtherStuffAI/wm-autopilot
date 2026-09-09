# Tower FIPS rollout and remaining dependencies

Status: implementation and local acceptance complete. **Ready for manager handoff and Pete’s external Autopilot restart for staged testing.** No live restart has occurred.

## Runtime boundary

Tower remains the authority for service/workspace identity, membership, content,
attachments, claims and idempotency. Autopilot owns the selected connection,
subscription cursor, event consumer, dispatch and delivery. WM App is not involved.
An approved mesh-node npub is distinct from the expected Tower service npub.

Existing connections migrate to HTTPS. FIPS-only records need no HTTPS endpoint.
Changing transport retains the logical connection URL, connection/subscription IDs,
cursors and stable bot identity. Exact connection binding is stored in new direct
sessions. An older session with multiple matching owner subscriptions fails clearly
until its explicit binding is repaired; it never selects by array order.

## Operator sequence after acceptance and manager review

1. Pete restarts Autopilot from outside its managed sessions. Worker has not restarted
   the live host or switched its control connection.
2. Open Settings → Workspaces → the owned Tower connection. Select FIPS, enter
   `http://<approved-mesh-node-npub>.fips:<explicit-port>` and expected Tower service npub.
   Retain an HTTPS endpoint only if explicit rollback is desired. Apply transport.
3. Ensure the native FIPS daemon is ready (persistent identity, active TUN) and the
   capability broker policy grants the exact mesh origin, required workspace/storage
   paths, HTTP methods and body hashes to the existing stable bot profile. Do not
   export a signing key or broaden grants to arbitrary origins. Reissue existing
   session capabilities through the normal broker flow after a policy change;
   policy edits do not widen already-issued capabilities.
4. Test connection verifies mesh service identity and an authorized workspace read.
   Inspect selected/effective transport, error/reconnect state, verified identity,
   last request/event and separate HTTPS/FIPS counters. A failed mesh remains failed.
5. Start with a staged workspace. Verify one mention/reply and follow-up, durable
   signed history, attachment access and recovery before selecting production FIPS.

Rollback is explicit HTTPS selection on that same connection, where configured.
Apply and Test; IDs/cursors remain. FIPS-only configuration stays disconnected on
mesh outage. There is no automatic HTTPS fallback. Rollback needs the same owner
permission as initial approval.

## Dependency inventory

- Migrated PG runtime: workspace authorization, SSE and recovery polling, audiences,
  context, invocation claims/acknowledgements, activity, chat/finals, task/document
  reads and writes, storage upload and signed content download.
- Bound CLI/MCP finite requests use the live host transport and its counters, with
  exact-target broker signing. Generic unbound operator CLI calls keep explicit URL
  behavior; they do not inherit an arbitrary owner's transport by hostname.
- Historical source-label maintenance reads the transport from its explicitly
  supplied database and uses a separate local adapter; its telemetry is local to
  that maintenance process. It is not a second runtime event dispatcher.
- Legacy Yoke records/history, groups, workspace-key mappings/registration and legacy
  record streams retain their existing public transport. They are outside the PG
  dispatch path and must not be described as FIPS-migrated.
- HTTPS-mode attachment download may still use external presigned storage URLs.
  FIPS uses Tower's signed content route; Tower's own storage backend remains a
  server-side dependency, covered by isolated MinIO upload/download acceptance.
- Graph, unrelated WApps/install intents, Forgejo/OIDC, public discovery and Nostr
  relay transport are outside this release. Their independent configuration is not
  changed by a Tower PG transport selector.
- The isolated browser frontend reaches its test Tower listener separately; zero
  public egress claims apply to the isolated Autopilot network namespace, not the
  two user browsers or Tower's backend storage traffic.

## Evidence and commands

See `2026-09-09-tower-fips-progress.md` for exact run IDs, source hashes, failed runs,
commits and current validation. From `/Users/mini/code/wm/flightdeck`:

```sh
node scripts/release-test/run.mjs run --https
node scripts/release-test/run.mjs run --fips
node scripts/release-test/run.mjs run --fips --faults
```

The full fault command passed in runs `d7ef0bc0` and `a94d8915`; the fresh trusted TLS baseline `9661e8f7` also passed. See `2026-09-09-tower-fips-validation.md` for final evidence and source hashes.
Use `--retain` only for diagnostics; final acceptance must verify owned cleanup.
Generated identities, TLS private keys, Compose secrets and browser profiles remain
private under ignored test-results. Only reviewed reports, manifests and separate
A/B recordings may be shared privately; do not upload the run directory wholesale.

# Agent capability broker

Autopilot agent sessions use a stable per-owner bot identity without receiving
its private key. The implementation boundary lives under `src/signing/` and is
currently hosted inside the Autopilot control process. Its API and key resolver
are isolated for later daemon extraction, but this release does **not** claim
OS-process separation.

## Trust and identity model

- **Stable agent identity**: the active bot-key record owned by the session's
  authenticated user. Ordinary agent signing, NIP-44, and Blossom operations
  use this identity.
- **Wingman instance identity**: the control-plane identity configured by
  `WINGMAN_PRIV`. Agents receive only its public npub. It is never an implicit
  fallback for agent operations. The separately scoped runner-signing API is
  the exceptional instance-signing path.
- **Human delegation**: browser-mediated Tier 2 signing with an approved grant.
  It is distinct from the agent capability and does not turn the agent into the
  human signer.
- **Wallet authority**: a separate operation family with independent read
  methods, spend methods, per-payment maximum, and cumulative budget. General
  Nostr signing does not grant wallet access.

The broker holds opaque token hashes, not reusable plaintext tokens. Each
capability binds an ID, issue/expiry time, exact live session, session owner,
stable bot npub/pubkey, allowed operations, operation constraints, replay
nonces, rate state, revocation state, and wallet spend accounting. It rejects a
stopped/error session, owner change, bot-key rotation, expired/revoked token,
reused nonce, missing operation, or widened request.

Stable agent private keys are held in the local encrypted vault implemented by
`src/signing/broker-key-vault.ts`. It uses a random AES-256-GCM master key,
`0600` files, authenticated identity binding, atomic writes, and per-operation
plaintext copies that are zeroed after use. The vault is enabled by default for
both native Bun and Docker deployments; Docker's existing persistent `data`
volume preserves it across container restarts. A deployment may mount the
master key at another path with `WINGMAN_BROKER_MASTER_KEY_FILE`.

This is deliberately an accidental-disclosure boundary, not a claim of hostile
same-user isolation. Code running as the Autopilot OS user with broad filesystem
access can ultimately recover an agent's own key. The security gain is that the
key is no longer routinely copied into session environments, argv, MCP config,
PM2 state, logs, or prompts, and ordinary operations are scoped and audited.
the operator's human/Tier 2 key, the Wingman instance/root key, capability-minting
secrets, and wallet secrets remain separate and must never enter the agent vault
or child environment. Deployments needing protection from a malicious local
agent can later move the same vault interface behind an OS or hardware boundary;
that is optional hardening, not required for normal Autopilot operation.

## Operation matrix

| Operation | Default agent scope | Important enforcement |
| --- | --- | --- |
| Public identity | Own stable bot only | Live session, bound owner and bot record |
| NIP-98 | Configured Tower `/api/v4`, explicit local Autopilot API prefixes, and exact brokered restart/status routes | Origin-specific scheme/host/port/path/method targets; POST/PUT/PATCH require an exact body hash |
| Nostr event | Explicit named kind allowlist; the default includes common profile/social/app-release kinds plus Flight Deck PG instruction kind `33358` | Kind, broker-owned timestamp, content/tag byte limits, tag count and optional tag constraints |
| NIP-44 encrypt/decrypt | Stable bot identity; separate operations, not event kinds | Direction, valid peer pubkey, payload byte limits, and decryption errors; no instance fallback |
| Blossom authorization | Configured server origin | Method, SHA-256 object hash, object size and optional exact-hash list |
| Wallet read | No production default | Separate adapter and allowlisted methods required |
| Wallet spend | No production default | Separate operation, method, per-call and cumulative msat budgets |
| Raw key/export/arbitrary Schnorr | Never | No broker operation exists |

The default peer policy currently permits any valid NIP-44 peer because normal
encrypted messaging needs dynamic correspondents. A deployment that knows its
counterpart set should issue a narrower policy. Default payload limits bound
plaintext to 1 MiB and ciphertext to 1.5 MB before cryptographic work. The
signer identity remains strictly fixed even with the wildcard peer set.

The default Nostr event allowlist is the named
`DEFAULT_AGENT_NOSTR_EVENT_KINDS` constant. It preserves the existing profile,
note, contact, legacy encrypted-message, reaction, relay-list, app-data, and
Flight Deck instruction kinds, and adds the explicit Zapstore release set:
software asset `3063`, Blossom authorization `24242`, software release `30063`,
and app metadata `32267`. Kind `24242` is present for publishing clients that
request generic event signing, while broker-native Blossom clients should use
`blossom.authorize`, which independently enforces server origin, method, object
hash, and object size. NIP-44 encryption/decryption likewise remain dedicated
operations with their own constraints; neither Blossom nor NIP-44 widens the
event-kind allowlist. Unknown kinds remain denied.

## Agent use

MCP tools call the broker automatically. Shell workflows use the client without
placing the capability on argv:

```sh
bun clis/wingman-capability.ts identity
bun clis/wingman-capability.ts nip98 --url "$TOWER_URL/api/v4/flightdeck-pg/workspaces" --method GET
bun clis/wingman-capability.ts event --kind 1 --content "status" --tags-json '[]'
bun clis/wingman-capability.ts encrypt --peer <hex-pubkey> --text "message"
bun clis/wingman-capability.ts decrypt --peer <hex-pubkey> --ciphertext <value>
bun clis/wingman-capability.ts blossom-auth --server https://blossom.example --method upload --hash <sha256> --size <bytes>
bun clis/wingman-capability.ts blossom-upload --server https://blossom.example --file ./artifact.png --content-type image/png
bun clis/wingman-capability.ts wallet --method get_balance
```

`WINGMAN_CAPABILITY` is injected into the session environment and inherited by
the MCP subprocess. Its value is deliberately omitted from argv and generated
MCP configuration. Codex uses `env_vars`, Goose uses `env_keys`, and Claude and
OpenCode use their documented environment-reference syntax; only the variable
name/reference is serialized. Never print the value, paste it into
chat/task/docs, put it on a command line, or commit it. If policy denies an
operation, request a narrower capability through the control plane; do not
search for a private key.

The `event` output is standard Nostr JSON and can be piped to `nak verify`.
Direct `nak --sec`, `NOSTR_SECRET_KEY`, and raw-key `nak bunker` workflows are
forbidden for agents. A direct NIP-46 adapter for unmodified NAK commands is
deferred; use the broker client for event, NIP-98, NIP-44, and Blossom work.

For Flight Deck work, use the broker-aware MCP `flightdeck_*` tools. PG chat
creates and edits require two signatures from the same stable bot identity: a
body-bound kind-`33358` instruction event in `message_signature`, followed by
the NIP-98 signature over the exact HTTP payload. The default session policy
allows both operations. NIP-98 alone is intentionally insufficient and must
not be retried as a fallback. The PG CLI
raw `--key` mode is retained only as an explicit operator path until its full
Tower client stack accepts an asynchronous broker signer.

## Lifecycle, audit, and operations

Capabilities expire after at most two hours. The long-lived MCP client refreshes
them after 90 minutes through a same-policy operation that cannot add operations or
broaden constraints. A shell CLI launched from an older, still-live session may
also renew an expired capability and retry once. Expiry continues to deny every
signing and data operation; only the refresh endpoint accepts the expired token,
and it revalidates the exact live session, owner, stable identity, policy, nonce,
rate limit, and revocation state before renewal. Capabilities are revoked by
the process manager when a session stops, errors, or is deleted. Every request
also revalidates live session and bot-key state, so archived/stale session rows
never authorize cryptography. Audit entries contain capability ID, session ID,
bot npub, operation, outcome, reason, and timestamp only. They never contain a
token, key, plaintext, ciphertext, NWC secret, request body, or wallet params.

The broker durably stores active capability verifier state in
`data/capability-broker-state.json` (override with
`WINGMAN_CAPABILITY_STATE_FILE`). The file contains one-way token hashes,
scope/policy, expiry, replay nonces, rate state, and wallet budget state—not the
bearer token or private key—and is atomically replaced with mode `0600`.
Unrevoked verifier records remain after access expiry so a live session can use
the refresh-only recovery path. Stopping, erroring, or deleting the session
revokes and removes its renewal authority. Managed Autopilot restarts stop agent
processes and issue new session capabilities to the resumed or fresh replacements.

The child environment starts from a documented base allowlist. Controlled
runtime injection may add provider, billing, git, public identity, and broker
values, but a final sanitizer removes root Nostr keys, signing secrets, NWC
credentials, and `NOSTR_SECRET_KEY` before direct Bun launch.

After deploying this code, the operator must restart Autopilot from outside the
managed session, then rotate the previously exposed Wingman instance key and
any credentials that may have entered historical agent environments. Rotation
is intentionally not performed by this implementation.

### Existing identity migration

At startup, Autopilot immediately rewraps every legacy
agent identity that the control process can unlock through old Key Teleport
escrow. The local vault is then sufficient for later restarts and Key
Teleport can be removed. If legacy
escrow is unavailable, session creation fails closed with
`broker_key_not_provisioned`; Agent Direct stores that code and the full
operator-facing diagnostic in both the durable turn and Flight Deck dispatch
outcome. The existing authenticated browser `/api/bot-keys/unlock` ceremony
also provisions the vault before retaining any compatibility in-memory key.
No instance-key fallback exists.

For an installation whose current records have only legacy escrow and whose
browser unlock route cannot decrypt them, perform one controlled migration:

1. Restore `KEYTELEPORT_PRIVKEY` to the Autopilot control process only.
2. Start the new build once and confirm the startup migration message for each
   stable identity.
3. Remove `KEYTELEPORT_PRIVKEY` and restart again. Broker signing must continue
   from the vault before the legacy credential is rotated/retired.

Never inject that migration credential into a child session.

For upgrades from a release that still injected `AGENT_NSEC`, provision the
vault **before** restarting or closing the final legacy session. The migration
must consume that agent-owned credential inside a fixed-purpose local process,
validate it against the stored stable bot pubkey, write only the encrypted vault
envelope, and wipe temporary bytes. Never paste the value into argv or logs.
Once the envelope exists, new sessions receive capabilities and the legacy
session should be closed. If neither legacy escrow nor a still-running legacy
session exists, use the authenticated browser unlock route; it now prefers the
user's stable agent record even when `WINGMAN_PRIV` is also configured.

`bun scripts/provision-broker-vault.ts` provides a secretless operator migration
for installations whose historical escrow key is still available under the
retired Key Teleport setting or matches the current instance identity. It never
prints private material and validates the stable agent identity before writing.

## Deliberately deferred

- Optional isolation of the vault behind a separate OS account, service, remote
  signer, or hardware boundary. The current local vault makes no claim against
  a malicious same-user agent recovering its own identity key.
- A direct local NIP-46/bunker adapter for unmodified NAK commands.
- Distribution of a refreshed token back into an already-running parent agent
  environment. This is unnecessary while refresh retains the same opaque bearer:
  long-lived MCP subprocesses renew proactively and standalone shell CLIs renew
  on expiry. No raw-key fallback is permitted.
- Production NWC/wallet adapter wiring. The policy and fake-only budget tests
  exist, but production wallet reads and spends fail closed (`501`) today.
- Dynamic UI/control-plane issuance of peer-, object-, or destination-specific
  policies beyond the server-owned default policy.
- Migrating the operator-oriented Flight Deck PG client stack from synchronous
  local key signing to the asynchronous broker signer.

These omissions do not restore any agent key-export or shared-instance fallback
path. They limit which workflows are available through the broker.

## Local workspace-agent inventory

The 2026-08-03 inventory found 319 raw-key-referencing files under
`/srv/workspace/mycode`: 283 task-specific one-off scripts, four
historical heartbeat scripts, and 32 other historical migration/graph/Flight
Deck/signing helpers after excluding the maintained `lib/yoke.js` boundary.
They are classified as inert evidence in `mycode/RAW_KEY_ARCHIVE.md`, not
approved runtime paths. Maintained guidance and the shared Yoke helper now fail
closed for agent raw-key resolution; the Signal daemon and two reusable legacy
dispatch/repair helpers are retired until they have dedicated broker-aware
authority. A plaintext historical 64-hex fallback was removed. The archived
files were not bulk-rewritten because doing so would alter historical evidence.

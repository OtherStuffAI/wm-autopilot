# Local application signer

Autopilot can expose its existing broker key vault to one explicitly authorized
application over `WINGMAN_SIGNER_SOCKET` (an absolute Unix socket path). Its parent
must be owned by the host UID with mode 0700; socket mode is 0600. Existing socket
paths are refused. Remove a stale socket only after confirming no listener owns it.
An operator restart is required to activate a newly configured listener.

Applications use independent durable grants, never session capabilities. The
existing SystemManage API authorizes `POST /api/admin/signing-policies/applications`
with `{botNpub, expectedPubkey, policy:{methods, kindRules, peers, allowAnyPeer}}`. Only the bot's
owner may register it. Verify the live broker identity immediately beforehand.
The response returns `{grant, credential}` once; write the credential to an
owner-only file without displaying/logging it. Revocation uses
`DELETE /api/admin/signing-policies/applications/:id`. Revocation and bot-key
rotation deny subsequent requests even on an existing connection. Session endings
have no effect; grant hashes and policy survive host restarts. Never register an
inherited manager capability or transfer a private key.

`kindRules` use the existing broker's per-kind content/tag bounds and exact-tag
rules. Every kind is explicit; kind 445 remains Marmot's ephemeral local transport
identity, and kind 27235 is reserved for Autopilot's session-bound HTTP auth. Marmot
needs kind 450 for unpublished account proof, plus the precise account metadata,
relay-list, KeyPackage and authentication kinds needed by the chosen setup.

## Four operations

UTF-8 NDJSON, one persistent connection, strictly one outstanding request; no
batching/pipelining. Request `{id, credential, method, params}`; ID is a nonempty
string of at most 128 characters. Response `{id, result}` or
`{id, error:{code}}`. Authentication occurs on every request.

| Method | Params | Result |
| --- | --- | --- |
| `get_public_key` | `{}` | 64-character lowercase hex public key |
| `sign_event` | `{event:{id,pubkey,created_at,kind,tags,content}}` | Signed Nostr event |
| `nip44_encrypt` | `{peer,text}` | NIP-44 v2 ciphertext |
| `nip44_decrypt` | `{peer,text}` | Plaintext |

Signing preserves timestamp, content and ordered tags exactly. The supplied ID
must equal the canonical event hash and pubkey must equal the grant identity.
NIP-44 peers are explicit grant entries unless the owner explicitly sets
`allowAnyPeer: true`. Marmot needs that setting to decrypt NIP-59 outer wraps from
fresh ephemeral sender keys. This grants only this application's NIP-44 operations;
Marmot still authenticates the inner welcomer, and routing accepts only Pete. It
does not widen session grants or authorize arbitrary inbound conversations. Frames are
bounded to 256 KiB, processing/partial-frame/write deadlines to 15 seconds, and
connections to eight. Encryption plaintext is at most 65535 bytes; decryption
payload at most 100000 bytes. Invalid methods, events and peers fail closed.
Idle persistent connections have no timeout until a frame starts.

Unix ownership identifies an OS user, not an application. Applications sharing
that UID can read each other's credential files and access the host vault. The
credential prevents accidental authority inheritance; it does not isolate hostile
same-UID processes. Host account and filesystem isolation remain the trust boundary.
Signing is local and independent of relays. The separate conversation route confers
no signing authority.

## One-conversation routing

Routing is separate from signing. `WINGMAN_WHITE_NOISE_CONFIG` points to a private
single-link JSON file containing `{connectorSocket, connectorTokenFile?, account,
group, session}`. The account is hex Nostr identity, group is opaque MLS group-id
hex (not the Nostr routing handle), and session is an existing Autopilot managed
Codex native SDK session. Create it under Pete's owner identity with origin
`{type:"white-noise",id:<group>}` and metadata `{agentTransport:"codex-sdk"}`.
The explicit transport pin is required even if the UI defaults to ACP.
The bridge refuses other adapters, owners or
origins. Keep this session dedicated; concurrent unrelated prompts are unsupported.

The operator selects exactly one Pete-authorized conversation after the allowed
invite. Its account/group/session/sender binding is persisted immutably in
`white-noise-conversation.db`; a changed configuration fails clearly. Only Pete's
authenticated account messages in that group are admitted. Local queue state,
input fingerprints, completed output and pending final sends survive restart.
At most 1024 inputs are retained, matching the connector's bounded idempotency
receipt window; reaching that limit requires deliberate operator maintenance.

Codex submission is a durable intent, not completion. The route requires a native
successful `turn.completed` and returns only the last completed assistant text.
For an interrupted accepted input it reads the exact correlated native transcript
and requires successful `task_complete`. If none exists, it reports
`accepted_input_requires_completion_recovery` and never automatically resubmits.
This deliberately exposes uncertain dispatch instead of duplicating work. A lost
completed-output DB write can recover from the native transcript. Pending delivery
uses the same keyed connector `send_final`, whose app admission journal must be
present (use the matching Marmot change). An empty/unconfirmed final-send receipt
never marks delivery complete.

Activation requires the operator's approved Autopilot restart, confirmed phone
relays, the application credential, the external account's allowlist bootstrap,
one accepted invite, and the dedicated session/config. This source change does not
activate any relay, create a live grant, restart services or prove a phone round trip.

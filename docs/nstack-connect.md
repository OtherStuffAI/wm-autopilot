# Connect Autopilot to NStack

Workspaces → **Connect to NStack** asks Nostr Browser to disclose saved connections. Select one or more workspaces, review them, then connect. Results distinguish monitoring, saved connections needing attention, preserved operator state, and failure. Retry targets only failed connections using the complete NStack/workspace identity. Connecting does not create agents or change workspace membership.

The implemented NBrowser API is `window.NStack` version 1 with `requestDiscovery({workspaces:true})`, `listNStacks()`, `listWorkspaces({stackId})`, and `getConnection({stackId,workspaceId})`. Its document-start stub exposes `NStackReady`/`ready`, and installation emits `nstackready`. The installed provider rejects `requestCapabilities`; older capability-handle documentation is not the connection contract. Discovery change notifications invalidate the current selection. A notification caused by the consent request itself is handled before subscribing to later changes.

Autopilot accepts only explicit selected public locators. It reads the existing authenticated Tower PG workspace descriptor with locally held agent identities, checks Tower, workspace service, workspace owner, workspace ID, and app identity, then calls existing AgentConnect v6 onboarding. The canonical PG descriptor resolves Ambulando/Flight Deck once, regardless of display name. It does not guess app identities from names or enumerate a second namespace.

A reverse proxy can advertise HTTP for the exact verified HTTPS host at default ports. The connector retains the verified HTTPS address; host, port, path, query, fragment, credential and HTTPS-to-HTTP connection changes fail. A matching existing backend retains its selected transport; discovery does not replace its approved transport or introduce a network fallback.

Choose the bot profile that serves the selected workspaces. Only that bot's descriptor access is verified, and it connects with its own strict agent inbox (see `strict-agent-inbox.md`). Without a choice, only bots that already serve a workspace (their own subscription, or a shared one Tower verifiably registered them in) are re-verified; no other local bot is probed and nothing new is created. Local agents still need their own Tower membership and signing custody, and per-agent failures are shown. Existing subscriptions keep their current mode. The existing runtime controls event audiences, Agent Direct and pipeline dispatch, transport recovery, cursor recovery and authorization. There is no new authority or subscription protocol.

Repeat/concurrent setup is serialized and reuses canonical identities. A paused, revoked or locally disconnected subscription is preserved; use its existing connection controls to resume or disconnect. A temporary fault uses existing runtime recovery. A result marked monitoring describes workspace monitoring, not a running agent.

Browser state uses the existing Workspaces Dexie database and Alpine live queries. Only whitelisted public metadata is cached. Provider handles, signing keys, signatures and credentials are not cached. Cancel stops the local flow and ignores late responses; setup already accepted by the server may finish, so inspect workspace health afterward. Changing browser identity invalidates discovery; it does not revoke separately authorized persistent Autopilot connections.

Source activation requires an operator-controlled restart of the existing Bun Autopilot after review. Reload the Workspaces page afterward and verify real NBrowser consent, local agent membership, event catch-up, both Agent Direct and pipeline targeting, and recovery on the intended NStack. Isolated browser fixtures test the real UI/modules with synthetic provider/network callbacks; they do not establish live NStack acceptance.

## Ambulando HTTPS agent discovery

An nStack may explicitly advertise this installation's public HTTPS origin via
Tower's `NSTACK_AUTOPILOT_PUBLIC_ORIGIN`. Authenticated owner control-plane health,
agent discovery and agent read views remain available when the FIPS listener is
unavailable. Owner/delegation scope, agent resource filters and instruction
visibility checks are unchanged. FIPS manifests and signed FIPS connection
packages still require their approved listening endpoint; choosing FIPS never
falls back to HTTPS. Activating the owner-read change requires an approved
Autopilot restart; no restart is implied by a source build or client update.

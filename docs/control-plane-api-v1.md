# Autopilot control-plane API v1

Autopilot exposes a public signed connection package and narrowly scoped NIP-98 reads compatible with Flight Deck build 2050. Contract types and generic public fixtures live in `src/control-plane/contracts.ts` and `src/control-plane/fixtures.ts`.

## Connect package and owner selection

Request `GET /api/control-plane/v1/connect-package?owner_npub=<owner-npub>`. Owner selection is required because Flight Deck calls the exact signed paths and cannot infer which owner space should authorize discovery. Autopilot does not substitute the installation signer, an operator key, or another raw-key fallback for this owner.

The response envelope is `{ manifest, signature }`. A representative wire shape is:

```json
{
  "manifest": {
    "kind": "wingman_autopilot_connect",
    "version": 1,
    "generated_at": "2026-01-01T00:00:00.000Z",
    "installation": { "id": "autopilot_<stable-id>", "npub": "npub1..." },
    "endpoints": { "fips": "http://npub1....fips:3601", "https": "https://autopilot.example" },
    "api": {
      "version": 1,
      "capabilities": ["health", "agents.read"],
      "health_path": "/api/owners/npub1owner.../control-plane/v1/health",
      "agents_path": "/api/owners/npub1owner.../control-plane/v1/agents"
    }
  },
  "signature": { "kind": 27236, "content": "<canonical manifest JSON>" }
}
```

Object keys in `signature.content` are recursively sorted; array order is retained. The event signer, `manifest.installation.npub`, and the npub in the exact FIPS origin must match. Package generation fails with `503` if FIPS is unavailable or exposes a different service identity. HTTPS is descriptive metadata only and is never a fallback.

Consumers must reject unknown versions, invalid or tampered signatures, expired generation times, identity mismatches, unsafe paths, and credential-like fields or secret values. The package contains no private key, bearer token, bunker URI, or reusable signing secret.

## Authenticated reads

The package advertises these owner-specific paths directly:

- `GET /api/owners/:ownerNpub/control-plane/v1/health`
- `GET /api/owners/:ownerNpub/control-plane/v1/agents`

Health returns:

```json
{ "ok": true, "installation_id": "autopilot_<stable-id>", "installation_npub": "npub1...", "api_version": 1 }
```

Discovery returns:

```json
{
  "installation_id": "autopilot_<stable-id>",
  "agents": [{ "agent_id": "agent-example", "bot_npub": "npub1...", "name": "Example Agent", "description": "Public description", "can_instruct": true }]
}
```

Every protected request passes through the normal API router and shared NIP-98 verifier. Authorization binds the exact URL including query, method, and body hash when a body exists, and rejects replayed events. The owner may read the agents it manages. A delegated signer requires an active exact-owner `control-plane:read` delegation, is restricted by `resourceFilters.agentIds`, and must be an instructor for every returned agent. Workspace membership is not authority. Unauthorized agent lookups return `404`.

All package, health, discovery, and overview responses use `cache-control: no-store`. Stable installation and agent IDs are intended for downstream Tower connection records.

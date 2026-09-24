# Autopilot control-plane API v1

Autopilot exposes a public, signed connection package and narrowly scoped NIP-98 reads. The contract types and generic fixtures live in `src/control-plane/contracts.ts` and `src/control-plane/fixtures.ts`.

## Connect package

`GET /api/control-plane/v1/connect-package` returns `{ payload, signedEvent }`. `signedEvent.content` is the canonical JSON serialization of the complete payload: object keys are sorted lexicographically, arrays retain their order, and undefined fields are omitted. The event is kind `30078`, signed by `payload.installationNpub`, and binds the stable `installationId` in its `d` tag.

Version 1 packages contain only `kind`, `version`, `installationId`, `installationNpub`, the exact `fipsEndpoint`, optional `httpsEndpoint`, `generatedAt`, `apiVersion`, and advertised `readCapabilities`. Consumers must reject unknown versions, invalid/tampered signatures, expired generation times, signer/installation mismatches, and unsupported capabilities. No credential is conveyed by the package.

Package generation returns `503 fips-transport-unavailable` unless the advertised FIPS endpoint is listening. The HTTPS endpoint is metadata only and is never substituted for a failed FIPS connection.

## Authenticated reads

All reads below require a NIP-98 signature over the exact URL (including query), `GET` method, and no payload tag because these requests have no body:

- `GET /api/owners/:ownerNpub/control-plane/v1/manifest`
- `GET /api/owners/:ownerNpub/control-plane/v1/health`
- `GET /api/owners/:ownerNpub/control-plane/v1/agents`
- `GET /api/owners/:ownerNpub/control-plane/v1/agents/:agentId`

The owner may read agents it manages. A delegated signer requires an active exact-owner `control-plane:read` delegation, must be an instructor for each returned agent, and is restricted by `resourceFilters.agentIds` when present. Workspace membership is not authority. Agent lookups outside those constraints return `404` so discovery does not reveal unauthorized records.

Every response uses `cache-control: no-store`. Stable `installationId` and `agentId` values are intended for Tower connection and installed-agent records; internal Settings UI records are not part of this API.

# Tinfoil model provider

Autopilot can run Pi, OpenCode and Goose locally while sending their inference to Tinfoil through its attestation-verifying proxy. Runner, provider and model are independent launch choices. The initial tested model configuration is `kimi-k3-1-pro`; a configured allowlist controls which exact model IDs can be used. Availability and billing remain subject to the Tinfoil account and catalog.

## Setup

1. Install the pinned proxy for the Autopilot service user:

   ```sh
   bun scripts/install-tinfoil-proxy.ts
   ```

   This installs v0.2.9 into `~/.local/bin`, verifying its SHA-256 against the official GitHub release asset digest. The service checks `TINFOIL_PROXY_CLI`, then its executable PATH, then `~/.local/bin/tinfoil-proxy`. The proxy must support the verified `--handshake` startup protocol. Runtime startup never downloads executable code.

2. In **Secrets**, select the credential's existing workspace. Add or edit an ordinary saved secret using the existing encrypted custody UI. Keep raw return disabled. Grant only the bot identities and selected agent consumers that should use the provider; both grants must allow each identity.
3. In **Settings → Model choices → Model providers**, select the same workspace. In the **Tinfoil model provider** section, select the saved credential, enter exact allowed model IDs, and save. The connection stores only the reference, enabled state, allowlist and revision. Test with one of the allowed bot identities. Testing makes a small billed inference request and checks a real function call; it returns deterministic connection/model/tool status, never the upstream response body or key.
4. In the session launch dialog, choose Pi, OpenCode or Goose, then **Tinfoil**, its workspace and a configured model. Choose a bot profile already authorized by the secret policy. An unavailable identity, workspace, secret or model fails explicitly; there is no provider fallback.

Settings → Model choices contains this connection panel; Secrets manages only credentials and permissions; the existing OpenRouter configuration is preserved. Browser metadata is materialized through Dexie before rendering; a Settings Alpine subscription drives updates. No provider key is returned to the browser.

## Broker configuration and testing

An agent can configure a reference only within its live capability-bound owner/workspace and existing secret identity/consumer grants:

```sh
bun clis/model-provider.ts status
bun clis/model-provider.ts configure <saved-secret-reference> kimi-k3-1-pro 0
bun clis/model-provider.ts test
```

The last configure argument is the expected connection revision (`0` for a new connection). Updates require the current revision. The dedicated broker route is `POST /api/mcp/capabilities/model-provider`. It accepts `status`, `configure`, or `test`; it does not accept identity, owner, arbitrary URL, credential value or workspace overrides. An absent route requires server activation. Ordinary local sessions use the same server-owned profile and bot binding as capability issuance; an identity, profile or workspace change invalidates use. The ordinary secret management API remains human-only.

A secret in `local` is not automatically available in a Flight Deck workspace. Configure and launch in the credential's actual workspace with a matching authorized identity. Resolve mismatches through the owner UI; do not broaden policy or export the key to make a test pass.

API launch payloads may specify:

```json
{
  "agent": "pi",
  "model": "kimi-k3-1-pro",
  "metadata": {
    "modelProvider": "tinfoil",
    "modelProviderWorkspaceId": "local",
    "agentProfileId": "<authorized-profile-id>"
  }
}
```

`model: "tinfoil/kimi-k3-1-pro"` also selects Tinfoil for existing model-reference callers. Flight Deck session launches bind to their actual Flight Deck workspace and cannot select a different provider workspace.

## Runtime boundary

The service launches and owns the proxy on a random loopback port and waits for its verified ready handshake. A separate random loopback gateway authenticates each runner with an opaque session credential. It supplies the saved key internally using `SecretStore.withServiceCredential`, without requiring raw export permission. The proxy verifies the remote enclave; ordinary direct HTTPS is not presented as attested.

The gateway permits only chat completions and authenticated discovery of the single session model. It does not forward caller-supplied credentials, arbitrary headers, paths, redirects or destinations. Streaming tool deltas and tool results pass through unchanged. Upstream errors are reduced to bounded errors without response bodies or headers. Client cancellation aborts inference. Policy is checked at request ingress and each stream read, with a 500 ms revocation check for idle streams.

The grant binds the live session, owner, stable bot identity, profile, workspace, model, provider configuration revision and secret revision. Stop, revocation, policy/credential rotation or provider edits deny subsequent requests and terminate active streams. Requests already delivered to Tinfoil cannot be recalled. Session tokens expire after 12 hours; launch a replacement session to renew them. They are transient runtime credentials, not the saved API key.

Pi uses a private per-session model file containing an environment-variable reference. OpenCode's provider config also references an environment variable. Goose receives its OpenAI-compatible endpoint and the scoped token through its process environment; Tinfoil sessions disable keyring lookup so no unrelated saved provider credentials are requested. Runners and shell tools still execute under the same OS user as Autopilot. This is a service authorization boundary, **not OS process isolation**.

## Restart and acceptance

A controlled restart with session replacement creates a fresh Tinfoil runner, renews its grant and copies the existing transcript. It retains the exact provider, workspace, profile and model. Preserve-only process rehydration cannot reuse an ephemeral gateway credential and explicitly reports these sessions as needing replacement. Old transcripts remain stored. Native conversation state is fresh in the replacement; prior display transcript is not automatically injected into model context.

After an authorized operator activates the source, verify:

- `status`, exact-reference `configure`, then `test` from an allowed session in the correct workspace;
- a streamed response and a real fixture-file read through each installed runner;
- denied launch/request from an ungranted identity and denied model outside the allowlist;
- revocation on a disposable test credential, leaving the user's saved credential intact;
- one existing provider launch still works.

Local checks include `bun test ./src/model-providers/ ./src/secrets/secret-runtime.test.ts ./src/server/static-routes.test.ts`, `bun run typecheck`, and the optional Playwright `scripts/tinfoil.browser.test.ts`. Browser tests require `PLAYWRIGHT_MODULE` and optionally `BROWSER_EXECUTABLE`. Autopilot runs Bun source and serves ES modules directly; build validation does not activate the running server or create a numbered app release.

Official references: [introduction](https://docs.tinfoil.sh/introduction), [proxy CLI](https://docs.tinfoil.sh/local-proxy/cli), [coding agents](https://docs.tinfoil.sh/tutorials/coding-agents). Installed-runner compatibility must be checked when upgrading; upstream schemas and model availability can change.

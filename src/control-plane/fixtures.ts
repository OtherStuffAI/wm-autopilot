import type {
  AgentDiscoveryV1,
  AutopilotConnectManifestV1,
  InstallationHealthV1,
} from "./contracts";

/** Generic public-only response fixtures for Flight Deck compatibility tests. */
export const controlPlaneV1Fixtures = {
  manifest: {
    kind: "wingman_autopilot_connect",
    version: 1,
    generated_at: "2026-01-01T00:00:00.000Z",
    installation: {
      id: "autopilot_0123456789abcdef0123456789abcdef",
      npub: `npub1${"q".repeat(58)}`,
    },
    endpoints: {
      fips: `http://npub1${"q".repeat(58)}.fips:3601`,
      https: "https://autopilot.example",
    },
    api: {
      version: 1,
      capabilities: ["health", "agents.read"],
      health_path: `/api/owners/npub1${"p".repeat(58)}/control-plane/v1/health`,
      agents_path: `/api/owners/npub1${"p".repeat(58)}/control-plane/v1/agents`,
    },
  } satisfies AutopilotConnectManifestV1,
  health: {
    ok: true,
    installation_id: "autopilot_0123456789abcdef0123456789abcdef",
    installation_npub: `npub1${"q".repeat(58)}`,
    api_version: 1,
  } satisfies InstallationHealthV1,
  discovery: {
    installation_id: "autopilot_0123456789abcdef0123456789abcdef",
    agents: [{
      agent_id: "agent-example",
      bot_npub: `npub1${"x".repeat(58)}`,
      name: "Example Agent",
      description: "Product-neutral fixture",
      can_instruct: true,
    }],
  } satisfies AgentDiscoveryV1,
} as const;

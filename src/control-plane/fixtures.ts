import type {
  AgentDiscoveryV1,
  AgentOverviewV1,
  InstallationHealthV1,
  InstallationManifestV1,
} from "./contracts";

/** Generic public-only fixtures for Tower and Flight Deck contract tests. */
export const controlPlaneV1Fixtures = {
  manifest: {
    apiVersion: "v1",
    installationId: "autopilot_0123456789abcdef0123456789abcdef",
    installationNpub: `npub1${"q".repeat(58)}`,
    fipsEndpoint: `http://npub1${"p".repeat(58)}.fips:3601/`,
    httpsEndpoint: "https://autopilot.example/",
    readCapabilities: [
      "installation.manifest.read",
      "installation.health.read",
      "agents.discover.read",
      "agents.overview.read",
    ],
  } satisfies InstallationManifestV1,
  health: {
    apiVersion: "v1",
    installationId: "autopilot_0123456789abcdef0123456789abcdef",
    status: "healthy",
    fips: { status: "listening", endpoint: `http://npub1${"p".repeat(58)}.fips:3601/`, error: null },
    checkedAt: "2026-01-01T00:00:00.000Z",
  } satisfies InstallationHealthV1,
  agent: {
    agentId: "agent-example",
    botNpub: `npub1${"x".repeat(58)}`,
    displayName: "Example Agent",
    picture: null,
    capabilities: ["chat_intercept"],
    canInstruct: true,
  } satisfies AgentDiscoveryV1,
  overview: {
    agentId: "agent-example",
    botNpub: `npub1${"x".repeat(58)}`,
    displayName: "Example Agent",
    picture: null,
    capabilities: ["chat_intercept"],
    canInstruct: true,
    about: "Generic fixture agent",
    nip05: null,
    enabled: true,
    archived: false,
  } satisfies AgentOverviewV1,
} as const;

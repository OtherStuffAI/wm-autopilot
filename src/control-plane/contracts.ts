export interface InstallationManifestV1 {
  apiVersion: "v1";
  installationId: string;
  installationNpub: string;
  fipsEndpoint: string;
  httpsEndpoint: string | null;
  readCapabilities: string[];
}

export interface InstallationHealthV1 {
  apiVersion: "v1";
  installationId: string;
  status: "healthy" | "unavailable";
  fips: { status: string; endpoint: string | null; error: string | null };
  checkedAt: string;
}

export interface AgentDiscoveryV1 {
  agentId: string;
  botNpub: string;
  displayName: string;
  picture: string | null;
  capabilities: string[];
  canInstruct: boolean;
}

export interface AgentOverviewV1 extends AgentDiscoveryV1 {
  about: string | null;
  nip05: string | null;
  enabled: boolean;
  archived: boolean;
}

import type { SessionCapabilityPolicy } from "./capability-broker";

export type AgentSigningMode = "none" | "standard-agent" | "full-nostr" | "full-agent";

export const DEFAULT_AGENT_SIGNING_MODE: AgentSigningMode = "standard-agent";

export const AGENT_SIGNING_MODE_PRESETS = Object.freeze([
  {
    id: "none",
    name: "No signing",
    trust: "Locked down",
    description: "The agent can receive a broker capability, but cannot sign events or HTTP authentication requests.",
  },
  {
    id: "standard-agent",
    name: "Standard agent signing",
    trust: "Default",
    description: "The agent can sign normal Nostr events and session-bound Wingman, Tower, and Flight Deck requests.",
  },
  {
    id: "full-nostr",
    name: "Full Nostr signing",
    trust: "Advanced",
    description: "The agent can sign arbitrary Nostr events as itself while NIP-98 stays bound to the active session policy.",
  },
  {
    id: "full-agent",
    name: "Full agent signing",
    trust: "High-trust development",
    description: "The agent can sign arbitrary Nostr events and arbitrary NIP-98 requests as itself.",
  },
] satisfies Array<{ id: AgentSigningMode; name: string; trust: string; description: string }>);

export const DEFAULT_AGENT_NOSTR_EVENT_KINDS = Object.freeze([
  0, 1, 3, 4, 7,
  3_063,
  10_002,
  24_242,
  30_063,
  30_078,
  32_267,
  33_358,
]);

const DEFAULT_NIP44_MAX_PLAINTEXT_BYTES = 1_048_576;
const DEFAULT_NIP44_MAX_CIPHERTEXT_BYTES = 1_500_000;

function uniqueOrigins(urls: string[]): string[] {
  return [...new Set(urls.map((url) => new URL(url).origin))];
}

function encodedWorkspacePrefix(workspaceId?: string | null): string | null {
  const trimmed = workspaceId?.trim();
  return trimmed ? `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(trimmed)}` : null;
}

export function normalizeAgentSigningMode(value?: string | null): AgentSigningMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "none" || normalized === "no-signing") return "none";
  if (normalized === "standard-agent" || normalized === "standard" || normalized === "agent") return "standard-agent";
  if (normalized === "full-nostr" || normalized === "nostr") return "full-nostr";
  if (normalized === "full-agent" || normalized === "development" || normalized === "dev") return "full-agent";
  if (!normalized) return DEFAULT_AGENT_SIGNING_MODE;
  throw new Error(`Unknown agent signing mode: ${value}`);
}

export function buildDefaultAgentCapabilityPolicy(input: {
  towerUrl: string;
  towerUrls?: string[];
  autopilotUrl: string;
  ownerNpub?: string;
  workspaceId?: string | null;
  blossomServers?: string[];
  mode?: AgentSigningMode | string | null;
}): SessionCapabilityPolicy {
  const mode = normalizeAgentSigningMode(input.mode);
  const ownerPath = input.ownerNpub ? `/api/owners/${encodeURIComponent(input.ownerNpub)}` : null;
  const towerOrigins = uniqueOrigins([input.towerUrl, ...(input.towerUrls ?? [])]);
  const autopilotOrigin = new URL(input.autopilotUrl).origin;
  const workspacePrefix = encodedWorkspacePrefix(input.workspaceId);
  const mutatingMethods = ["POST", "PUT", "PATCH"];

  const base: SessionCapabilityPolicy = {
    mode,
    operations: ["identity.read", "capability.refresh"],
    maxCallsPerMinute: 120,
  };
  if (mode === "none") return base;

  return {
    ...base,
    operations: [
      ...base.operations,
      "nip98.sign",
      "nostr.sign",
      "nip44.encrypt",
      "nip44.decrypt",
      "blossom.authorize",
    ],
    nip98: {
      origins: [...towerOrigins, autopilotOrigin],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      pathPrefixes: [],
      ...(mode === "full-agent" ? { allowAnyTarget: true } : {}),
      targets: [
        ...towerOrigins.flatMap((towerOrigin) => workspacePrefix ? [
          {
            origin: towerOrigin,
            methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
            pathPrefixes: [workspacePrefix],
            requireBodyHashMethods: mutatingMethods,
          },
          {
            origin: towerOrigin,
            methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
            pathPrefixes: ["/api/v4/storage"],
            requireBodyHashMethods: mutatingMethods,
          },
        ] : []),
        {
          origin: autopilotOrigin,
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          pathPrefixes: [
            "/api/apps",
            "/api/archive",
            "/api/delegate-sessions",
            "/api/nightwatch",
            "/api/pipelines",
            "/api/remote-instruct",
            "/api/scheduler",
            "/api/sessions",
            "/api/wapps",
            ...(ownerPath ? [ownerPath] : []),
          ],
          exactPaths: [
            { path: "/api/admin/wapps/legacy-custody-migration", methods: ["POST"], requireBodyHash: true },
            { path: "/api/system/restart", methods: ["POST"], requireBodyHash: false },
            { path: "/api/system/restart-and-resume", methods: ["POST"], requireBodyHash: false },
            { path: "/api/system/restart/status", methods: ["GET"] },
          ],
          requireBodyHashMethods: mutatingMethods,
        },
      ],
    },
    nostr: {
      kinds: [...DEFAULT_AGENT_NOSTR_EVENT_KINDS],
      maxContentBytes: mode === "full-nostr" || mode === "full-agent" ? 4_194_304 : 1_048_576,
      maxTags: mode === "full-nostr" || mode === "full-agent" ? 1_024 : 256,
      maxTagBytes: mode === "full-nostr" || mode === "full-agent" ? 262_144 : 65_536,
      ...(mode === "full-nostr" || mode === "full-agent" ? { allowAnyKind: true } : {}),
      ...(mode === "full-agent" ? { allowNip98Kind: true } : {}),
    },
    nip44: {
      encryptPeers: ["*"],
      decryptPeers: ["*"],
      maxPlaintextBytes: DEFAULT_NIP44_MAX_PLAINTEXT_BYTES,
      maxCiphertextBytes: DEFAULT_NIP44_MAX_CIPHERTEXT_BYTES,
    },
    blossom: {
      servers: (input.blossomServers ?? towerOrigins).map((server) => new URL(server).origin),
      methods: ["upload", "delete", "list"],
      maxObjectBytes: 25 * 1_024 * 1_024,
    },
  };
}

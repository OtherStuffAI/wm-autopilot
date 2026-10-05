export type DirectChatHandlerMode = "session" | "pipeline_router" | "pipeline_enrichment";

export interface DirectChatEnrichmentConfig {
  pipeline: string;
  version: string | number;
  memory: null | {
    ownerNpub: string;
    source?: string;
    sourceAppNpub?: string;
    groupId?: string;
    label?: string;
    actorNpub?: string;
    visibility?: string;
  };
  recommendPipelines: boolean;
  toolNames: string[];
  threshold: number;
  maxContextChars: number;
  timeoutMs: number;
}

export function directChatHandlerMode(value: unknown, previous: DirectChatHandlerMode = "session"): DirectChatHandlerMode {
  if (value === undefined) return previous;
  if (value === "session" || value === "pipeline_router" || value === "pipeline_enrichment") return value;
  throw new Error("directChat.handlerMode must be session, pipeline_router or pipeline_enrichment.");
}

export function parseEnrichmentConfigs(value: unknown): Record<string, DirectChatEnrichmentConfig> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("enrichmentByWorkspace must be an object.");
  return Object.fromEntries(Object.entries(value).map(([workspaceId, raw]) => {
    if (!workspaceId.trim() || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Enrichment requires a workspace and configuration.");
    const config = raw as Record<string, unknown>;
    const memory = config.memory;
    if (memory != null && (typeof memory !== "object" || Array.isArray(memory) || typeof (memory as Record<string, unknown>).ownerNpub !== "string" || !(memory as Record<string, unknown>).ownerNpub)) {
      throw new Error("Memory requires an explicit graph owner npub, or None.");
    }
    const bounded = (key: string, fallback: number, min: number, max: number) => {
      const n = config[key] === undefined ? fallback : Number(config[key]);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be between ${min} and ${max}.`);
      return n;
    };
    if (typeof config.pipeline !== "string" || !config.pipeline.trim() || !["string", "number"].includes(typeof config.version)) throw new Error("Select a versioned enrichment pipeline.");
    if (config.toolNames !== undefined && (!Array.isArray(config.toolNames) || config.toolNames.some(v => typeof v !== "string"))) throw new Error("toolNames must be a list of tool names.");
    const allowedMemory = memory ? Object.fromEntries(Object.entries(memory).filter(([k]) => ["ownerNpub", "source", "sourceAppNpub", "groupId", "label", "actorNpub", "visibility"].includes(k)).map(([k, v]) => {
      if (typeof v !== "string") throw new Error(`Memory ${k} must be text.`);
      return [k, v.trim()];
    })) as DirectChatEnrichmentConfig["memory"] : null;
    return [workspaceId, { pipeline: config.pipeline.trim(), version: config.version as string | number,
      memory: allowedMemory, recommendPipelines: config.recommendPipelines !== false,
      toolNames: [...new Set((config.toolNames ?? []) as string[])], threshold: bounded("threshold", .9, 0, 1),
      maxContextChars: Math.floor(bounded("maxContextChars", 6000, 256, 24000)),
      timeoutMs: Math.floor(bounded("timeoutMs", 12000, 100, 60000)) }];
  }));
}

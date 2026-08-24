import {
  parseAcpPermissionPolicy,
  type AcpPermissionPolicy,
} from "../agents/acp-permission-policy";

export interface SessionMetadata {
  AGENT: boolean;
  billingMode: "subscription" | "credits";
  /** Transport selected at session creation/rehydration; never changed in place. */
  agentTransport?: "agentapi" | "codex-acp" | "codex-sdk" | "goose-acp" | "maple-acp" | "opencode-sdk" | "pi-acp" | "pi-native";
  /** Effective ACP runtime permission policy, fixed for the lifetime of this session. */
  acpPermissionPolicy?: AcpPermissionPolicy;
  nativeAgentSession?: NativeAgentSessionMetadata;
  resumedFromWingmanSessionId?: string;
  branchedFromWingmanSessionId?: string;
  branchConversationMode?: "full" | "recent";
  branchConversationMessageCount?: number;
  role?: string;
  project?: string;
  goal?: string;
  nextAction?: SessionMetadataNextAction;
  nextActionPayload?: string;
  nextActionTemplate?: string;
  bindingType?: SessionBindingType;
  bindingId?: string;
  flowId?: string;
  flowRunId?: string;
  retryAttempt?: number;
  taskIds?: string[];
  tags?: string[];
  routerRunId?: string;
  autoStop?: boolean;
  routedBy?: string;
  agentChatAgentId?: string;
  agentChatBotNpub?: string;
  sessionClass?: "flightdeck_chat";
  flightdeckTowerServiceNpub?: string;
  flightdeckWorkspaceId?: string;
  flightdeckScopeId?: string;
  flightdeckChannelId?: string;
  flightdeckThreadId?: string;
  flightdeckAgentNpub?: string;
  flightdeckRoutingKey?: string;
  sessionGeneration?: number;
  ownerNpub?: string;
  createdByNpub?: string;
  lastManagedByNpub?: string;
  chargeToNpub?: string;
  delegateRelationshipId?: string;
  wappActivityInstallationId?: string;
  pinnedFiles?: string[];
  speechGenerateAudio?: boolean;
  speechAlwaysRead?: boolean;
}

export interface NativeAgentSessionMetadata {
  agent: string;
  sessionId: string;
  workingDirectory: string;
  capturedAt: string;
  source: "preallocated" | "adapter" | "agentapi" | "manual";
}

export type SessionMetadataInput =
  | (Partial<Omit<SessionMetadata, "tags">> & { tags?: unknown })
  | null
  | undefined;

export const SESSION_METADATA_NEXT_ACTIONS = [
  "none",
  "reflect",
  "stop",
  "restart",
] as const;

export type SessionMetadataNextAction =
  (typeof SESSION_METADATA_NEXT_ACTIONS)[number];

export const SESSION_METADATA_BINDING_TYPES = [
  "thread",
  "task",
  "document",
  "flow_run",
] as const;

export type SessionBindingType =
  (typeof SESSION_METADATA_BINDING_TYPES)[number];

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export const DEFAULT_SESSION_METADATA: SessionMetadata = Object.freeze({
  AGENT: false,
  billingMode: "subscription",
});

const AGENT_TRANSPORTS = new Set([
  "agentapi",
  "codex-acp",
  "codex-sdk",
  "goose-acp",
  "maple-acp",
  "opencode-sdk",
  "pi-acp",
  "pi-native",
]);

export const normaliseSessionTags = (value: unknown): string[] | undefined => {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : [];
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") continue;
    const tag = rawValue
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 16) break;
  }

  return tags.length > 0 ? tags : undefined;
};

export const normaliseSessionMetadata = (
  metadata: SessionMetadataInput,
): SessionMetadata => {
  const nativeAgentSession = normaliseNativeAgentSession(metadata?.nativeAgentSession);
  const resumedFromWingmanSessionId =
    typeof metadata?.resumedFromWingmanSessionId === "string"
      ? metadata.resumedFromWingmanSessionId.trim()
      : "";
  const branchedFromWingmanSessionId =
    typeof metadata?.branchedFromWingmanSessionId === "string"
      ? metadata.branchedFromWingmanSessionId.trim()
      : "";
  const branchConversationMode =
    metadata?.branchConversationMode === "recent" || metadata?.branchConversationMode === "full"
      ? metadata.branchConversationMode
      : undefined;
  const branchConversationMessageCount =
    typeof metadata?.branchConversationMessageCount === "number" &&
    Number.isFinite(metadata.branchConversationMessageCount) &&
    metadata.branchConversationMessageCount > 0
      ? Math.floor(metadata.branchConversationMessageCount)
      : undefined;
  const role = typeof metadata?.role === "string" ? metadata.role.trim() : "";
  const project = typeof metadata?.project === "string" ? metadata.project.trim() : "";
  const goal = typeof metadata?.goal === "string" ? metadata.goal.trim() : "";
  const nextActionValue = typeof metadata?.nextAction === "string" ? metadata.nextAction.trim().toLowerCase() : "";
  const nextAction = SESSION_METADATA_NEXT_ACTIONS.includes(
    nextActionValue as SessionMetadataNextAction,
  )
    ? nextActionValue as SessionMetadataNextAction
    : undefined;
  const nextActionPayload =
    typeof metadata?.nextActionPayload === "string" ? metadata.nextActionPayload.trim() : "";
  const nextActionTemplate =
    typeof metadata?.nextActionTemplate === "string" ? metadata.nextActionTemplate.trim() : "";
  const sessionGeneration = Number(metadata?.sessionGeneration);
  const retryAttempt = Number(metadata?.retryAttempt);
  const bindingTypeValue =
    typeof metadata?.bindingType === "string" ? metadata.bindingType.trim().toLowerCase() : "";
  const bindingType = SESSION_METADATA_BINDING_TYPES.includes(
    bindingTypeValue as SessionBindingType,
  )
    ? bindingTypeValue as SessionBindingType
    : undefined;
  const bindingId = typeof metadata?.bindingId === "string" ? metadata.bindingId.trim() : "";
  const flowId = typeof metadata?.flowId === "string" ? metadata.flowId.trim() : "";
  const flowRunId = typeof metadata?.flowRunId === "string" ? metadata.flowRunId.trim() : "";
  const routerRunId = typeof metadata?.routerRunId === "string" ? metadata.routerRunId.trim() : "";
  const routedBy = typeof metadata?.routedBy === "string" ? metadata.routedBy.trim() : "";
  const agentChatAgentId = typeof metadata?.agentChatAgentId === "string" ? metadata.agentChatAgentId.trim() : "";
  const agentChatBotNpub = typeof metadata?.agentChatBotNpub === "string" ? metadata.agentChatBotNpub.trim() : "";
  const ownerNpub = typeof metadata?.ownerNpub === "string" ? metadata.ownerNpub.trim() : "";
  const createdByNpub = typeof metadata?.createdByNpub === "string" ? metadata.createdByNpub.trim() : "";
  const lastManagedByNpub = typeof metadata?.lastManagedByNpub === "string" ? metadata.lastManagedByNpub.trim() : "";
  const chargeToNpub = typeof metadata?.chargeToNpub === "string" ? metadata.chargeToNpub.trim() : "";
  const delegateRelationshipId =
    typeof metadata?.delegateRelationshipId === "string" ? metadata.delegateRelationshipId.trim() : "";
  const wappActivityInstallationId = cleanString(metadata?.wappActivityInstallationId);
  const pinnedFiles = Array.isArray(metadata?.pinnedFiles)
    ? metadata.pinnedFiles
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
        .slice(0, 20)
    : undefined;
  const taskIds = Array.isArray(metadata?.taskIds)
    ? metadata.taskIds
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0)
    : undefined;
  const tags = normaliseSessionTags(metadata?.tags);

  return {
    AGENT: Boolean(metadata?.AGENT),
    billingMode: metadata?.billingMode === "credits" ? "credits" : "subscription",
    agentTransport: typeof metadata?.agentTransport === "string" && AGENT_TRANSPORTS.has(metadata.agentTransport)
      ? metadata.agentTransport as SessionMetadata["agentTransport"]
      : undefined,
    acpPermissionPolicy: parseAcpPermissionPolicy(metadata?.acpPermissionPolicy) ?? undefined,
    nativeAgentSession,
    resumedFromWingmanSessionId: resumedFromWingmanSessionId || undefined,
    branchedFromWingmanSessionId: branchedFromWingmanSessionId || undefined,
    branchConversationMode,
    branchConversationMessageCount,
    role: role || undefined,
    project: project || undefined,
    goal: goal || undefined,
    nextAction,
    nextActionPayload: nextActionPayload || undefined,
    nextActionTemplate: nextActionTemplate || undefined,
    sessionClass: metadata?.sessionClass === "flightdeck_chat" ? metadata.sessionClass : undefined,
    flightdeckTowerServiceNpub: cleanString(metadata?.flightdeckTowerServiceNpub) || undefined,
    flightdeckWorkspaceId: cleanString(metadata?.flightdeckWorkspaceId) || undefined,
    flightdeckScopeId: cleanString(metadata?.flightdeckScopeId) || undefined,
    flightdeckChannelId: cleanString(metadata?.flightdeckChannelId) || undefined,
    flightdeckThreadId: cleanString(metadata?.flightdeckThreadId) || undefined,
    flightdeckAgentNpub: cleanString(metadata?.flightdeckAgentNpub) || undefined,
    flightdeckRoutingKey: cleanString(metadata?.flightdeckRoutingKey) || undefined,
    sessionGeneration: Number.isFinite(sessionGeneration) && sessionGeneration > 0 ? Math.floor(sessionGeneration) : undefined,
    bindingType,
    bindingId: bindingId || undefined,
    flowId: flowId || undefined,
    flowRunId: flowRunId || undefined,
    retryAttempt: Number.isFinite(retryAttempt) && retryAttempt > 0 ? Math.floor(retryAttempt) : undefined,
    taskIds: taskIds?.length ? taskIds : undefined,
    tags,
    routerRunId: routerRunId || undefined,
    autoStop: Boolean(metadata?.autoStop),
    routedBy: routedBy || undefined,
    agentChatAgentId: agentChatAgentId || undefined,
    agentChatBotNpub: agentChatBotNpub || undefined,
    ownerNpub: ownerNpub || undefined,
    createdByNpub: createdByNpub || undefined,
    lastManagedByNpub: lastManagedByNpub || undefined,
    chargeToNpub: chargeToNpub || undefined,
    delegateRelationshipId: delegateRelationshipId || undefined,
    wappActivityInstallationId: wappActivityInstallationId || undefined,
    pinnedFiles: pinnedFiles?.length ? pinnedFiles : undefined,
    speechGenerateAudio: Boolean(metadata?.speechGenerateAudio),
    speechAlwaysRead: Boolean(metadata?.speechAlwaysRead),
  };
};

const NATIVE_AGENT_SESSION_SOURCES = new Set([
  "preallocated",
  "adapter",
  "agentapi",
  "manual",
]);

function normaliseNativeAgentSession(value: unknown): NativeAgentSessionMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const agent = typeof record.agent === "string" ? record.agent.trim().toLowerCase() : "";
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const workingDirectory =
    typeof record.workingDirectory === "string" ? record.workingDirectory.trim() : "";
  const capturedAtRaw = typeof record.capturedAt === "string" ? record.capturedAt.trim() : "";
  const capturedTimestamp = Date.parse(capturedAtRaw);
  const sourceRaw = typeof record.source === "string" ? record.source.trim() : "";
  const source = NATIVE_AGENT_SESSION_SOURCES.has(sourceRaw)
    ? sourceRaw as NativeAgentSessionMetadata["source"]
    : "manual";
  if (!agent || !sessionId || !workingDirectory) {
    return undefined;
  }
  return {
    agent,
    sessionId,
    workingDirectory,
    capturedAt: Number.isFinite(capturedTimestamp)
      ? new Date(capturedTimestamp).toISOString()
      : new Date().toISOString(),
    source,
  };
}

export const isAgentManagedSession = (
  metadata: SessionMetadata | null | undefined,
): boolean => Boolean(metadata?.AGENT);

export const isCreditsBillingSession = (
  metadata: SessionMetadata | null | undefined,
): boolean => metadata?.billingMode === "credits";

export const resolveSessionChargeNpub = (
  metadata: SessionMetadata | null | undefined,
  fallbackNpub: string | null | undefined,
): string | null => {
  const candidate = typeof metadata?.chargeToNpub === "string" ? metadata.chargeToNpub.trim() : "";
  if (candidate) {
    return candidate;
  }
  return typeof fallbackNpub === "string" && fallbackNpub.trim().length > 0 ? fallbackNpub.trim() : null;
};

const LEGACY_AGENT_ORIGIN_TYPES = new Set([
  "scheduler",
  "nostr",
  "mg-task",
  "file-watcher",
  "agent-session",
]);

type OriginLike = {
  type?: unknown;
} | null | undefined;

export const isLegacyAgentOrigin = (origin: OriginLike): boolean => {
  const type = typeof origin?.type === "string" ? origin.type.trim().toLowerCase() : "";
  if (!type) {
    return false;
  }
  return LEGACY_AGENT_ORIGIN_TYPES.has(type);
};

export const isAgentManagedByMetadataOrOrigin = (
  metadata: SessionMetadata | null | undefined,
  origin: OriginLike,
): boolean => isAgentManagedSession(metadata) || isLegacyAgentOrigin(origin);

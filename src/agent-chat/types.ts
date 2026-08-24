export type WorkspaceKeyStatus = 'pending' | 'active' | 'refresh_required' | 'revoked' | 'failed';
export type GroupKeyStatus = 'pending' | 'active' | 'refresh_required' | 'revoked' | 'failed';
export type SseStatus = 'disconnected' | 'connecting' | 'connected' | 'backoff' | 'disabled';
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';
export type BackendConnectionSharePolicy = 'private' | 'selected_users' | 'shared_service';
export type BackendConnectionGrantKind = 'manager_npub' | 'shared_service';
export type WorkspaceOnboardingSource = 'manual' | 'agent_connect_import' | 'nostr_33357';
export type AgentCapability =
  | 'chat_intercept'
  | 'task_dispatch'
  | 'comment_dispatch'
  | 'flow_dispatch'
  | 'task_review'
  | 'approval_dispatch';
export type DispatchTriggerKind = 'chat' | 'task' | 'document' | 'flow' | 'task_review' | 'approval' | 'comment';
export type DispatchActivePolicy = 'skip' | 'queue' | 'start_new';
export type PipelineVersionPolicy = 'latest';
export type AgentInterceptDecision = 'respond' | 'ignore' | 'pending' | 'failed';
export type ChatInterceptStateStatus =
  | 'pending'
  | 'active'
  | 'interrupting'
  | 'interrupt_failed'
  | 'idle'
  | 'archived'
  | 'blocked_auth'
  | 'blocked_decrypt';

export interface AgentChatDiagnostic {
  ok: boolean;
  code: string | null;
  message: string;
  at: string;
  details?: Record<string, unknown> | null;
}

export interface AgentChatSseEventDiagnostic {
  eventId: string | null;
  eventType: string;
  at: string;
  payload: Record<string, unknown> | null;
}

export interface BackendConnectionRecord {
  backendConnectionId: string;
  managedByNpub: string;
  backendBaseUrl: string;
  serviceNpub: string | null;
  setupWorkspaceOwnerNpub: string | null;
  setupSourceAppNpub: string | null;
  setupSourceAppSchemaNamespace: string | null;
  setupConnectionTokenRef: string | null;
  setupCapabilityDefaults: AgentCapability[];
  relayUrls: string[];
  openapiUrl: string | null;
  docsUrl: string | null;
  healthUrl: string | null;
  supportedVersion: string | null;
  sharePolicy: BackendConnectionSharePolicy;
  healthStatus: HealthStatus;
  lastHealthResult: AgentChatDiagnostic | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackendConnectionGrantRecord {
  backendConnectionId: string;
  grantKind: BackendConnectionGrantKind;
  granteeNpub: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentChatDispatchHistoryEntry {
  at: string;
  kind: 'chat' | 'task' | 'document' | 'flow' | 'review' | 'approval' | 'comment';
  action: string;
  agentId: string;
  sessionId: string | null;
  recordId: string | null;
  routeId?: string | null;
  pipelineRunId?: string | null;
  status?: string | null;
  concurrencyKey?: string | null;
  dedupeKey?: string | null;
  dedupeReason?: string | null;
  suppressionReason?: string | null;
  bindingId?: string | null;
  bindingType?: 'chat' | 'task' | 'document' | 'flow_run' | 'thread' | null;
  sourceLabel?: string | null;
  details?: Record<string, unknown> | null;
}

export interface DispatchRouteRecord {
  routeId: string;
  managedByNpub: string;
  subscriptionId: string;
  workspaceOwnerNpub: string;
  botNpub: string;
  sourceAppNpub: string;
  triggerKind: DispatchTriggerKind;
  capability: AgentCapability;
  pipelineDefinitionId: string;
  pipelineVersionPolicy: PipelineVersionPolicy;
  enabled: boolean;
  priority: number;
  matchJson: Record<string, unknown>;
  inputTemplateJson: Record<string, unknown>;
  concurrencyKeyTemplate: string;
  activePolicy: DispatchActivePolicy;
  dedupeWindowSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDispatchRouteInput {
  managedByNpub: string;
  subscriptionId: string;
  workspaceOwnerNpub: string;
  botNpub: string;
  sourceAppNpub: string;
  triggerKind: DispatchTriggerKind;
  capability: AgentCapability;
  pipelineDefinitionId: string;
  pipelineVersionPolicy?: PipelineVersionPolicy;
  enabled?: boolean;
  priority?: number;
  matchJson?: Record<string, unknown>;
  inputTemplateJson?: Record<string, unknown>;
  concurrencyKeyTemplate?: string;
  activePolicy?: DispatchActivePolicy;
  dedupeWindowSeconds?: number;
}

export interface WorkspaceSubscriptionRecord {
  subscriptionId: string;
  backendConnectionId?: string | null;
  workspaceOwnerNpub: string;
  backendBaseUrl: string;
  towerServiceNpub?: string | null;
  workspaceId?: string | null;
  workspaceServiceNpub?: string | null;
  botNpub: string;
  sourceAppNpub: string;
  onboardingSource: WorkspaceOnboardingSource;
  connectionTokenRef?: string | null;
  agentProfileId?: string | null;
  sourceAppSchemaNamespace?: string | null;
  capabilityDefaults?: AgentCapability[];
  dispatchRouteIds?: string[];
  lastSyncCursor?: string | null;
  lastEventPollOkAt?: string | null;
  lastEventPollErrorAt?: string | null;
  lastEventPollErrorCode?: string | null;
  lastEventPollEventCount?: number | null;
  lastEventPollLagMs?: number | null;
  lastPipelineRunId?: string | null;
  wsKeyNpub: string | null;
  wsKeyStatus: WorkspaceKeyStatus;
  groupKeyStatus: GroupKeyStatus;
  sseStatus: SseStatus;
  healthStatus: HealthStatus;
  // Legacy migration field retained for operator visibility only.
  triggerConfigRecordId: string | null;
  lastSseEventId: string | null;
  lastAuthOkAt: string | null;
  lastGroupRefreshAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
  managedByNpub: string | null;
  wsKeyBlobJson: string | null;
  wrappedGroupKeysJson: string | null;
  lastAuthResult: AgentChatDiagnostic | null;
  lastGroupRefreshResult: AgentChatDiagnostic | null;
  lastRecordPullResult: AgentChatDiagnostic | null;
  lastDecryptResult: AgentChatDiagnostic | null;
  lastRoutingResult: AgentChatDiagnostic | null;
  lastSseEvent: AgentChatSseEventDiagnostic | null;
  recentSseEvents: AgentChatSseEventDiagnostic[];
  recentDispatches: AgentChatDispatchHistoryEntry[];
  lastSuccessfulStartupReloadAt: string | null;
}

export interface AgentDefinitionRecord {
  agentId: string;
  label: string;
  botNpub: string;
  workspaceOwnerNpub: string;
  groupNpubs: string[];
  workingDirectory: string;
  harness?: string | null;
  model?: string | null;
  archived?: boolean;
  publicProfile?: {
    name: string;
    picture: string | null;
    about: string | null;
    nip05: string | null;
  };
  publicProfileRefresh?: {
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    sourceEventId: string | null;
    sourceEventCreatedAt: number | null;
    result: 'hydrated' | 'unchanged' | 'published' | 'failed' | null;
    error: string | null;
  };
  directChat?: {
    enabled: boolean;
    sessionAgent: string | null;
    directory: string;
    model: string | null;
    idleRetentionMinutes: number;
  };
  capabilities: AgentCapability[];
  chatPromptTemplate?: string;
  taskPromptTemplate?: string;
  flowDispatchPromptTemplate?: string;
  taskReviewPromptTemplate?: string;
  approvalDispatchPromptTemplate?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  managedByNpub: string | null;
}

export interface ChatInterceptStateRecord {
  routingKey: string;
  subscriptionId: string;
  agentId: string;
  sessionId: string | null;
  sessionGeneration?: number;
  previousSessionIds?: string[];
  sessionClass: 'chat';
  workspaceOwnerNpub: string;
  sourceAppNpub: string;
  towerServiceNpub?: string;
  workspaceId?: string;
  channelId: string;
  threadId: string;
  botNpub: string;
  lastMessageIdSeen: string | null;
  lastEventCursorSeen?: string | null;
  lastHumanMessageIdDelivered?: string | null;
  lastAgentMessageIdPublished?: string | null;
  lastCompletedTurnId?: string | null;
  pendingMessageCount: number;
  state: ChatInterceptStateStatus;
  lastDecision: AgentInterceptDecision;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceSubscriptionInput {
  managedByNpub: string;
  workspaceOwnerNpub: string;
  backendBaseUrl: string;
  towerServiceNpub?: string | null;
  workspaceId?: string | null;
  workspaceServiceNpub?: string | null;
  sourceAppNpub: string;
  onboardingSource?: WorkspaceOnboardingSource;
  backendConnectionId?: string | null;
  backendConnectionGrantKind?: BackendConnectionGrantKind | null;
  connectionTokenRef?: string | null;
  agentProfileId?: string | null;
  sourceAppSchemaNamespace?: string | null;
  capabilityDefaults?: AgentCapability[];
  dispatchRouteIds?: string[];
  triggerConfigRecordId?: string | null;
}

export interface UpdateWorkspaceSubscriptionInput extends WorkspaceSubscriptionRecord {}

export interface CreateAgentDefinitionInput {
  managedByNpub: string;
  agentId: string;
  label: string;
  botNpub: string;
  workspaceOwnerNpub: string;
  /** Legacy encrypted-record routing only. Flight Deck PG agents leave this empty. */
  groupNpubs?: string[];
  workingDirectory: string;
  harness?: string | null;
  model?: string | null;
  archived?: boolean;
  publicProfile?: AgentDefinitionRecord['publicProfile'];
  /** Server-managed Nostr snapshot provenance; never accepted from public request bodies. */
  publicProfileRefresh?: AgentDefinitionRecord['publicProfileRefresh'];
  capabilities?: AgentCapability[];
  chatPromptTemplate?: string;
  taskPromptTemplate?: string;
  flowDispatchPromptTemplate?: string;
  taskReviewPromptTemplate?: string;
  approvalDispatchPromptTemplate?: string;
  directChat?: AgentDefinitionRecord['directChat'];
  enabled?: boolean;
  /** Internal creation mode for a new encrypted identity before its first PG subscription is established. */
  unboundProfile?: boolean;
  /** Internal edit mode: validation has run and the submitted absolute path must round-trip unchanged. */
  preserveValidatedWorkingDirectory?: boolean;
}

export interface BotKeyStoreRecord {
  id: string;
  userNpub: string;
  botPubkeyHex: string;
  botNpub: string;
  displayName: string;
  encryptedToUser: string;
  encryptedEscrow: string;
  escrowUuid: string;
  isActive: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeBotIdentity {
  botNpub: string;
  botPubkeyHex: string;
  botSecret: Uint8Array;
}

export interface YokeBotHelperError extends Error {
  code?: string;
}

export interface YokeWorkspaceSession {
  npub: string;
  secret: Uint8Array;
  isWorkspaceKey?: boolean;
  botNpub?: string;
}

export interface YokeBotHelpersModule {
  BotHelperError?: new (code: string, message: string, options?: { cause?: unknown }) => YokeBotHelperError;
  createBotWorkspaceKey: (params: {
    botSecret: Uint8Array;
    botNpub: string;
    workspaceOwnerNpub: string;
  }) => { blob: Record<string, unknown>; wsSession: YokeWorkspaceSession };
  signBotRequest: (params: {
    botSecret: Uint8Array;
    botNpub: string;
    url: string;
    method: string;
    body?: unknown;
  }) => string;
  loadBotWorkspaceKey: (params: {
    blob: Record<string, unknown>;
    botSecret: Uint8Array;
    botNpub: string;
  }) => { wsSession: YokeWorkspaceSession };
  signWorkspaceRequest: (params: {
    wsSession: YokeWorkspaceSession;
    url: string;
    method: string;
    body?: unknown;
  }) => string;
  fetchBotGroupKeys: (params: {
    wsSession: YokeWorkspaceSession;
    backendBaseUrl: string;
    fetchImpl?: typeof fetch;
  }) => Promise<unknown[]>;
  loadBotGroupKeys: (params: {
    wsSession: YokeWorkspaceSession;
    botSecret: Uint8Array;
    botNpub: string;
    keyRows: unknown[];
  }) => unknown;
  decryptChatRecord: (params: {
    record: Record<string, unknown>;
    wsSession: YokeWorkspaceSession;
    groupKeys: unknown;
  }) => Record<string, unknown>;
  normalizeThreadId: (chatMessage: Record<string, unknown>, context?: Record<string, unknown>) => string;
  normalizeChannelParticipants: (input: Record<string, unknown>) => string[];
  normalizeChatRoutingContext: (
    input: { chatMessage: Record<string, unknown>; channel: Record<string, unknown> },
    context?: Record<string, unknown>,
  ) => {
    record_id: string;
    channel_id: string;
    parent_message_id: string | null;
    thread_id: string;
    participant_npubs: string[];
  };
}

export interface BrowserSignedNip98TokenRequest {
  npub: string;
  url: string;
  method: string;
  body?: unknown;
}

export interface InboundTaskRecord {
  taskId: string;
  flowId: string | null;
  flowRunId: string | null;
  flowStep: string | null;
  scopeId: string | null;
  scopeL1Id: string | null;
  scopeL2Id: string | null;
  scopeL3Id: string | null;
  scopeL4Id: string | null;
  scopeL5Id: string | null;
  title: string;
  description: string | null;
  state: string | null;
  assignedTo: string | null;
  deleted: boolean;
  done: boolean;
  predecessorTaskIds: string[];
}

export interface InboundApprovalRecord {
  approvalId: string | null;
  flowId: string | null;
  flowRunId: string | null;
  flowStep: string | null;
  state: string | null;
}

export interface InboundCommentRecord {
  commentId: string;
  targetRecordId: string | null;
  targetRecordFamilyHash: string | null;
  parentCommentId: string | null;
  anchorLineNumber: number | null;
  commentStatus: 'open' | 'resolved';
  body: string;
  attachments: unknown[];
  senderNpub: string | null;
  recordState: string | null;
}

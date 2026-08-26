import { isAbsolute } from 'node:path';

import type { RequestAuthContext } from '../auth/request-context';
import type { WorkspaceSubscriptionManager } from '../agent-chat/subscription-runtime';
import {
  DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
} from '../agent-chat/prompt-templates';
import { normaliseNpub } from '../identity/npub-utils';
import type {
  AgentDefinitionRecord,
  AgentChatDiagnostic,
  AgentChatSseEventDiagnostic,
  BackendConnectionGrantRecord,
  BackendConnectionRecord,
  ChatInterceptStateRecord,
  DispatchActivePolicy,
  DispatchRouteRecord,
  DispatchTriggerKind,
  WorkspaceSubscriptionRecord,
} from '../agent-chat/types';
import type {
  AgentProfileWorkspaceBundle,
  AgentWorkspaceContextKind,
  AgentWorkspaceEventType,
  AgentWorkspacePipelineOverrideTarget,
  AgentWorkspacePolicyAction,
} from '../agent-chat/agent-profile-policy-store';
import {
  normaliseDuplicateCallbackMarker,
  normaliseDuplicateCallbackWindowSeconds,
} from '../agent-chat/agent-profile-policy-store';
import { directChatTurnStore } from '../agent-chat/direct-chat-turn-store';
import type { SignedNostrEvent } from '../identity/bot-identity-publisher';
import type { AgentProfileRotationResult } from '../agent-chat/agent-profile-key-rotation';
import {
  handleAgentProfileCreateApi,
  handleAgentProfileMediaUploadApi,
  type AgentProfileMediaApiContext,
} from './agent-profile-media-routes';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface AgentChatApiContext extends AgentProfileMediaApiContext {
  manager: WorkspaceSubscriptionManager;
  agentTypes?: Array<{ id: string; label: string; modelOptions?: string[] }>;
  adminNpub?: string | null;
  sharedAgentDispatch?: boolean;
  isAdminContext?: (authContext: RequestAuthContext) => boolean;
  publishAgentProfile?: (input: { event: SignedNostrEvent; agent: AgentDefinitionRecord }) => Promise<unknown>;
  republishAgentProfile?: (agent: AgentDefinitionRecord) => Promise<{
    eventId: string;
    createdAt: number;
    [key: string]: unknown;
  }>;
  rotateAgentProfileKey?: (input: {
    requestId: string;
    profileId: string;
    managedByNpub: string;
    expectedCurrentNpub: string;
    confirmationProfileId: string;
    confirmationCurrentNpub: string;
  }) => Promise<AgentProfileRotationResult>;
}

interface AgentChatRequestScope {
  viewerNpub: string;
  managerNpub: string;
  shared: boolean;
  canManage: boolean;
}

function getDetailString(
  diagnostic: AgentChatDiagnostic | null | undefined,
  key: string,
): string | null {
  const value = diagnostic?.details?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getPayloadString(
  diagnostic: AgentChatSseEventDiagnostic | null | undefined,
  key: string,
): string | null {
  const value = diagnostic?.payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function buildOperatorRecommendations(record: WorkspaceSubscriptionRecord, intercepts: ChatInterceptStateRecord[]) {
  const recommendations = new Map<string, { action: string; label: string; reason: string }>();
  const addRecommendation = (action: string, label: string, reason: string) => {
    const key = `${action}:${label}`;
    if (!recommendations.has(key)) {
      recommendations.set(key, { action, label, reason });
    }
  };
  const hasBlockedAuth = intercepts.some((intercept) => intercept.state === 'blocked_auth');
  const hasBlockedDecrypt = intercepts.some((intercept) => intercept.state === 'blocked_decrypt');
  const hasInterruptFailure = intercepts.some((intercept) => intercept.state === 'interrupt_failed');

  if (record.sseStatus === 'disabled') {
    addRecommendation('enable', 'Re-enable subscription', 'SSE is disabled, so Agent Chat will not receive workspace advisories.');
  }
  if (record.sseStatus === 'backoff' || record.sseStatus === 'disconnected') {
    addRecommendation('reconnect', 'Reconnect subscription', 'The workspace SSE stream is not currently connected.');
  }
  if (record.wsKeyStatus !== 'active' || hasBlockedAuth) {
    addRecommendation('refresh-keys', 'Refresh workspace key', 'Workspace auth is stale, revoked, or otherwise blocked.');
  }
  if (!record.workspaceId && (record.groupKeyStatus === 'refresh_required' || record.groupKeyStatus === 'failed' || hasBlockedDecrypt)) {
    addRecommendation('refresh-keys', 'Refresh wrapped group keys', 'Decrypt or group membership state needs to be refreshed.');
  }
  if (hasInterruptFailure) {
    addRecommendation('reconnect', 'Reconnect session runtime', 'An interrupt failed and the runtime is running queued same-session follow-up prompts.');
  }

  return Array.from(recommendations.values());
}

function serialiseAgent(record: AgentDefinitionRecord) {
  const { groupNpubs: _legacyGroupNpubs, ...visibleRecord } = record;
  return {
    ...visibleRecord,
    operator: {
      enabled: record.enabled,
      capabilityCount: record.capabilities.length,
    },
  };
}

function serialiseBackendConnection(
  record: BackendConnectionRecord,
  viewerNpub?: string | null,
  grants: BackendConnectionGrantRecord[] = [],
) {
  return {
    ...record,
    availabilityGrants: grants,
    operator: {
      relayCount: record.relayUrls.length,
      hasHealthUrl: Boolean(record.healthUrl),
      canManageAvailability: Boolean(viewerNpub && record.managedByNpub === viewerNpub),
    },
  };
}

function serialiseDispatchRoute(record: DispatchRouteRecord) {
  return { ...record };
}

function parsePipelineVersionPolicy(value: unknown): 'latest' {
  return value === 'latest' ? 'latest' : 'latest';
}

function getProfileWorkspaceForSubscription(
  manager: WorkspaceSubscriptionManager,
  subscriptionId: string,
  managerNpub: string,
): AgentProfileWorkspaceBundle | null {
  const withProfileWorkspace = manager as WorkspaceSubscriptionManager & {
    getProfileWorkspaceForManager?: (subscriptionId: string, npub: string) => AgentProfileWorkspaceBundle | null;
  };
  return withProfileWorkspace.getProfileWorkspaceForManager?.(subscriptionId, managerNpub) ?? null;
}

function getSubscriptionForManager(
  manager: WorkspaceSubscriptionManager,
  subscriptionId: string,
  managerNpub: string,
): WorkspaceSubscriptionRecord | null {
  const withSubscription = manager as WorkspaceSubscriptionManager & {
    getForManager?: (subscriptionId: string, npub: string) => WorkspaceSubscriptionRecord | null;
  };
  return withSubscription.getForManager?.(subscriptionId, managerNpub) ?? null;
}

function getEffectiveWorkspaceNpub(record: Pick<WorkspaceSubscriptionRecord, 'workspaceOwnerNpub' | 'workspaceServiceNpub'>): string {
  return record.workspaceServiceNpub?.trim() || record.workspaceOwnerNpub;
}

function getDiagnosticDetailString(
  details: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = details?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function serialiseVisibleProfileWorkspaceContext(
  bundle: AgentProfileWorkspaceBundle,
  subscription?: WorkspaceSubscriptionRecord | null,
) {
  const scopes = new Map<string, { id: string; label: string; source: string }>();
  const channels = new Map<string, { id: string; label: string; source: string; scopeId: string | null }>();
  const addScope = (id: string | null, source: string) => {
    if (!id || scopes.has(id)) return;
    scopes.set(id, { id, label: id, source });
  };
  const addChannel = (id: string | null, source: string, scopeId: string | null = null) => {
    if (!id || channels.has(id)) return;
    channels.set(id, { id, label: id, source, scopeId });
  };

  for (const override of bundle.pipelineOverrides) {
    if (override.targetKind === 'scope') {
      addScope(override.targetId, 'configured_override');
    } else if (override.targetKind === 'channel') {
      addChannel(override.targetId, 'configured_override');
    }
  }
  for (const context of bundle.appendedContexts) {
    if (context.contextKind === 'scope') {
      addScope(context.targetId, 'configured_context');
    } else if (context.contextKind === 'channel') {
      addChannel(context.targetId, 'configured_context');
    }
  }

  const routingScopeId = getDiagnosticDetailString(subscription?.lastRoutingResult?.details, 'scope_id');
  const routingChannelId = getDiagnosticDetailString(subscription?.lastRoutingResult?.details, 'channel_id');
  addScope(routingScopeId, 'last_routing');
  addChannel(routingChannelId, 'last_routing', routingScopeId);

  for (const dispatch of subscription?.recentDispatches ?? []) {
    const scopeId = getDiagnosticDetailString(dispatch.details, 'scope_id');
    const channelId = getDiagnosticDetailString(dispatch.details, 'channel_id');
    addScope(scopeId, 'recent_dispatch');
    addChannel(channelId, 'recent_dispatch', scopeId);
  }

  return {
    scopes: [...scopes.values()],
    channels: [...channels.values()],
  };
}

function serialiseProfileWorkspace(bundle: AgentProfileWorkspaceBundle | null, subscription?: WorkspaceSubscriptionRecord | null) {
  if (!bundle) {
    return null;
  }
  return {
    profile: bundle.profile,
    workspace: bundle.workspace,
    policies: bundle.policies,
    pipelineOverrides: bundle.pipelineOverrides,
    appendedContexts: bundle.appendedContexts,
    visibleContext: serialiseVisibleProfileWorkspaceContext(bundle, subscription),
  };
}

function getBackendWorkspaceName(record: BackendConnectionRecord | null | undefined): string | null {
  const response = record?.lastHealthResult?.details?.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return null;
  }
  const towerName = (response as Record<string, unknown>).tower_name;
  return typeof towerName === 'string' && towerName.trim().length > 0 ? towerName.trim() : null;
}

function serialiseSubscription(
  record: WorkspaceSubscriptionRecord,
  intercepts: ChatInterceptStateRecord[],
  candidateAgents: AgentDefinitionRecord[],
  backendConnection?: BackendConnectionRecord | null,
  profileWorkspace?: AgentProfileWorkspaceBundle | null,
  options: { canManage?: boolean; shared?: boolean } = {},
) {
  const recommendations = buildOperatorRecommendations(record, intercepts);
  const { wrappedGroupKeysJson: _legacyWrappedGroupKeys, ...visibleRecord } = record;
  const delivery = directChatTurnStore.getHealth(record.subscriptionId, Date.now(), {
    awaitingDegradedMs: Number(Bun.env.AGENT_DIRECT_AWAITING_DEGRADED_MS) || undefined,
    awaitingUnhealthyMs: Number(Bun.env.AGENT_DIRECT_AWAITING_UNHEALTHY_MS) || undefined,
    replyDegradedMs: Number(Bun.env.AGENT_DIRECT_REPLY_DEGRADED_MS) || undefined,
    replyUnhealthyMs: Number(Bun.env.AGENT_DIRECT_REPLY_UNHEALTHY_MS) || undefined,
  });
  const healthStatus = record.healthStatus === 'unhealthy' || delivery.healthStatus === 'unhealthy' ? 'unhealthy'
    : record.healthStatus === 'degraded' || delivery.healthStatus === 'degraded' ? 'degraded' : 'healthy';
  return {
    ...visibleRecord,
    healthStatus,
    ...(record.workspaceId ? {} : { wrappedGroupKeysJson: record.wrappedGroupKeysJson }),
    workspaceName: getBackendWorkspaceName(backendConnection),
    profileWorkspace: serialiseProfileWorkspace(profileWorkspace ?? null, record),
    backend: backendConnection
      ? {
          backendConnectionId: backendConnection.backendConnectionId,
          backendBaseUrl: backendConnection.backendBaseUrl,
          serviceNpub: backendConnection.serviceNpub,
          healthStatus: backendConnection.healthStatus,
          workspaceName: getBackendWorkspaceName(backendConnection),
        }
      : record.backendConnectionId
        ? { backendConnectionId: record.backendConnectionId }
      : null,
    intercepts,
    candidateAgents: candidateAgents.map(serialiseAgent),
    operator: {
      enabled: record.sseStatus !== 'disabled',
      canManage: options.canManage !== false,
      shared: options.shared === true,
      blockedInterceptCount: intercepts.filter((intercept) => (
        intercept.state === 'blocked_auth' || intercept.state === 'blocked_decrypt'
      )).length,
      activeInterceptCount: intercepts.filter((intercept) => intercept.state === 'active').length,
      candidateAgentCount: candidateAgents.length,
      recommendations,
      agentDirectDelivery: delivery,
    },
    diagnostics: {
      lastSseEventId: record.lastSseEventId,
      lastSseEvent: record.lastSseEvent,
      advisory: {
        eventId: record.lastSseEventId ?? record.lastSseEvent?.eventId ?? null,
        eventType: record.lastSseEvent?.eventType ?? null,
        at: record.lastSseEvent?.at ?? null,
        familyHash: getPayloadString(record.lastSseEvent, 'family_hash'),
        recordId: getPayloadString(record.lastSseEvent, 'record_id'),
      },
      recordPull: record.lastRecordPullResult,
      decrypt: record.lastDecryptResult,
      routing: record.lastRoutingResult,
      agentDirectDelivery: delivery,
      trail: {
        advisory: {
          seen: Boolean(record.lastSseEventId || record.lastSseEvent),
          eventId: record.lastSseEventId ?? record.lastSseEvent?.eventId ?? null,
          at: record.lastSseEvent?.at ?? null,
          recordId: getPayloadString(record.lastSseEvent, 'record_id'),
        },
        recordPull: {
          ok: record.lastRecordPullResult?.ok ?? null,
          code: record.lastRecordPullResult?.code ?? null,
          at: record.lastRecordPullResult?.at ?? null,
          recordId: getDetailString(record.lastRecordPullResult, 'record_id'),
        },
        decrypt: {
          ok: record.lastDecryptResult?.ok ?? null,
          code: record.lastDecryptResult?.code ?? null,
          at: record.lastDecryptResult?.at ?? null,
          recordId: getDetailString(record.lastDecryptResult, 'record_id'),
        },
        routing: {
          ok: record.lastRoutingResult?.ok ?? null,
          code: record.lastRoutingResult?.code ?? null,
          at: record.lastRoutingResult?.at ?? null,
          recordId: getDetailString(record.lastRoutingResult, 'record_id'),
        },
      },
    },
  };
}

function getAgentChatErrorStatus(error: unknown, fallback: number): number {
  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600
    ? statusCode
    : fallback;
}

function resolveAgentChatScope(authContext: RequestAuthContext, ctx: AgentChatApiContext): AgentChatRequestScope | null {
  const viewerNpub = normaliseNpub(authContext.session?.npub ?? authContext.npub ?? null);
  if (!viewerNpub) {
    return null;
  }

  const adminNpub = normaliseNpub(ctx.adminNpub ?? null);
  const shared = Boolean(ctx.sharedAgentDispatch && adminNpub);
  const isAdmin = Boolean(ctx.isAdminContext?.(authContext) || (adminNpub && viewerNpub === adminNpub));
  return {
    viewerNpub,
    managerNpub: shared ? adminNpub! : viewerNpub,
    shared,
    canManage: !shared || isAdmin,
  };
}

function requireAgentChatManagement(scope: AgentChatRequestScope): Response | null {
  if (scope.canManage) {
    return null;
  }
  return Response.json(
    { error: 'Agent Dispatch subscriptions are shared on this Wingman instance. Ask an administrator to change them.' },
    { status: 403 },
  );
}

function getOptionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function parseJsonObjectField(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseDispatchTriggerKind(value: unknown): DispatchTriggerKind | null {
  return value === 'chat' || value === 'task' || value === 'document' || value === 'flow' || value === 'task_review' || value === 'approval' || value === 'comment'
    ? value
    : null;
}

function parseDispatchCapability(value: unknown) {
  return value === 'chat_intercept'
    || value === 'task_dispatch'
    || value === 'comment_dispatch'
    || value === 'flow_dispatch'
    || value === 'task_review'
    || value === 'approval_dispatch'
    ? value
    : null;
}

function parseDispatchCapabilities(value: unknown) {
  return getOptionalStringArray(value)
    .map(parseDispatchCapability)
    .filter((capability): capability is NonNullable<ReturnType<typeof parseDispatchCapability>> => Boolean(capability));
}

function parseActivePolicy(value: unknown): DispatchActivePolicy | undefined {
  return value === 'skip' || value === 'queue' || value === 'start_new' ? value : undefined;
}

function parseWorkspacePolicyEventType(value: unknown): AgentWorkspaceEventType | null {
  return value === 'direct_message'
    || value === 'chat_mention'
    || value === 'chat_observe'
    || value === 'document_created'
    || value === 'document_invocation'
    || value === 'document_comment_tagged'
    || value === 'document_comment_observe'
    || value === 'task_assigned'
    || value === 'task_invocation'
    || value === 'task_comment'
    || value === 'approval_assigned'
    || value === 'flow_step_assigned'
    ? value
    : null;
}

function parseWorkspacePolicyAction(value: unknown): AgentWorkspacePolicyAction | undefined {
  return value === 'respond'
    || value === 'ignore'
    || value === 'observe'
    || value === 'index'
    || value === 'work'
    || value === 'acknowledge'
    || value === 'notify'
    || value === 'process'
    || value === 'run_flow_handler'
    ? value
    : undefined;
}

function parsePipelineOverrideTarget(value: unknown): AgentWorkspacePipelineOverrideTarget | null {
  return value === 'scope' || value === 'channel' ? value : null;
}

function parseAppendedContextKind(value: unknown): AgentWorkspaceContextKind | null {
  return value === 'workspace' || value === 'scope' || value === 'channel' || value === 'event_policy' ? value : null;
}

function parseProfileWorkspacePolicies(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const eventType = parseWorkspacePolicyEventType(record.eventType);
    const hasPipelineDefinitionId = Object.prototype.hasOwnProperty.call(record, 'pipelineDefinitionId');
    const hasPromptContext = Object.prototype.hasOwnProperty.call(record, 'promptContext');
    if (!eventType) {
      return [];
    }
    return [{
      eventType,
      enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
      defaultAction: parseWorkspacePolicyAction(record.defaultAction),
      pipelineDefinitionId: hasPipelineDefinitionId
        ? typeof record.pipelineDefinitionId === 'string' ? record.pipelineDefinitionId : null
        : undefined,
      pipelineVersionPolicy: parsePipelineVersionPolicy(record.pipelineVersionPolicy),
      promptContext: hasPromptContext
        ? typeof record.promptContext === 'string' ? record.promptContext : null
        : undefined,
      quietMode: typeof record.quietMode === 'boolean' ? record.quietMode : undefined,
    }];
  });
}

function parseProfileWorkspacePipelineOverrides(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const targetKind = parsePipelineOverrideTarget(record.targetKind);
    const targetId = typeof record.targetId === 'string' ? record.targetId.trim() : '';
    const pipelineDefinitionId = typeof record.pipelineDefinitionId === 'string' ? record.pipelineDefinitionId.trim() : '';
    return targetKind && targetId && pipelineDefinitionId
      ? [{ targetKind, targetId, pipelineDefinitionId, pipelineVersionPolicy: parsePipelineVersionPolicy(record.pipelineVersionPolicy) }]
      : [];
  });
}

function parseProfileWorkspaceAppendedContexts(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const contextKind = parseAppendedContextKind(record.contextKind);
    if (!contextKind) {
      return [];
    }
    return [{
      contextKind,
      targetId: typeof record.targetId === 'string' ? record.targetId.trim() : null,
      eventType: parseWorkspacePolicyEventType(record.eventType),
      contextText: typeof record.contextText === 'string' ? record.contextText : '',
    }];
  });
}

function getObjectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' && !Array.isArray(field)
    ? field as Record<string, unknown>
    : null;
}

function hasField(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const AGENT_CHAT_API_PREFIXES = [
  '/api/agent-chat/subscriptions',
  '/api/agent-chat/agents',
  '/api/agent-chat/profiles',
  '/api/agent-chat/backend-connections',
  '/api/agent-chat/agent-connect',
  '/api/agent-chat/dispatch-routes',
  '/api/agent-chat/dispatch-outcomes',
] as const;

export function isAgentChatApiPath(pathname: string): boolean {
  return AGENT_CHAT_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export async function handleAgentChatApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: AgentChatApiContext,
): Promise<Response | null> {
  if (!isAgentChatApiPath(url.pathname)) {
    return null;
  }

  const scope = resolveAgentChatScope(authContext, ctx);
  if (!scope) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (url.pathname === '/api/agent-chat/dispatch-outcomes' && method === 'GET') {
    const limitValue = Number(url.searchParams.get('limit') ?? 25);
    const offsetValue = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number.isSafeInteger(limitValue) ? Math.max(1, Math.min(100, limitValue)) : 25;
    const offset = Number.isSafeInteger(offsetValue) ? Math.max(0, offsetValue) : 0;
    const includeIgnoredAndSuppressed = url.searchParams.get('includeIgnoredAndSuppressed') === 'true';
    return Response.json(ctx.manager.listDispatchOutcomesForManager(
      scope.managerNpub,
      { limit, offset, includeIgnoredAndSuppressed },
    ));
  }

  if (url.pathname === '/api/agent-chat/subscriptions' && method === 'GET') {
    const backendConnections = ctx.manager.listBackendConnectionsForManager(scope.managerNpub);
    return Response.json({
      permissions: {
        shared: scope.shared,
        canManage: scope.canManage,
      },
      subscriptions: ctx.manager.listForManager(scope.managerNpub).map((record) => {
        const backendConnection = backendConnections.find((backend) => backend.backendConnectionId === record.backendConnectionId) ?? null;
        return serialiseSubscription(
          record,
          ctx.manager.listInterceptsForSubscription(record.subscriptionId, scope.managerNpub),
          ctx.manager.listAgentsForWorkspaceBot(getEffectiveWorkspaceNpub(record), record.botNpub, scope.managerNpub),
          backendConnection,
          getProfileWorkspaceForSubscription(ctx.manager, record.subscriptionId, scope.managerNpub),
          { canManage: scope.canManage, shared: scope.shared },
        );
      }),
    });
  }

  if (url.pathname === '/api/agent-chat/agents' && method === 'GET') {
    const defaultAgentProfile = ctx.manager.getDefaultAgentForManager(scope.managerNpub);
    return Response.json({
      permissions: {
        shared: scope.shared,
        canManage: scope.canManage,
      },
      agents: ctx.manager.listAgentsForManager(scope.managerNpub).map(serialiseAgent),
      defaults: {
        defaultAgentProfileId: defaultAgentProfile?.agentId ?? null,
        agentTypes: ctx.agentTypes ?? [],
        chatPromptTemplate: DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
        taskPromptTemplate: DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
        flowDispatchPromptTemplate: DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
        taskReviewPromptTemplate: DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
        approvalDispatchPromptTemplate: DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
      },
    });
  }

  const profileCreateResponse = await handleAgentProfileCreateApi(request, url, method, scope, ctx);
  if (profileCreateResponse) return profileCreateResponse;
  const profileMediaResponse = await handleAgentProfileMediaUploadApi(request, url, method, scope, ctx);
  if (profileMediaResponse) return profileMediaResponse;

  if (url.pathname === '/api/agent-chat/backend-connections' && method === 'GET') {
    return Response.json({
      permissions: {
        shared: scope.shared,
        canManage: scope.canManage,
      },
      backendConnections: ctx.manager.listBackendConnectionsForManager(scope.managerNpub).map((record) => (
        serialiseBackendConnection(
          record,
          scope.viewerNpub,
          scope.canManage
            ? ctx.manager.listBackendConnectionGrantsForManager(record.backendConnectionId, scope.managerNpub)
            : [],
        )
      )),
    });
  }

  const backendAvailabilityMatch = url.pathname.match(/^\/api\/agent-chat\/backend-connections\/([^/]+)\/availability$/);
  if (backendAvailabilityMatch && (method === 'POST' || method === 'PATCH')) {
    const denied = requireAgentChatManagement(scope);
    if (denied) {
      return denied;
    }
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const backendConnectionId = decodeURIComponent(backendAvailabilityMatch[1]!);
    const allowedManagerNpubs = getOptionalStringArray(body.allowedManagerNpubs);
    const grantSharedService = body.grantSharedService === true;

    try {
      const result = ctx.manager.updateBackendConnectionAvailabilityForManager({
        backendConnectionId,
        managedByNpub: scope.managerNpub,
        managerNpubs: allowedManagerNpubs,
        sharedService: grantSharedService,
      });
      return Response.json({
        backendConnection: serialiseBackendConnection(
          result.backendConnection,
          scope.viewerNpub,
          result.grants,
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update backend connection availability.';
      return Response.json({ error: message }, { status: getAgentChatErrorStatus(error, 400) });
    }
  }

  if (url.pathname === '/api/agent-chat/dispatch-routes' && method === 'GET') {
    const subscriptionId = url.searchParams.get('subscriptionId');
    const routes = subscriptionId
      ? ctx.manager.listDispatchRoutesForSubscription(subscriptionId, scope.managerNpub)
      : ctx.manager.listDispatchRoutesForManager(scope.managerNpub);
    return Response.json({
      permissions: {
        shared: scope.shared,
        canManage: scope.canManage,
      },
      dispatchRoutes: routes.map(serialiseDispatchRoute),
    });
  }

  if (url.pathname === '/api/agent-chat/dispatch-routes' && (method === 'POST' || method === 'PATCH')) {
    const denied = requireAgentChatManagement(scope);
    if (denied) {
      return denied;
    }
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const routeId = typeof body.routeId === 'string' && body.routeId.trim().length > 0 ? body.routeId.trim() : undefined;
    const subscriptionId = typeof body.subscriptionId === 'string' ? body.subscriptionId.trim() : '';
    const triggerKind = parseDispatchTriggerKind(body.triggerKind);
    const capability = parseDispatchCapability(body.capability);
    const pipelineDefinitionId = typeof body.pipelineDefinitionId === 'string' ? body.pipelineDefinitionId.trim() : '';
    const pipelineVersionPolicy = parsePipelineVersionPolicy(body.pipelineVersionPolicy);
    if (!subscriptionId || !triggerKind || !capability || !pipelineDefinitionId) {
      return Response.json(
        { error: 'subscriptionId, triggerKind, capability, and pipelineDefinitionId are required.' },
        { status: 400 },
      );
    }

    try {
      const route = ctx.manager.saveDispatchRouteForManager({
        routeId,
        managedByNpub: scope.managerNpub,
        subscriptionId,
        triggerKind,
        capability,
        pipelineDefinitionId,
        pipelineVersionPolicy,
        enabled: body.enabled !== false,
        priority: Number.isFinite(body.priority) ? Number(body.priority) : undefined,
        matchJson: parseJsonObjectField(body.matchJson),
        inputTemplateJson: parseJsonObjectField(body.inputTemplateJson),
        concurrencyKeyTemplate: typeof body.concurrencyKeyTemplate === 'string' ? body.concurrencyKeyTemplate : undefined,
        activePolicy: parseActivePolicy(body.activePolicy),
        dedupeWindowSeconds: Number.isFinite(body.dedupeWindowSeconds) ? Number(body.dedupeWindowSeconds) : undefined,
      });
      return Response.json({ dispatchRoute: serialiseDispatchRoute(route) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save dispatch route.';
      return Response.json({ error: message }, { status: getAgentChatErrorStatus(error, 400) });
    }
  }

  if (url.pathname === '/api/agent-chat/agent-connect/import' && method === 'POST') {
    const denied = requireAgentChatManagement(scope);
    if (denied) {
      return denied;
    }
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const rawPackage = typeof body.packageJson === 'string'
      ? body.packageJson
      : typeof body.agentConnectJson === 'string'
        ? body.agentConnectJson
        : body.package && typeof body.package === 'object'
          ? body.package as Record<string, unknown>
          : null;
    const agentProfileId = typeof body.agentProfileId === 'string' && body.agentProfileId.trim().length > 0
      ? body.agentProfileId.trim()
      : null;
    const allowedManagerNpubs = getOptionalStringArray(body.allowedManagerNpubs);
    const grantSharedService = body.grantSharedService === true;

    if (!rawPackage) {
      return Response.json({ error: 'packageJson or package is required.' }, { status: 400 });
    }

    try {
      const imported = await ctx.manager.importAgentConnectPackage({
        managedByNpub: scope.managerNpub,
        packageJson: rawPackage,
        agentProfileId,
        allowedManagerNpubs,
        grantSharedService,
      });
      return Response.json({
        backendConnection: serialiseBackendConnection(
          imported.backendConnection,
          scope.viewerNpub,
          ctx.manager.listBackendConnectionGrantsForManager(imported.backendConnection.backendConnectionId, scope.managerNpub),
        ),
        subscription: serialiseSubscription(
          imported.subscription,
          ctx.manager.listInterceptsForSubscription(imported.subscription.subscriptionId, scope.managerNpub),
          ctx.manager.listAgentsForWorkspaceBot(getEffectiveWorkspaceNpub(imported.subscription), imported.subscription.botNpub, scope.managerNpub),
          null,
          getProfileWorkspaceForSubscription(ctx.manager, imported.subscription.subscriptionId, scope.managerNpub),
          { canManage: scope.canManage, shared: scope.shared },
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Agent Connect import failed.');
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (url.pathname === '/api/agent-chat/subscriptions' && method === 'POST') {
    const denied = requireAgentChatManagement(scope);
    if (denied) {
      return denied;
    }
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const workspaceOwnerNpub = typeof body.workspaceOwnerNpub === 'string' ? body.workspaceOwnerNpub.trim() : '';
    const backendBaseUrl = typeof body.backendBaseUrl === 'string' ? body.backendBaseUrl.trim() : '';
    const sourceAppNpub = typeof body.sourceAppNpub === 'string' ? body.sourceAppNpub.trim() : '';
    const towerServiceNpub = typeof body.towerServiceNpub === 'string' && body.towerServiceNpub.trim().length > 0
      ? body.towerServiceNpub.trim()
      : null;
    const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim().length > 0
      ? body.workspaceId.trim()
      : null;
    const workspaceServiceNpub = typeof body.workspaceServiceNpub === 'string' && body.workspaceServiceNpub.trim().length > 0
      ? body.workspaceServiceNpub.trim()
      : null;
    const onboardingSource = body.onboardingSource === 'nostr_33357'
      ? 'nostr_33357'
      : body.onboardingSource === 'agent_connect_import'
        ? 'agent_connect_import'
        : undefined;
    const capabilityDefaults = parseDispatchCapabilities(body.capabilityDefaults);
    const backendConnectionId = typeof body.backendConnectionId === 'string' && body.backendConnectionId.trim().length > 0
      ? body.backendConnectionId.trim()
      : null;
    const backendConnectionGrantKind = body.backendConnectionGrantKind === 'shared_service'
      ? 'shared_service'
      : null;
    const sourceAppSchemaNamespace = typeof body.sourceAppSchemaNamespace === 'string' && body.sourceAppSchemaNamespace.trim().length > 0
      ? body.sourceAppSchemaNamespace.trim()
      : null;
    const triggerConfigRecordId = typeof body.triggerConfigRecordId === 'string' && body.triggerConfigRecordId.trim().length > 0
      ? body.triggerConfigRecordId.trim()
      : null;
    const agentProfileId = typeof body.agentProfileId === 'string' && body.agentProfileId.trim().length > 0
      ? body.agentProfileId.trim()
      : null;

    if (!backendConnectionId && (!workspaceOwnerNpub || !backendBaseUrl || !sourceAppNpub)) {
      return Response.json(
        { error: 'workspaceOwnerNpub, backendBaseUrl, and sourceAppNpub are required unless backendConnectionId has setup hints.' },
        { status: 400 },
      );
    }

    try {
      const subscription = await ctx.manager.createOrUpdate({
        managedByNpub: scope.managerNpub,
        workspaceOwnerNpub,
        towerServiceNpub,
        workspaceId,
        workspaceServiceNpub,
        backendBaseUrl,
        sourceAppNpub,
        onboardingSource,
        backendConnectionId,
        backendConnectionGrantKind,
        agentProfileId,
        sourceAppSchemaNamespace,
        capabilityDefaults,
        triggerConfigRecordId,
      });
      return Response.json({
        subscription: serialiseSubscription(
          subscription,
          ctx.manager.listInterceptsForSubscription(subscription.subscriptionId, scope.managerNpub),
          ctx.manager.listAgentsForWorkspaceBot(getEffectiveWorkspaceNpub(subscription), subscription.botNpub, scope.managerNpub),
          null,
          getProfileWorkspaceForSubscription(ctx.manager, subscription.subscriptionId, scope.managerNpub),
          { canManage: scope.canManage, shared: scope.shared },
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent Chat bootstrap failed.';
      return Response.json({ error: message }, { status: getAgentChatErrorStatus(error, 500) });
    }
  }

  if (url.pathname === '/api/agent-chat/agents' && method === 'POST') {
    const denied = requireAgentChatManagement(scope);
    if (denied) {
      return denied;
    }
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const botNpub = typeof body.botNpub === 'string' ? body.botNpub.trim() : '';
    const workspaceOwnerNpub = typeof body.workspaceOwnerNpub === 'string' ? body.workspaceOwnerNpub.trim() : '';
    const workingDirectory = typeof body.workingDirectory === 'string' ? body.workingDirectory.trim() : '';
    const harness = typeof body.harness === 'string' ? body.harness.trim() || null : null;
    const model = typeof body.model === 'string' ? body.model.trim() || null : null;
    const enabled = body.enabled !== false;
    const capabilityInput = Array.isArray(body.capabilities)
      ? body.capabilities.filter((value): value is string => typeof value === 'string')
      : [];
    const capabilities = capabilityInput.some((value) => (
      value === 'chat_intercept'
      || value === 'task_dispatch'
      || value === 'comment_dispatch'
      || value === 'flow_dispatch'
      || value === 'task_review'
      || value === 'approval_dispatch'
    ))
      ? [
          ...(capabilityInput.includes('chat_intercept') ? ['chat_intercept'] as const : []),
          ...(capabilityInput.includes('task_dispatch') ? ['task_dispatch'] as const : []),
          ...(capabilityInput.includes('comment_dispatch') ? ['comment_dispatch'] as const : []),
          ...(capabilityInput.includes('flow_dispatch') ? ['flow_dispatch'] as const : []),
          ...(capabilityInput.includes('task_review') ? ['task_review'] as const : []),
          ...(capabilityInput.includes('approval_dispatch') ? ['approval_dispatch'] as const : []),
        ]
      : ['chat_intercept'] as const;
    const chatPromptTemplate = typeof body.chatPromptTemplate === 'string' ? body.chatPromptTemplate : undefined;
    const taskPromptTemplate = typeof body.taskPromptTemplate === 'string' ? body.taskPromptTemplate : undefined;
    const flowDispatchPromptTemplate = typeof body.flowDispatchPromptTemplate === 'string'
      ? body.flowDispatchPromptTemplate
      : undefined;
    const taskReviewPromptTemplate = typeof body.taskReviewPromptTemplate === 'string'
      ? body.taskReviewPromptTemplate
      : undefined;
    const approvalDispatchPromptTemplate = typeof body.approvalDispatchPromptTemplate === 'string'
      ? body.approvalDispatchPromptTemplate
      : undefined;
    const directChatInput = body.directChat && typeof body.directChat === 'object' && !Array.isArray(body.directChat)
      ? body.directChat as Record<string, unknown>
      : null;
    const directChat = directChatInput ? {
      enabled: directChatInput.enabled === true,
      sessionAgent: typeof directChatInput.sessionAgent === 'string' ? directChatInput.sessionAgent.trim() || null : null,
      directory: typeof directChatInput.directory === 'string' ? directChatInput.directory.trim() : workingDirectory,
      model: typeof directChatInput.model === 'string' ? directChatInput.model.trim() || null : null,
      idleRetentionMinutes: Number.isFinite(Number(directChatInput.idleRetentionMinutes ?? 60))
        ? Math.max(1, Math.floor(Number(directChatInput.idleRetentionMinutes ?? 60)))
        : 60,
    } : undefined;

    if (
      directChat?.sessionAgent
      && ctx.agentTypes
      && !ctx.agentTypes.some((agentType) => agentType.id === directChat.sessionAgent)
    ) {
      return Response.json({ error: `Unknown agent harness: ${directChat.sessionAgent}.` }, { status: 400 });
    }

    if (!agentId || !botNpub || !workspaceOwnerNpub || !workingDirectory) {
      return Response.json(
        { error: 'agentId, botNpub, workspaceOwnerNpub, and workingDirectory are required.' },
        { status: 400 },
      );
    }

    try {
      const agent = await ctx.manager.saveAgentForManager({
        managedByNpub: scope.managerNpub,
        agentId,
        label,
        botNpub,
        workspaceOwnerNpub,
        workingDirectory,
        harness,
        model,
        archived: body.archived === true,
        publicProfile: body.publicProfile && typeof body.publicProfile === 'object' && !Array.isArray(body.publicProfile)
          ? {
              name: typeof (body.publicProfile as Record<string, unknown>).name === 'string'
                ? String((body.publicProfile as Record<string, unknown>).name).trim() || label : label,
              picture: typeof (body.publicProfile as Record<string, unknown>).picture === 'string'
                ? String((body.publicProfile as Record<string, unknown>).picture).trim() || null : null,
              about: typeof (body.publicProfile as Record<string, unknown>).about === 'string'
                ? String((body.publicProfile as Record<string, unknown>).about).trim() || null : null,
              nip05: typeof (body.publicProfile as Record<string, unknown>).nip05 === 'string'
                ? String((body.publicProfile as Record<string, unknown>).nip05).trim() || null : null,
            }
          : undefined,
        capabilities: [...capabilities],
        chatPromptTemplate,
        taskPromptTemplate,
        flowDispatchPromptTemplate,
        taskReviewPromptTemplate,
        approvalDispatchPromptTemplate,
        directChat,
        enabled,
      });
      return Response.json({ agent: serialiseAgent(agent) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save Agent Chat agent.';
      return Response.json({ error: message }, { status: 400 });
    }
  }

  const match = url.pathname.match(/^\/api\/agent-chat\/subscriptions\/([^/]+)$/);
  const profileWorkspaceMatch = url.pathname.match(/^\/api\/agent-chat\/subscriptions\/([^/]+)\/profile-workspace$/);
  const agentMatch = url.pathname.match(/^\/api\/agent-chat\/agents\/([^/]+)$/);
  const profileMatch = url.pathname.match(/^\/api\/agent-chat\/profiles\/([^/]+)$/);
  const profileDefaultMatch = url.pathname.match(/^\/api\/agent-chat\/profiles\/([^/]+)\/default$/);
  const profilePublishMatch = url.pathname.match(/^\/api\/agent-chat\/profiles\/([^/]+)\/publish$/);
  const profileRotateMatch = url.pathname.match(/^\/api\/agent-chat\/profiles\/([^/]+)\/rotate-key$/);
  const dispatchRouteMatch = url.pathname.match(/^\/api\/agent-chat\/dispatch-routes\/([^/]+)$/);
  const actionMatch = url.pathname.match(/^\/api\/agent-chat\/subscriptions\/([^/]+)\/actions\/([^/]+)$/);
  if (profileDefaultMatch && method === 'POST') {
    const denied = requireAgentChatManagement(scope);
    if (denied) return denied;
    const profileId = decodeURIComponent(profileDefaultMatch[1]!);
    try {
      const agent = ctx.manager.setDefaultAgentForManager(profileId, scope.managerNpub);
      return Response.json({ defaultAgentProfileId: agent.agentId, agent: serialiseAgent(agent) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to set default agent profile.';
      return Response.json({ error: message }, { status: message === 'Agent profile not found' ? 404 : 400 });
    }
  }
  if (profilePublishMatch && method === 'POST') {
    const denied = requireAgentChatManagement(scope);
    if (denied) return denied;
    const agentId = decodeURIComponent(profilePublishMatch[1]!);
    const agent = ctx.manager.getAgentForManager(agentId, scope.managerNpub);
    if (!agent) return Response.json({ error: 'Agent profile not found' }, { status: 404 });
    if (!ctx.republishAgentProfile) return Response.json({ error: 'Agent profile publishing is unavailable' }, { status: 503 });
    try {
      return Response.json({ published: true, publication: await ctx.republishAgentProfile(agent) });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Failed to publish agent profile.' }, { status: 400 });
    }
  }
  if (profileRotateMatch && method === 'POST') {
    const denied = requireAgentChatManagement(scope);
    if (denied) return denied;
    if (!ctx.rotateAgentProfileKey) return Response.json({ error: 'Agent key rotation is unavailable' }, { status: 503 });
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }
    const profileId = decodeURIComponent(profileRotateMatch[1]!);
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    const expectedCurrentNpub = typeof body.expectedCurrentNpub === 'string' ? body.expectedCurrentNpub.trim() : '';
    const confirmation = getObjectField(body, 'confirmation');
    try {
      const rotation = await ctx.rotateAgentProfileKey({
        requestId,
        profileId,
        managedByNpub: scope.managerNpub,
        expectedCurrentNpub,
        confirmationProfileId: typeof confirmation?.profileId === 'string' ? confirmation.profileId.trim() : '',
        confirmationCurrentNpub: typeof confirmation?.currentNpub === 'string' ? confirmation.currentNpub.trim() : '',
      });
      const status = rotation.state === 'failed_before_cutover' ? 409 : rotation.state === 'tower_commit_uncertain' ? 202 : 200;
      return Response.json({ rotation }, { status });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Agent key rotation failed.' }, { status: 400 });
    }
  }
  if (profileMatch && method === 'PATCH') {
    const denied = requireAgentChatManagement(scope);
    if (denied) return denied;
    const agentId = decodeURIComponent(profileMatch[1]!);
    const existing = ctx.manager.getAgentForManager(agentId, scope.managerNpub);
    if (!existing) return Response.json({ error: 'Agent profile not found' }, { status: 404 });
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }
    const directChatInput = body.directChat && typeof body.directChat === 'object' && !Array.isArray(body.directChat)
      ? body.directChat as Record<string, unknown>
      : null;
    const workingDirectory = typeof body.workingDirectory === 'string'
      ? body.workingDirectory
      : typeof directChatInput?.directory === 'string' ? directChatInput.directory : '';
    const harness = typeof body.harness === 'string'
      ? body.harness.trim()
      : typeof directChatInput?.sessionAgent === 'string' ? directChatInput.sessionAgent.trim() : '';
    const rawModel = Object.prototype.hasOwnProperty.call(body, 'model') ? body.model : directChatInput?.model;
    const requestedModel = typeof rawModel === 'string' ? rawModel.trim() || null : null;
    const model = requestedModel === 'default' ? null : requestedModel;
    const agentType = ctx.agentTypes?.find((item) => item.id === harness);
    if (!workingDirectory || !harness) {
      return Response.json({ error: 'workingDirectory and harness are required.' }, { status: 400 });
    }
    if (!isAbsolute(workingDirectory)) {
      return Response.json({ error: 'workingDirectory must be an absolute path.' }, { status: 400 });
    }
    try {
      await ctx.manager.validateAgentWorkingDirectory?.(workingDirectory);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Invalid workingDirectory.' }, { status: 400 });
    }
    if (ctx.agentTypes && !agentType) {
      return Response.json({ error: `Unknown agent harness: ${harness}.` }, { status: 400 });
    }
    if (model && agentType && !agentType.modelOptions?.includes(model)) {
      return Response.json({ error: `Model ${model} is not available for ${harness}.` }, { status: 400 });
    }
    const publicInput = body.publicProfile && typeof body.publicProfile === 'object' && !Array.isArray(body.publicProfile)
      ? body.publicProfile as Record<string, unknown>
      : {};
    const label = typeof body.label === 'string' ? body.label.trim() || existing.agentId : existing.label;
    const publicProfile = {
      name: typeof publicInput.name === 'string' ? publicInput.name.trim() || label : existing.publicProfile?.name || label,
      picture: typeof publicInput.picture === 'string' ? publicInput.picture.trim() || null : existing.publicProfile?.picture ?? null,
      about: typeof publicInput.about === 'string' ? publicInput.about.trim() || null : existing.publicProfile?.about ?? null,
      nip05: typeof publicInput.nip05 === 'string' ? publicInput.nip05.trim() || null : existing.publicProfile?.nip05 ?? null,
    };
    const publicChanged = JSON.stringify(publicProfile) !== JSON.stringify(existing.publicProfile ?? {
      name: existing.label, picture: null, about: null, nip05: null,
    });
    const candidate: AgentDefinitionRecord = {
      ...existing,
      label,
      workingDirectory,
      harness,
      model,
      enabled: body.enabled !== false,
      archived: typeof body.archived === 'boolean' ? body.archived : existing.archived,
      publicProfile,
      capabilities: Array.isArray(body.capabilities) ? parseDispatchCapabilities(body.capabilities) : existing.capabilities,
      directChat: {
        enabled: typeof body.directChatEnabled === 'boolean'
          ? body.directChatEnabled
          : directChatInput?.enabled !== false,
        sessionAgent: harness,
        directory: workingDirectory,
        model,
        idleRetentionMinutes: existing.directChat?.idleRetentionMinutes ?? 60,
      },
      chatPromptTemplate: typeof body.chatPromptTemplate === 'string' ? body.chatPromptTemplate : existing.chatPromptTemplate,
      taskPromptTemplate: typeof body.taskPromptTemplate === 'string' ? body.taskPromptTemplate : existing.taskPromptTemplate,
      flowDispatchPromptTemplate: typeof body.flowDispatchPromptTemplate === 'string' ? body.flowDispatchPromptTemplate : existing.flowDispatchPromptTemplate,
      taskReviewPromptTemplate: typeof body.taskReviewPromptTemplate === 'string' ? body.taskReviewPromptTemplate : existing.taskReviewPromptTemplate,
      approvalDispatchPromptTemplate: typeof body.approvalDispatchPromptTemplate === 'string' ? body.approvalDispatchPromptTemplate : existing.approvalDispatchPromptTemplate,
    };
    let publication: unknown = null;
    if (publicChanged) {
      if (!ctx.republishAgentProfile) {
        return Response.json({ error: 'Agent profile publishing is unavailable' }, { status: 503 });
      }
      try {
        publication = await ctx.republishAgentProfile(candidate);
        const published = publication as { eventId: string; createdAt: number };
        candidate.publicProfileRefresh = {
          lastAttemptAt: new Date().toISOString(),
          lastSuccessAt: new Date().toISOString(),
          sourceEventId: published.eventId,
          sourceEventCreatedAt: published.createdAt,
          result: 'published',
          error: null,
        };
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : 'Failed to publish agent profile.',
          code: 'agent_profile_publication_failed',
          published: false,
        }, { status: 502 });
      }
    }
    try {
      const agent = await ctx.manager.saveAgentForManager({
        ...candidate,
        managedByNpub: scope.managerNpub,
        unboundProfile: true,
        preserveValidatedWorkingDirectory: true,
      });
      return Response.json({ agent: serialiseAgent(agent), published: publicChanged, publication });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Failed to save agent profile.' }, { status: 400 });
    }
  }
  if (profileWorkspaceMatch && method === 'GET') {
    const subscriptionId = decodeURIComponent(profileWorkspaceMatch[1]!);
    const subscription = getSubscriptionForManager(ctx.manager, subscriptionId, scope.managerNpub);
    const bundle = getProfileWorkspaceForSubscription(ctx.manager, subscriptionId, scope.managerNpub);
    if (!bundle) {
      return Response.json({ error: 'Subscription not found' }, { status: 404 });
    }
    return Response.json({ profileWorkspace: serialiseProfileWorkspace(bundle, subscription) });
  }
  if (profileWorkspaceMatch && (method === 'POST' || method === 'PATCH')) {
    const denied = requireAgentChatManagement(scope);
    if (denied) {
      return denied;
    }
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }
    const subscriptionId = decodeURIComponent(profileWorkspaceMatch[1]!);
    try {
      const source = getObjectField(body, 'profileWorkspace') ?? body;
      const profileSource = getObjectField(source, 'profile');
      const workspaceSource = getObjectField(source, 'workspace');
      const saveInput: Parameters<typeof ctx.manager.saveProfileWorkspaceForManager>[0] = {
        subscriptionId,
        managedByNpub: scope.managerNpub,
        policies: parseProfileWorkspacePolicies(source.policies),
        pipelineOverrides: parseProfileWorkspacePipelineOverrides(source.pipelineOverrides),
        appendedContexts: parseProfileWorkspaceAppendedContexts(source.appendedContexts),
      };
      if (hasField(source, 'profileDefaultPipelineDefinitionId') || (profileSource && hasField(profileSource, 'defaultPipelineDefinitionId'))) {
        const value = hasField(source, 'profileDefaultPipelineDefinitionId')
          ? source.profileDefaultPipelineDefinitionId
          : profileSource?.defaultPipelineDefinitionId;
        saveInput.profileDefaultPipelineDefinitionId = typeof value === 'string'
          ? value
          : null;
      }
      if (hasField(source, 'profilePromptContext') || (profileSource && hasField(profileSource, 'promptContext'))) {
        const value = hasField(source, 'profilePromptContext') ? source.profilePromptContext : profileSource?.promptContext;
        saveInput.profilePromptContext = typeof value === 'string' ? value : null;
      }
      if (hasField(source, 'workspaceDefaultPipelineDefinitionId') || (workspaceSource && hasField(workspaceSource, 'defaultPipelineDefinitionId'))) {
        const value = hasField(source, 'workspaceDefaultPipelineDefinitionId')
          ? source.workspaceDefaultPipelineDefinitionId
          : workspaceSource?.defaultPipelineDefinitionId;
        saveInput.workspaceDefaultPipelineDefinitionId = typeof value === 'string'
          ? value
          : null;
      }
      if (hasField(source, 'workspaceContext') || (workspaceSource && hasField(workspaceSource, 'workspaceContext'))) {
        const value = hasField(source, 'workspaceContext') ? source.workspaceContext : workspaceSource?.workspaceContext;
        saveInput.workspaceContext = typeof value === 'string' ? value : null;
      }
      if (hasField(source, 'workspaceTitle') || (workspaceSource && hasField(workspaceSource, 'workspaceTitle'))) {
        const value = hasField(source, 'workspaceTitle') ? source.workspaceTitle : workspaceSource?.workspaceTitle;
        saveInput.workspaceTitle = typeof value === 'string' ? value : null;
      }
      if (hasField(source, 'duplicateCallbackMarker') || (workspaceSource && hasField(workspaceSource, 'duplicateCallbackMarker'))) {
        const value = hasField(source, 'duplicateCallbackMarker')
          ? source.duplicateCallbackMarker
          : workspaceSource?.duplicateCallbackMarker;
        saveInput.duplicateCallbackMarker = normaliseDuplicateCallbackMarker(value);
      }
      if (hasField(source, 'duplicateCallbackWindowSeconds')
        || (workspaceSource && hasField(workspaceSource, 'duplicateCallbackWindowSeconds'))) {
        const value = hasField(source, 'duplicateCallbackWindowSeconds')
          ? source.duplicateCallbackWindowSeconds
          : workspaceSource?.duplicateCallbackWindowSeconds;
        saveInput.duplicateCallbackWindowSeconds = normaliseDuplicateCallbackWindowSeconds(value);
      }
      const bundle = ctx.manager.saveProfileWorkspaceForManager(saveInput);
      const subscription = getSubscriptionForManager(ctx.manager, subscriptionId, scope.managerNpub);
      return Response.json({ profileWorkspace: serialiseProfileWorkspace(bundle, subscription) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save profile workspace settings.';
      return Response.json({ error: message }, { status: getAgentChatErrorStatus(error, 400) });
    }
  }
  if (dispatchRouteMatch && method === 'DELETE') {
    const denied = requireAgentChatManagement(scope);
    if (denied) {
      return denied;
    }
    const routeId = decodeURIComponent(dispatchRouteMatch[1]!);
    const removed = ctx.manager.deleteDispatchRouteForManager(routeId, scope.managerNpub);
    if (!removed) {
      return Response.json({ error: 'Dispatch route not found' }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  }
  if (actionMatch && method === 'POST') {
    const denied = requireAgentChatManagement(scope);
    if (denied) {
      return denied;
    }
    const subscriptionId = decodeURIComponent(actionMatch[1]!);
    const action = decodeURIComponent(actionMatch[2]!);
    try {
      let subscription: WorkspaceSubscriptionRecord | null = null;
      if (action === 'reconnect') {
        subscription = await ctx.manager.reconnectForManager(subscriptionId, scope.managerNpub);
      } else if (action === 'refresh-keys') {
        subscription = await ctx.manager.refreshKeysForManager(subscriptionId, scope.managerNpub);
      } else if (action === 'disable') {
        subscription = await ctx.manager.setEnabledForManager(subscriptionId, scope.managerNpub, false);
      } else if (action === 'enable') {
        subscription = await ctx.manager.setEnabledForManager(subscriptionId, scope.managerNpub, true);
      } else {
        return Response.json({ error: 'Unknown Agent Chat action' }, { status: 404 });
      }

      if (!subscription) {
        return Response.json({ error: 'Subscription not found' }, { status: 404 });
      }

      return Response.json({
        subscription: serialiseSubscription(
          subscription,
          ctx.manager.listInterceptsForSubscription(subscription.subscriptionId, scope.managerNpub),
          ctx.manager.listAgentsForWorkspaceBot(getEffectiveWorkspaceNpub(subscription), subscription.botNpub, scope.managerNpub),
          null,
          getProfileWorkspaceForSubscription(ctx.manager, subscription.subscriptionId, scope.managerNpub),
          { canManage: scope.canManage, shared: scope.shared },
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent Chat repair action failed.';
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (match && method === 'DELETE') {
    const denied = requireAgentChatManagement(scope);
    if (denied) {
      return denied;
    }
    const subscriptionId = decodeURIComponent(match[1]!);
    const subscription = ctx.manager.getForManager(subscriptionId, scope.managerNpub);
    if (!subscription) {
      return Response.json({ error: 'Subscription not found' }, { status: 404 });
    }
    if (subscription.onboardingSource === 'nostr_33357') {
      return Response.json(
        { error: 'Flight Deck onboarded workspace connections are managed by Flight Deck membership events.' },
        { status: 409 },
      );
    }
    const removed = ctx.manager.removeForManager(subscriptionId, scope.managerNpub);
    if (!removed) {
      return Response.json({ error: 'Subscription not found' }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  }

  if (match && method === 'GET') {
    const subscriptionId = decodeURIComponent(match[1]!);
    const subscription = ctx.manager.getForManager(subscriptionId, scope.managerNpub);
    if (!subscription) {
      return Response.json({ error: 'Subscription not found' }, { status: 404 });
    }
    return Response.json({
      subscription: serialiseSubscription(
        subscription,
        ctx.manager.listInterceptsForSubscription(subscription.subscriptionId, scope.managerNpub),
        ctx.manager.listAgentsForWorkspaceBot(getEffectiveWorkspaceNpub(subscription), subscription.botNpub, scope.managerNpub),
        null,
        getProfileWorkspaceForSubscription(ctx.manager, subscription.subscriptionId, scope.managerNpub),
        { canManage: scope.canManage, shared: scope.shared },
      ),
    });
  }

  if (agentMatch && method === 'DELETE') {
    const denied = requireAgentChatManagement(scope);
    if (denied) {
      return denied;
    }
    const agentId = decodeURIComponent(agentMatch[1]!);
    const removed = ctx.manager.removeAgentForManager(agentId, scope.managerNpub);
    if (!removed) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}

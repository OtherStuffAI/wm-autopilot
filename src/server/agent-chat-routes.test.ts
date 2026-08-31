import { describe, expect, test } from 'bun:test';

import type { RequestAuthContext } from '../auth/request-context';
import {
  BackendConnectionNotFoundError,
  WorkspaceSubscriptionAccessError,
  type WorkspaceSubscriptionManager,
} from '../agent-chat/subscription-runtime';
import type { BackendConnectionRecord, WorkspaceSubscriptionRecord } from '../agent-chat/types';
import type { AgentProfileWorkspaceBundle } from '../agent-chat/agent-profile-policy-store';
import { handleAgentChatApi } from './agent-chat-routes';

const authContext: RequestAuthContext = {
  npub: 'npub1manager',
  session: null,
};

const adminAuthContext: RequestAuthContext = {
  npub: 'npub1admin',
  session: null,
};

function makeSubscription(overrides: Partial<WorkspaceSubscriptionRecord> = {}): WorkspaceSubscriptionRecord {
  const now = new Date().toISOString();
  return {
    subscriptionId: 'sub-1',
    backendConnectionId: 'backend-owned',
    workspaceOwnerNpub: 'npub1workspace',
    backendBaseUrl: 'https://tower.example.com',
    botNpub: 'npub1bot',
    sourceAppNpub: 'npub1sourceapp',
    wsKeyNpub: 'npub1wskey',
    wsKeyStatus: 'active',
    groupKeyStatus: 'active',
    sseStatus: 'connected',
    healthStatus: 'healthy',
    triggerConfigRecordId: null,
    lastSseEventId: null,
    lastAuthOkAt: now,
    lastGroupRefreshAt: now,
    lastErrorCode: null,
    lastErrorAt: null,
    createdAt: now,
    updatedAt: now,
    managedByNpub: 'npub1manager',
    wsKeyBlobJson: null,
    wrappedGroupKeysJson: null,
    lastAuthResult: null,
    lastGroupRefreshResult: null,
    lastRecordPullResult: null,
    lastDecryptResult: null,
    lastRoutingResult: null,
    lastSseEvent: null,
    recentSseEvents: [],
    recentDispatches: [],
    lastSuccessfulStartupReloadAt: null,
    ...overrides,
  };
}

function buildManager(createOrUpdate: WorkspaceSubscriptionManager['createOrUpdate']): WorkspaceSubscriptionManager {
  return {
    createOrUpdate,
    listInterceptsForSubscription: () => [],
    listAgentsForWorkspaceBot: () => [],
  } as unknown as WorkspaceSubscriptionManager;
}

function makeBackendConnection(overrides: Partial<BackendConnectionRecord> = {}): BackendConnectionRecord {
  const now = new Date().toISOString();
  return {
    backendConnectionId: 'backend-owned',
    managedByNpub: 'npub1manager',
    backendBaseUrl: 'https://tower.example.com',
    serviceNpub: 'npub1service',
    setupWorkspaceOwnerNpub: 'npub1workspace',
    setupSourceAppNpub: 'npub1sourceapp',
    setupSourceAppSchemaNamespace: 'cowork',
    setupConnectionTokenRef: null,
    setupCapabilityDefaults: ['chat_intercept'],
    relayUrls: [],
    openapiUrl: null,
    docsUrl: null,
    healthUrl: null,
    supportedVersion: '5',
    sharePolicy: 'selected_users',
    healthStatus: 'healthy',
    lastHealthResult: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProfileWorkspaceBundle(overrides: Partial<AgentProfileWorkspaceBundle> = {}): AgentProfileWorkspaceBundle {
  const now = new Date().toISOString();
  const bundle: AgentProfileWorkspaceBundle = {
    profile: {
      profileId: 'agent-profile-1',
      managedByNpub: 'npub1manager',
      agentNpub: 'npub1bot',
      label: 'Agent Profile',
      defaultPipelineDefinitionId: 'profile-pipeline',
      promptContext: 'Profile context',
      createdAt: now,
      updatedAt: now,
    },
    workspace: {
      profileWorkspaceId: 'profile-workspace-1',
      profileId: 'agent-profile-1',
      managedByNpub: 'npub1manager',
      subscriptionId: 'sub-1',
      backendConnectionId: 'backend-owned',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1sourceapp',
      backendBaseUrl: 'https://tower.example.com',
      towerServiceNpub: 'npub1service',
      workspaceId: 'workspace-1',
      workspaceServiceNpub: 'npub1workspaceservice',
      workspaceTitle: 'Workspace',
      appPubkey: 'app-pub',
      towerUrl: 'https://tower.example.com',
      connectionHealth: 'healthy',
      yokeSyncStatus: 'synced',
      relayOnboardingStatus: 'ready',
      defaultPipelineDefinitionId: 'workspace-pipeline',
      workspaceContext: 'Workspace context',
      duplicateCallbackMarker: 'duplicate callback:',
      duplicateCallbackWindowSeconds: 180,
      createdAt: now,
      updatedAt: now,
    },
    policies: [
      {
        profileWorkspaceId: 'profile-workspace-1',
        eventType: 'chat_mention',
        enabled: true,
        defaultAction: 'respond',
        pipelineDefinitionId: null,
        pipelineVersionPolicy: 'latest',
        promptContext: null,
        quietMode: false,
        lastDiagnostic: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    pipelineOverrides: [],
    appendedContexts: [],
  };
  return { ...bundle, ...overrides };
}

async function postSubscription(manager: WorkspaceSubscriptionManager, backendConnectionId: string) {
  const request = new Request('http://localhost/api/agent-chat/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId,
      agentProfileId: 'wm-one',
    }),
  });
  return await handleAgentChatApi(
    request,
    new URL(request.url),
    'POST',
    authContext,
    { manager },
  );
}

async function postSharedSubscription(
  manager: WorkspaceSubscriptionManager,
  auth: RequestAuthContext,
) {
  const request = new Request('http://localhost/api/agent-chat/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
    }),
  });
  return await handleAgentChatApi(
    request,
    new URL(request.url),
    'POST',
    auth,
    {
      manager,
      adminNpub: 'npub1admin',
      sharedAgentDispatch: true,
      isAdminContext: (context) => context.npub === 'npub1admin',
    },
  );
}

describe('agent-chat routes', () => {
  test('returns a server-backed Flight Deck dispatch outcome page', async () => {
    const manager = {
      listDispatchOutcomesForManager: (npub: string, page: { limit: number; offset: number }) => ({
        rows: [{
          actionId: 'session-1', workspaceName: 'Example Operator', sourceLabel: 'Dispatch review',
          reasonCode: 'recent_duplicate', reasonLabel: 'Recent duplicate',
        }],
        total: 80,
        ...page,
        managerNpub: npub,
      }),
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/dispatch-outcomes?limit=25&offset=50&includeIgnoredAndSuppressed=true');
    const response = await handleAgentChatApi(request, new URL(request.url), 'GET', authContext, { manager });
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body).toMatchObject({
      total: 80,
      limit: 25,
      offset: 50,
      includeIgnoredAndSuppressed: true,
      managerNpub: 'npub1manager',
    });
    expect(body.rows[0]).toMatchObject({
      actionId: 'session-1', workspaceName: 'Example Operator', sourceLabel: 'Dispatch review',
      reasonCode: 'recent_duplicate', reasonLabel: 'Recent duplicate',
    });
  });

  test('requires authentication for Flight Deck dispatch outcomes', async () => {
    const manager = {} as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/dispatch-outcomes');
    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      { npub: null, session: null },
      { manager },
    );
    expect(response?.status).toBe(401);
  });

  test('maps foreign backendConnectionId failures to 403', async () => {
    const manager = buildManager(async () => {
      throw new WorkspaceSubscriptionAccessError('Backend connection is not available to this manager.');
    });

    const response = await postSubscription(manager, 'backend-foreign');
    const body = await response!.json();

    expect(response?.status).toBe(403);
    expect(body.error).toContain('not available');
  });

  test('maps missing backendConnectionId failures to 404', async () => {
    const manager = buildManager(async () => {
      throw new BackendConnectionNotFoundError('Backend connection missing-backend was not found.');
    });

    const response = await postSubscription(manager, 'missing-backend');
    const body = await response!.json();

    expect(response?.status).toBe(404);
    expect(body.error).toContain('was not found');
  });

  test('returns a subscription for owned backendConnectionId saves', async () => {
    const manager = buildManager(async () => makeSubscription());

    const response = await postSubscription(manager, 'backend-owned');
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.subscription.backendConnectionId).toBe('backend-owned');
    expect(body.subscription.backend.backendConnectionId).toBe('backend-owned');
  });

  test('passes Flight Deck PG workspace fields when creating a subscription', async () => {
    let captured: Parameters<WorkspaceSubscriptionManager['createOrUpdate']>[0] | null = null;
    const manager = buildManager(async (input) => {
      captured = input;
      return makeSubscription({
        subscriptionId: 'sub-flightdeck-pg',
        workspaceOwnerNpub: input.workspaceOwnerNpub,
        towerServiceNpub: input.towerServiceNpub ?? null,
        workspaceId: input.workspaceId ?? null,
        workspaceServiceNpub: input.workspaceServiceNpub ?? null,
        sourceAppNpub: input.sourceAppNpub,
        onboardingSource: input.onboardingSource ?? 'manual',
        capabilityDefaults: input.capabilityDefaults ?? [],
      });
    });
    const request = new Request('http://localhost/api/agent-chat/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backendConnectionId: 'backend-owned',
        workspaceOwnerNpub: 'npub1workspaceowner',
        towerServiceNpub: 'npub1tower',
        workspaceId: 'workspace-pg-1',
        workspaceServiceNpub: 'npub1workspaceservice',
        backendBaseUrl: 'https://tower.example.com',
        sourceAppNpub: 'npub1sourceapp',
        onboardingSource: 'nostr_33357',
        capabilityDefaults: ['chat_intercept', 'task_dispatch', 'not-real'],
      }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'POST',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(captured).toMatchObject({
      managedByNpub: 'npub1manager',
      backendConnectionId: 'backend-owned',
      workspaceOwnerNpub: 'npub1workspaceowner',
      towerServiceNpub: 'npub1tower',
      workspaceId: 'workspace-pg-1',
      workspaceServiceNpub: 'npub1workspaceservice',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
      onboardingSource: 'nostr_33357',
      capabilityDefaults: ['chat_intercept', 'task_dispatch'],
    });
    expect(body.subscription.workspaceId).toBe('workspace-pg-1');
    expect(body.subscription.workspaceServiceNpub).toBe('npub1workspaceservice');
    expect(body.subscription.onboardingSource).toBe('nostr_33357');
  });

  test('returns safe setup hints for available backend connections', async () => {
    const manager = {
      listBackendConnectionsForManager: () => [makeBackendConnection()],
      listBackendConnectionGrantsForManager: () => [
        {
          backendConnectionId: 'backend-owned',
          grantKind: 'manager_npub',
          granteeNpub: 'npub1other',
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
        },
      ],
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/backend-connections');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.backendConnections[0].backendConnectionId).toBe('backend-owned');
    expect(body.backendConnections[0].setupWorkspaceOwnerNpub).toBe('npub1workspace');
    expect(body.backendConnections[0].setupSourceAppNpub).toBe('npub1sourceapp');
    expect(body.backendConnections[0].setupCapabilityDefaults).toEqual(['chat_intercept']);
    expect(body.backendConnections[0].availabilityGrants[0].granteeNpub).toBe('npub1other');
    expect(body.backendConnections[0].operator.canManageAvailability).toBe(true);
  });

  test('updates backend connection availability grants for the owner', async () => {
    const manager = {
      updateBackendConnectionAvailabilityForManager: (input: {
        backendConnectionId: string;
        managedByNpub: string;
        managerNpubs?: string[];
        sharedService?: boolean;
      }) => {
        expect(input.backendConnectionId).toBe('backend-owned');
        expect(input.managedByNpub).toBe('npub1manager');
        expect(input.managerNpubs).toEqual(['npub1other']);
        expect(input.sharedService).toBe(true);
        return {
          backendConnection: makeBackendConnection({ sharePolicy: 'shared_service' }),
          grants: [
            {
              backendConnectionId: 'backend-owned',
              grantKind: 'manager_npub' as const,
              granteeNpub: 'npub1other',
              createdAt: '2026-05-08T00:00:00.000Z',
              updatedAt: '2026-05-08T00:00:00.000Z',
            },
            {
              backendConnectionId: 'backend-owned',
              grantKind: 'shared_service' as const,
              granteeNpub: null,
              createdAt: '2026-05-08T00:00:00.000Z',
              updatedAt: '2026-05-08T00:00:00.000Z',
            },
          ],
        };
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/backend-connections/backend-owned/availability', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowedManagerNpubs: ['npub1other'],
        grantSharedService: true,
      }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'PATCH',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.backendConnection.sharePolicy).toBe('shared_service');
    expect(body.backendConnection.availabilityGrants).toHaveLength(2);
  });

  test('maps backend availability ownership failures to 403', async () => {
    const manager = {
      updateBackendConnectionAvailabilityForManager: () => {
        throw Object.assign(new Error('Only the backend connection owner can manage availability.'), { statusCode: 403 });
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/backend-connections/backend-foreign/availability', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowedManagerNpubs: ['npub1other'] }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'PATCH',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(403);
    expect(body.error).toContain('Only the backend connection owner');
  });

  test('returns profile workspace settings for a managed subscription', async () => {
    const manager = {
      getForManager: () => makeSubscription({
        lastRoutingResult: {
          ok: true,
          code: null,
          message: 'Routed.',
          at: '2026-06-06T00:00:00.000Z',
          details: {
            scope_id: 'scope-autopilot',
            channel_id: 'channel-design',
          },
        },
      }),
      getProfileWorkspaceForManager: (subscriptionId: string, npub: string) => {
        expect(subscriptionId).toBe('sub-1');
        expect(npub).toBe('npub1manager');
        return makeProfileWorkspaceBundle({
          appendedContexts: [
            {
              profileWorkspaceId: 'profile-workspace-1',
              contextKind: 'scope',
              targetId: 'scope-configured',
              eventType: null,
              contextText: 'Configured scope context',
              createdAt: '2026-06-06T00:00:00.000Z',
              updatedAt: '2026-06-06T00:00:00.000Z',
            },
          ],
        });
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/sub-1/profile-workspace');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.profileWorkspace.workspace.profileWorkspaceId).toBe('profile-workspace-1');
    expect(body.profileWorkspace.workspace.duplicateCallbackMarker).toBe('duplicate callback:');
    expect(body.profileWorkspace.workspace.duplicateCallbackWindowSeconds).toBe(180);
    expect(body.profileWorkspace.policies[0].eventType).toBe('chat_mention');
    expect(body.profileWorkspace.visibleContext.scopes.map((scope: { id: string }) => scope.id)).toEqual([
      'scope-configured',
      'scope-autopilot',
    ]);
    expect(body.profileWorkspace.visibleContext.channels).toEqual([
      {
        id: 'channel-design',
        label: 'channel-design',
        source: 'last_routing',
        scopeId: 'scope-autopilot',
      },
    ]);
  });

  test('maps missing profile workspace settings to 404', async () => {
    const manager = {
      getProfileWorkspaceForManager: () => null,
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/missing/profile-workspace');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(404);
    expect(body.error).toContain('Subscription not found');
  });

  test('saves profile workspace flat payloads with clears and scope rows', async () => {
    let captured: Parameters<WorkspaceSubscriptionManager['saveProfileWorkspaceForManager']>[0] | null = null;
    const manager = {
      saveProfileWorkspaceForManager: (input: Parameters<WorkspaceSubscriptionManager['saveProfileWorkspaceForManager']>[0]) => {
        captured = input;
        return makeProfileWorkspaceBundle({
          workspace: {
            ...makeProfileWorkspaceBundle().workspace,
            defaultPipelineDefinitionId: 'workspace-pipeline-2',
            workspaceContext: null,
            duplicateCallbackMarker: '  repeat response:',
            duplicateCallbackWindowSeconds: 45,
          },
          pipelineOverrides: [
            {
              profileWorkspaceId: 'profile-workspace-1',
              targetKind: 'scope',
              targetId: 'scope-autopilot',
              pipelineDefinitionId: 'scope-pipeline',
              createdAt: '2026-06-06T00:00:00.000Z',
              updatedAt: '2026-06-06T00:00:00.000Z',
            },
          ],
          appendedContexts: [
            {
              profileWorkspaceId: 'profile-workspace-1',
              contextKind: 'channel',
              targetId: 'channel-design',
              eventType: null,
              contextText: 'Channel context',
              createdAt: '2026-06-06T00:00:00.000Z',
              updatedAt: '2026-06-06T00:00:00.000Z',
            },
          ],
        });
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/sub-1/profile-workspace', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileDefaultPipelineDefinitionId: null,
        profilePromptContext: null,
        workspaceDefaultPipelineDefinitionId: 'workspace-pipeline-2',
        workspaceContext: null,
        duplicateCallbackMarker: '  repeat response:',
        duplicateCallbackWindowSeconds: '45',
        policies: [
          {
            eventType: 'chat_mention',
            enabled: false,
            defaultAction: 'ignore',
            pipelineDefinitionId: null,
            promptContext: null,
            quietMode: true,
          },
        ],
        pipelineOverrides: [
          { targetKind: 'scope', targetId: 'scope-autopilot', pipelineDefinitionId: 'scope-pipeline' },
          { targetKind: 'channel', targetId: '', pipelineDefinitionId: 'ignored' },
        ],
        appendedContexts: [
          { contextKind: 'channel', targetId: 'channel-design', contextText: 'Channel context' },
          { contextKind: 'scope', targetId: 'scope-empty', contextText: '' },
        ],
      }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'PATCH',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(captured).toMatchObject({
      subscriptionId: 'sub-1',
      managedByNpub: 'npub1manager',
      profileDefaultPipelineDefinitionId: null,
      profilePromptContext: null,
      workspaceDefaultPipelineDefinitionId: 'workspace-pipeline-2',
      workspaceContext: null,
      duplicateCallbackMarker: '  repeat response:',
      duplicateCallbackWindowSeconds: 45,
    });
    expect(captured?.policies).toEqual([
      {
        eventType: 'chat_mention',
        enabled: false,
        defaultAction: 'ignore',
        pipelineDefinitionId: null,
        pipelineVersionPolicy: 'latest',
        promptContext: null,
        quietMode: true,
      },
    ]);
    expect(captured?.pipelineOverrides).toEqual([
      {
        targetKind: 'scope',
        targetId: 'scope-autopilot',
        pipelineDefinitionId: 'scope-pipeline',
        pipelineVersionPolicy: 'latest',
      },
    ]);
    expect(captured?.appendedContexts).toEqual([
      { contextKind: 'channel', targetId: 'channel-design', eventType: null, contextText: 'Channel context' },
      { contextKind: 'scope', targetId: 'scope-empty', eventType: null, contextText: '' },
    ]);
    expect(body.profileWorkspace.workspace.defaultPipelineDefinitionId).toBe('workspace-pipeline-2');
    expect(body.profileWorkspace.workspace.duplicateCallbackMarker).toBe('  repeat response:');
    expect(body.profileWorkspace.workspace.duplicateCallbackWindowSeconds).toBe(45);
    expect(body.profileWorkspace.pipelineOverrides[0].targetId).toBe('scope-autopilot');
  });

  test('rejects invalid duplicate callback routing settings', async () => {
    const manager = {
      saveProfileWorkspaceForManager: () => makeProfileWorkspaceBundle(),
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/sub-1/profile-workspace', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duplicateCallbackWindowSeconds: '-1' }),
    });

    const response = await handleAgentChatApi(request, new URL(request.url), 'PATCH', authContext, { manager });
    expect(response?.status).toBe(400);
    expect((await response!.json()).error).toContain('non-negative whole number');
  });

  test('saves nested profile workspace payloads sparsely and supports explicit replacement clears', async () => {
    let captured: Parameters<WorkspaceSubscriptionManager['saveProfileWorkspaceForManager']>[0] | null = null;
    const manager = {
      saveProfileWorkspaceForManager: (input: Parameters<WorkspaceSubscriptionManager['saveProfileWorkspaceForManager']>[0]) => {
        captured = input;
        return makeProfileWorkspaceBundle({ pipelineOverrides: [], appendedContexts: [] });
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/sub-1/profile-workspace', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileWorkspace: {
          profile: { promptContext: 'Nested profile context' },
          workspace: { workspaceContext: 'Nested workspace context' },
          policies: [{ eventType: 'task_assigned', enabled: true }],
          pipelineOverrides: [],
          appendedContexts: [],
        },
      }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'PATCH',
      authContext,
      { manager },
    );

    expect(response?.status).toBe(200);
    expect(captured?.profilePromptContext).toBe('Nested profile context');
    expect(captured?.workspaceContext).toBe('Nested workspace context');
    expect('profileDefaultPipelineDefinitionId' in (captured ?? {})).toBe(false);
    expect('workspaceDefaultPipelineDefinitionId' in (captured ?? {})).toBe(false);
    expect(captured?.policies).toEqual([{
      eventType: 'task_assigned',
      enabled: true,
      defaultAction: undefined,
      pipelineDefinitionId: undefined,
      pipelineVersionPolicy: 'latest',
      promptContext: undefined,
      quietMode: undefined,
    }]);
    expect(captured?.pipelineOverrides).toEqual([]);
    expect(captured?.appendedContexts).toEqual([]);
  });

  test('denies non-admin profile workspace saves in shared dispatch mode', async () => {
    const manager = {
      saveProfileWorkspaceForManager: () => {
        throw new Error('save should not be called');
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/sub-1/profile-workspace', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceContext: 'blocked' }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'PATCH',
      authContext,
      {
        manager,
        adminNpub: 'npub1admin',
        sharedAgentDispatch: true,
        isAdminContext: () => false,
      },
    );
    const body = await response!.json();

    expect(response?.status).toBe(403);
    expect(body.error).toContain('Ask an administrator');
  });

  test('shared agent dispatch lists admin-managed subscriptions for non-admin viewers', async () => {
    const manager = {
      listBackendConnectionsForManager: (npub: string) => {
        expect(npub).toBe('npub1admin');
        return [makeBackendConnection({ managedByNpub: 'npub1admin' })];
      },
      listForManager: (npub: string) => {
        expect(npub).toBe('npub1admin');
        return [makeSubscription({ managedByNpub: 'npub1admin' })];
      },
      listInterceptsForSubscription: (_subscriptionId: string, npub: string) => {
        expect(npub).toBe('npub1admin');
        return [];
      },
      listAgentsForWorkspaceBot: (_workspaceOwnerNpub: string, _botNpub: string, npub: string) => {
        expect(npub).toBe('npub1admin');
        return [];
      },
      listBackendConnectionGrantsForManager: () => {
        throw new Error('non-admin viewers should not receive backend availability grants');
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      {
        manager,
        adminNpub: 'npub1admin',
        sharedAgentDispatch: true,
        isAdminContext: () => false,
      },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.permissions).toEqual({ shared: true, canManage: false });
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].managedByNpub).toBe('npub1admin');
    expect(body.subscriptions[0].operator.canManage).toBe(false);
    expect(body.subscriptions[0].operator.shared).toBe(true);
  });

  test('lists every subscription with backend display information', async () => {
    const manager = {
      listBackendConnectionsForManager: () => [
        makeBackendConnection({
          backendConnectionId: 'backend-one',
          backendBaseUrl: 'https://tower-one.example.com',
          serviceNpub: 'npub1serviceone',
          lastHealthResult: {
            ok: true,
            code: 'backend_healthy',
            message: 'ok',
            at: '2026-05-20T00:00:00.000Z',
            details: { response: { tower_name: 'Tower One' } },
          },
        }),
        makeBackendConnection({
          backendConnectionId: 'backend-two',
          backendBaseUrl: 'https://tower-two.example.com',
          serviceNpub: 'npub1servicetwo',
        }),
      ],
      listForManager: () => [
        makeSubscription({
          subscriptionId: 'sub-one',
          backendConnectionId: 'backend-one',
          backendBaseUrl: 'https://tower-one.example.com',
        }),
        makeSubscription({
          subscriptionId: 'sub-two',
          backendConnectionId: 'backend-two',
          backendBaseUrl: 'https://tower-two.example.com',
        }),
      ],
      listInterceptsForSubscription: () => [],
      listAgentsForWorkspaceBot: () => [],
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.subscriptions).toHaveLength(2);
    expect(body.subscriptions.map((subscription: any) => subscription.subscriptionId)).toEqual(['sub-one', 'sub-two']);
    expect(body.subscriptions[0].backend).toMatchObject({
      backendConnectionId: 'backend-one',
      backendBaseUrl: 'https://tower-one.example.com',
      serviceNpub: 'npub1serviceone',
      workspaceName: 'Tower One',
    });
    expect(body.subscriptions[1].backend).toMatchObject({
      backendConnectionId: 'backend-two',
      backendBaseUrl: 'https://tower-two.example.com',
      serviceNpub: 'npub1servicetwo',
    });
  });

  test('lists dispatch routes scoped to the requested subscription', async () => {
    const manager = {
      listDispatchRoutesForSubscription: (subscriptionId: string, npub: string) => {
        expect(subscriptionId).toBe('sub-two');
        expect(npub).toBe('npub1manager');
        return [
          {
            routeId: 'route-two',
            managedByNpub: 'npub1manager',
            subscriptionId: 'sub-two',
            workspaceOwnerNpub: 'npub1workspace',
            botNpub: 'npub1bot',
            sourceAppNpub: 'npub1sourceapp',
            triggerKind: 'chat',
            capability: 'chat_intercept',
            pipelineDefinitionId: 'pipeline-two',
            enabled: true,
            priority: 100,
            matchJson: {},
            inputTemplateJson: {},
            concurrencyKeyTemplate: '${workspace.subscriptionId}:${routing.threadId}:${route.routeId}',
            activePolicy: 'queue',
            dedupeWindowSeconds: 60,
            createdAt: '2026-05-20T00:00:00.000Z',
            updatedAt: '2026-05-20T00:00:00.000Z',
          },
        ];
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/dispatch-routes?subscriptionId=sub-two');

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'GET',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.dispatchRoutes).toHaveLength(1);
    expect(body.dispatchRoutes[0].subscriptionId).toBe('sub-two');
  });

  test('saves dispatch routes through the requested subscription scope', async () => {
    const manager = {
      saveDispatchRouteForManager: (input: any) => {
        expect(input.managedByNpub).toBe('npub1manager');
        expect(input.subscriptionId).toBe('sub-two');
        expect(input.triggerKind).toBe('task');
        expect(input.capability).toBe('task_dispatch');
        return {
          routeId: 'route-two',
          managedByNpub: input.managedByNpub,
          subscriptionId: input.subscriptionId,
          workspaceOwnerNpub: 'npub1workspace',
          botNpub: 'npub1bot',
          sourceAppNpub: 'npub1sourceapp',
          triggerKind: input.triggerKind,
          capability: input.capability,
          pipelineDefinitionId: input.pipelineDefinitionId,
          enabled: true,
          priority: 100,
          matchJson: {},
          inputTemplateJson: {},
          concurrencyKeyTemplate: '${workspace.subscriptionId}:${record.recordId}:${route.routeId}',
          activePolicy: 'skip',
          dedupeWindowSeconds: 60,
          createdAt: '2026-05-20T00:00:00.000Z',
          updatedAt: '2026-05-20T00:00:00.000Z',
        };
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/dispatch-routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriptionId: 'sub-two',
        triggerKind: 'task',
        capability: 'task_dispatch',
        pipelineDefinitionId: 'pipeline-two',
      }),
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'POST',
      authContext,
      { manager },
    );
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.dispatchRoute.subscriptionId).toBe('sub-two');
  });

  test('shared agent dispatch blocks non-admin subscription writes', async () => {
    const manager = {
      createOrUpdate: () => {
        throw new Error('non-admin writes should be blocked before manager calls');
      },
    } as unknown as WorkspaceSubscriptionManager;

    const response = await postSharedSubscription(manager, authContext);
    const body = await response!.json();

    expect(response?.status).toBe(403);
    expect(body.error).toContain('shared');
  });

  test('shared agent dispatch writes as the admin manager for admins', async () => {
    const manager = buildManager(async (input) => {
      expect(input.managedByNpub).toBe('npub1admin');
      return makeSubscription({ managedByNpub: 'npub1admin' });
    });

    const response = await postSharedSubscription(manager, adminAuthContext);
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(body.subscription.managedByNpub).toBe('npub1admin');
    expect(body.subscription.operator.canManage).toBe(true);
    expect(body.subscription.operator.shared).toBe(true);
  });

  test('creates a profile with a generated identity and returns no signing secret', async () => {
    const now = new Date().toISOString();
    const agent = {
      agentId: 'Builder21', label: 'Builder', botNpub: 'npub1Builder', workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: [], workingDirectory: '/Users/example/wingmen/Builder21', harness: 'goose', model: null,
      publicProfile: { name: 'Builder', picture: null, about: 'Builder', nip05: null }, capabilities: ['chat_intercept'],
      enabled: true, createdAt: now, updatedAt: now, managedByNpub: 'npub1manager',
    } as const;
    const signedProfileEvent = { id: 'event-1', pubkey: '00'.repeat(32), created_at: 1, kind: 0, tags: [], content: '{}', sig: '11'.repeat(64) };
    const manager = {
      createAgentProfileForManager: async (input: Record<string, unknown>) => {
        expect(input).toMatchObject({
          agentId: 'Builder21',
          harness: 'goose',
          managedByNpub: 'npub1manager',
          workspaceOwnerNpub: 'npub1manager',
        });
        return { agent, signedProfileEvent };
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'Builder21', label: 'Builder', workingDirectory: '/Users/example/wingmen/Builder21', harness: 'goose', about: 'Builder' }),
    });
    const response = await handleAgentChatApi(request, new URL(request.url), 'POST', authContext, {
      manager,
      agentTypes: [{ id: 'goose', label: 'Goose' }],
      publishAgentProfile: async ({ event }) => ({ eventId: event.id, published: 1 }),
    });
    const body = await response!.json() as Record<string, unknown>;
    expect(response?.status).toBe(201);
    expect(JSON.stringify(body)).toContain('npub1Builder');
    expect(JSON.stringify(body)).not.toMatch(/nsec|encryptedEscrow|botSecret|WINGMAN_CAPABILITY/i);
  });

  test('rotates a profile key only for a manager with bound confirmation', async () => {
    let received: Record<string, unknown> | null = null;
    const request = new Request('http://localhost/api/agent-chat/profiles/Builder21/rotate-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'rotation-request-1', expectedCurrentNpub: 'npub1old', confirmation: { profileId: 'Builder21', currentNpub: 'npub1old' } }),
    });
    const response = await handleAgentChatApi(request, new URL(request.url), 'POST', authContext, {
      manager: {} as WorkspaceSubscriptionManager,
      rotateAgentProfileKey: async (input) => {
        received = input;
        return { rotationId: 'r1', requestId: input.requestId, profileId: input.profileId, oldNpub: input.expectedCurrentNpub, newNpub: 'npub1new', startedAt: 'now', completedAt: 'now', state: 'completed', publication: { status: 'published' }, migrations: [], externalActions: [], warnings: [], revokedCapabilityCount: 1, oldSessionsNeedReplacement: true };
      },
    });
    expect(response?.status).toBe(200);
    expect(received).toMatchObject({ profileId: 'Builder21', managedByNpub: 'npub1manager', confirmationProfileId: 'Builder21', confirmationCurrentNpub: 'npub1old' });
    expect(JSON.stringify(await response!.json())).not.toMatch(/nsec|private|secret/i);
  });

  test('denies non-admin rotation on shared agent dispatch', async () => {
    let called = false;
    const request = new Request('http://localhost/api/agent-chat/profiles/Builder21/rotate-key', { method: 'POST', body: '{}' });
    const response = await handleAgentChatApi(request, new URL(request.url), 'POST', authContext, {
      manager: {} as WorkspaceSubscriptionManager,
      adminNpub: 'npub1admin', sharedAgentDispatch: true, isAdminContext: () => false,
      rotateAgentProfileKey: async () => { called = true; throw new Error('must not run'); },
    });
    expect(response?.status).toBe(403);
    expect(called).toBe(false);
  });

  test('updates local profile runtime without publication and preserves identity and directory', async () => {
    const now = new Date().toISOString();
    const existing = {
      agentId: 'Builder21', label: 'Builder', botNpub: 'npub1Builder', workspaceOwnerNpub: 'npub1manager',
      groupNpubs: [], workingDirectory: '/Users/example/wingmen/agent-workspace', harness: 'codex', model: null,
      publicProfile: { name: 'Builder', picture: null, about: 'Builder', nip05: null }, capabilities: ['chat_intercept'],
      directChat: { enabled: true, sessionAgent: 'codex', directory: '/Users/example/wingmen/agent-workspace', model: null, idleRetentionMinutes: 60 },
      enabled: true, archived: false, createdAt: now, updatedAt: now, managedByNpub: 'npub1manager',
    } as const;
    let saved: Record<string, unknown> | null = null;
    let publishCalls = 0;
    const manager = {
      getAgentForManager: () => existing,
      saveAgentForManager: async (input: Record<string, unknown>) => { saved = input; return input; },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/profiles/Builder21', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botNpub: 'npub1attacker', label: 'Builder', workingDirectory: '/Users/example/wingmen/Builder21',
        harness: 'goose', model: 'default', enabled: false, directChatEnabled: true,
        publicProfile: existing.publicProfile,
      }),
    });
    const response = await handleAgentChatApi(request, new URL(request.url), 'PATCH', authContext, {
      manager,
      agentTypes: [{ id: 'goose', label: 'Goose', modelOptions: ['default', 'qwen'] }],
      republishAgentProfile: async () => {
        publishCalls += 1;
        return { eventId: 'unused', createdAt: 1, result: null };
      },
    });
    const body = await response!.json();
    expect(response?.status).toBe(200);
    expect(publishCalls).toBe(0);
    expect(saved).toMatchObject({
      botNpub: 'npub1Builder', workingDirectory: '/Users/example/wingmen/Builder21', harness: 'goose', model: null,
      directChat: { directory: '/Users/example/wingmen/Builder21', sessionAgent: 'goose', model: null },
    });
    expect(JSON.stringify(body)).not.toMatch(/nsec|private.key|bunker|capability.token/i);
  });

  test('publishes candidate public fields before committing them locally', async () => {
    const now = new Date().toISOString();
    const existing = {
      agentId: 'Builder21', label: 'Builder', botNpub: 'npub1Builder', workspaceOwnerNpub: 'npub1manager', groupNpubs: [],
      workingDirectory: '/Users/example/wingmen/Builder21', harness: 'codex', model: null, archived: false,
      publicProfile: { name: 'Builder', picture: null, about: 'Builder', nip05: null }, capabilities: ['chat_intercept'],
      enabled: true, createdAt: now, updatedAt: now, managedByNpub: 'npub1manager',
    } as const;
    const order: string[] = [];
    let saved: Record<string, unknown> | null = null;
    const manager = {
      getAgentForManager: () => existing,
      saveAgentForManager: async (input: Record<string, unknown>) => { order.push('save'); saved = input; return input; },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/profiles/Builder21', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDirectory: existing.workingDirectory, harness: 'codex', model: null, publicProfile: { ...existing.publicProfile, about: 'Updated' } }),
    });
    const response = await handleAgentChatApi(request, new URL(request.url), 'PATCH', authContext, {
      manager, agentTypes: [{ id: 'codex', label: 'Codex', modelOptions: ['default'] }],
      republishAgentProfile: async (candidate) => {
        order.push('publish');
        expect(candidate.botNpub).toBe('npub1Builder');
        expect(candidate.publicProfile?.about).toBe('Updated');
        return { eventId: 'published-event', createdAt: 123, result: { published: 2 } };
      },
    });
    expect(response?.status).toBe(200);
    expect(order).toEqual(['publish', 'save']);
    expect(saved).toMatchObject({
      publicProfileRefresh: {
        sourceEventId: 'published-event', sourceEventCreatedAt: 123, result: 'published', error: null,
      },
    });
  });

  test('does not commit candidate public fields when relay publication fails', async () => {
    const existing = {
      agentId: 'Builder21', label: 'Builder', botNpub: 'npub1Builder', workspaceOwnerNpub: 'npub1manager', groupNpubs: [],
      workingDirectory: '/Users/example/wingmen/Builder21', harness: 'codex', model: null,
      publicProfile: { name: 'Builder', picture: null, about: 'Builder', nip05: null }, capabilities: ['chat_intercept'],
      enabled: true, createdAt: '', updatedAt: '', managedByNpub: 'npub1manager',
    } as const;
    let saved = false;
    const manager = {
      getAgentForManager: () => existing,
      saveAgentForManager: async () => { saved = true; return existing; },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/profiles/Builder21', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDirectory: existing.workingDirectory, harness: 'codex', publicProfile: { ...existing.publicProfile, name: 'New Builder' } }),
    });
    const response = await handleAgentChatApi(request, new URL(request.url), 'PATCH', authContext, {
      manager, agentTypes: [{ id: 'codex', label: 'Codex', modelOptions: ['default'] }],
      republishAgentProfile: async () => { throw new Error('No relay accepted the event.'); },
    });
    const body = await response!.json();
    expect(response?.status).toBe(502);
    expect(body).toMatchObject({ published: false, code: 'agent_profile_publication_failed' });
    expect(saved).toBe(false);
  });

  test('allows a Flight Deck onboarded subscription to be disconnected locally', async () => {
    let removed = false;
    const manager = {
      getForManager: () => makeSubscription({ onboardingSource: 'nostr_33357' }),
      removeForManager: () => {
        removed = true;
        return true;
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/subscriptions/sub-flightdeck', {
      method: 'DELETE',
    });

    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'DELETE',
      authContext,
      { manager },
    );
    expect(response?.status).toBe(204);
    expect(removed).toBe(true);
  });

  test('sets the explicit default profile used by ordinary Autopilot sessions', async () => {
    const rick = {
      agentId: 'rick', label: 'Rick', botNpub: 'npub1rick', workspaceOwnerNpub: 'npub1manager',
      groupNpubs: [], workingDirectory: '/Users/example/wingmen/rick', capabilities: ['chat_intercept'],
      enabled: true, createdAt: '', updatedAt: '', managedByNpub: 'npub1manager',
    } as const;
    let selected: string | null = null;
    const manager = {
      setDefaultAgentForManager: (profileId: string, managerNpub: string) => {
        expect(managerNpub).toBe('npub1manager');
        selected = profileId;
        return rick;
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/profiles/rick/default', { method: 'POST' });
    const response = await handleAgentChatApi(request, new URL(request.url), 'POST', authContext, { manager });
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(selected).toBe('rick');
    expect(body.defaultAgentProfileId).toBe('rick');
  });

  test('deletes an agent profile through the secure key cleanup path', async () => {
    let deleted: { profileId: string; managerNpub: string } | null = null;
    const manager = {
      deleteAgentProfileForManager: async (profileId: string, managerNpub: string) => {
        deleted = { profileId, managerNpub };
        return {
          agent: {
            agentId: profileId,
            label: 'Builder',
            botNpub: 'npub1builder',
            workspaceOwnerNpub: managerNpub,
            groupNpubs: [],
            workingDirectory: '/tmp/builder',
            capabilities: ['chat_intercept'],
            enabled: true,
            createdAt: '',
            updatedAt: '',
            managedByNpub: managerNpub,
          },
          keyDisposition: 'deleted_from_vault',
        };
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/profiles/builder', { method: 'DELETE' });
    const response = await handleAgentChatApi(request, new URL(request.url), 'DELETE', authContext, { manager });
    const body = await response!.json();

    expect(response?.status).toBe(200);
    expect(deleted).toEqual({ profileId: 'builder', managerNpub: 'npub1manager' });
    expect(body).toMatchObject({
      deleted: true,
      profileId: 'builder',
      botNpub: 'npub1builder',
      keyDisposition: 'deleted_from_vault',
    });
  });

  test('reports bound workspace subscriptions without partially deleting a profile', async () => {
    const manager = {
      deleteAgentProfileForManager: async () => {
        throw Object.assign(new Error('Agent profile is still used by 1 workspace subscription.'), { statusCode: 409 });
      },
    } as unknown as WorkspaceSubscriptionManager;
    const request = new Request('http://localhost/api/agent-chat/profiles/builder', { method: 'DELETE' });
    const response = await handleAgentChatApi(request, new URL(request.url), 'DELETE', authContext, { manager });
    const body = await response!.json();

    expect(response?.status).toBe(409);
    expect(body.error).toContain('workspace subscription');
  });
});

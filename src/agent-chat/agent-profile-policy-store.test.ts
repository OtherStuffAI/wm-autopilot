import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import {
  AgentProfilePolicyStore,
  defaultAgentWorkspaceEventPolicies,
  resolveAgentWorkspaceAppendedContext,
  resolveAgentWorkspacePipeline,
} from './agent-profile-policy-store';
import type {
  BackendConnectionRecord,
  WorkspaceSubscriptionRecord,
} from './types';
import {
  DuplicateCallbackPublicationDecisionStore,
  DuplicateCallbackPublicationFilter,
} from './duplicate-callback-publication-filter';

function makeTempDb(): string {
  return join(tmpdir(), `agent-profile-policy-store-${randomUUID()}.sqlite`);
}

function makeSubscription(overrides: Partial<WorkspaceSubscriptionRecord> = {}): WorkspaceSubscriptionRecord {
  const now = new Date().toISOString();
  return {
    subscriptionId: 'subscription-1',
    backendConnectionId: 'backend-1',
    workspaceOwnerNpub: 'npub1workspace',
    backendBaseUrl: 'https://tower.example.com',
    towerServiceNpub: 'npub1service',
    workspaceId: 'workspace-1',
    workspaceServiceNpub: 'npub1workspaceservice',
    botNpub: 'npub1botone',
    sourceAppNpub: 'npub1app',
    connectionTokenRef: 'agent-connect:one',
    agentProfileId: 'leon',
    sourceAppSchemaNamespace: 'cowork',
    capabilityDefaults: ['chat_intercept'],
    dispatchRouteIds: [],
    lastSyncCursor: null,
    lastPipelineRunId: null,
    wsKeyNpub: 'npub1workspacekey',
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

function makeBackend(overrides: Partial<BackendConnectionRecord> = {}): BackendConnectionRecord {
  const now = new Date().toISOString();
  return {
    backendConnectionId: 'backend-1',
    managedByNpub: 'npub1manager',
    backendBaseUrl: 'https://tower.example.com',
    serviceNpub: 'npub1service',
    setupWorkspaceOwnerNpub: 'npub1workspace',
    setupSourceAppNpub: 'npub1app',
    setupSourceAppSchemaNamespace: 'cowork',
    setupConnectionTokenRef: 'agent-connect:one',
    setupCapabilityDefaults: ['chat_intercept'],
    relayUrls: ['wss://relay.example.com'],
    openapiUrl: 'https://tower.example.com/openapi.json',
    docsUrl: 'https://tower.example.com/docs',
    healthUrl: 'https://tower.example.com/health',
    supportedVersion: '5',
    sharePolicy: 'private',
    healthStatus: 'healthy',
    lastHealthResult: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('AgentProfilePolicyStore', () => {
  test('creates and updates profile workspace settings idempotently after import', () => {
    const store = new AgentProfilePolicyStore(makeTempDb());
    const first = store.ensureProfileWorkspaceForSubscription({
      managedByNpub: 'npub1manager',
      agentProfileId: 'leon',
      agentLabel: 'Leon',
      agentNpub: 'npub1botone',
      subscription: makeSubscription(),
      backendConnection: makeBackend(),
      relayOnboardingStatus: 'ready',
    });
    const second = store.ensureProfileWorkspaceForSubscription({
      managedByNpub: 'npub1manager',
      agentProfileId: 'leon',
      agentLabel: 'Leon',
      agentNpub: 'npub1botone',
      subscription: makeSubscription({ healthStatus: 'degraded', groupKeyStatus: 'refresh_required' }),
      backendConnection: makeBackend({ healthStatus: 'degraded' }),
      relayOnboardingStatus: 'verified',
    });

    expect(second.profile.profileId).toBe(first.profile.profileId);
    expect(second.workspace.profileWorkspaceId).toBe(first.workspace.profileWorkspaceId);
    expect(second.workspace.connectionHealth).toBe('degraded');
    expect(second.workspace.relayOnboardingStatus).toBe('verified');
    expect(second.workspace.towerServiceNpub).toBe('npub1service');
    expect(second.workspace.workspaceId).toBe('workspace-1');
    expect(second.workspace.workspaceServiceNpub).toBe('npub1workspaceservice');
    expect(second.workspace.duplicateCallbackMarker).toBe('duplicate callback:');
    expect(second.workspace.duplicateCallbackWindowSeconds).toBe(180);
    expect(second.policies).toHaveLength(12);
    expect(second.policies.find((policy) => policy.eventType === 'chat_mention')).toMatchObject({
      enabled: true,
      defaultAction: 'respond',
      quietMode: false,
    });
    expect(second.policies.find((policy) => policy.eventType === 'chat_observe')).toMatchObject({
      enabled: false,
      defaultAction: 'observe',
      quietMode: true,
    });
  });

  test('keeps settings separate per agent for the same workspace subscription', () => {
    const store = new AgentProfilePolicyStore(makeTempDb());
    const leon = store.ensureProfileWorkspaceForSubscription({
      managedByNpub: 'npub1manager',
      agentProfileId: 'leon',
      agentLabel: 'Leon',
      agentNpub: 'npub1botone',
      subscription: makeSubscription({ agentProfileId: 'leon', botNpub: 'npub1botone' }),
      backendConnection: makeBackend(),
    });
    const exampleAgent = store.ensureProfileWorkspaceForSubscription({
      managedByNpub: 'npub1manager',
      agentProfileId: 'exampleAgent',
      agentLabel: 'Example Agent',
      agentNpub: 'npub1bottwo',
      subscription: makeSubscription({ agentProfileId: 'exampleAgent', botNpub: 'npub1bottwo' }),
      backendConnection: makeBackend(),
    });

    expect(leon.workspace.profileWorkspaceId).not.toBe(exampleAgent.workspace.profileWorkspaceId);
    expect(store.listWorkspacesForProfile('leon', 'npub1manager')).toHaveLength(1);
    expect(store.listWorkspacesForProfile('exampleAgent', 'npub1manager')).toHaveLength(1);
  });

  test('preserves omitted profile defaults while allowing explicit clears', () => {
    const store = new AgentProfilePolicyStore(makeTempDb());
    const bundle = store.ensureProfileWorkspaceForSubscription({
      managedByNpub: 'npub1manager',
      agentProfileId: 'leon',
      agentLabel: 'Leon',
      agentNpub: 'npub1botone',
      subscription: makeSubscription(),
      backendConnection: makeBackend(),
    });

    const seeded = store.updateProfileDefaults({
      profileId: bundle.profile.profileId,
      managedByNpub: 'npub1manager',
      defaultPipelineDefinitionId: 'profile-pipeline',
      promptContext: 'Profile guidance',
    });
    expect(seeded.defaultPipelineDefinitionId).toBe('profile-pipeline');
    expect(seeded.promptContext).toBe('Profile guidance');

    const changedPipeline = store.updateProfileDefaults({
      profileId: bundle.profile.profileId,
      managedByNpub: 'npub1manager',
      defaultPipelineDefinitionId: 'profile-pipeline-2',
    });
    expect(changedPipeline.defaultPipelineDefinitionId).toBe('profile-pipeline-2');
    expect(changedPipeline.promptContext).toBe('Profile guidance');

    const clearedContext = store.updateProfileDefaults({
      profileId: bundle.profile.profileId,
      managedByNpub: 'npub1manager',
      promptContext: '  ',
    });
    expect(clearedContext.defaultPipelineDefinitionId).toBe('profile-pipeline-2');
    expect(clearedContext.promptContext).toBeNull();

    const clearedPipeline = store.updateProfileDefaults({
      profileId: bundle.profile.profileId,
      managedByNpub: 'npub1manager',
      defaultPipelineDefinitionId: null,
    });
    expect(clearedPipeline.defaultPipelineDefinitionId).toBeNull();
  });

  test('preserves omitted workspace defaults while allowing explicit clears', () => {
    const store = new AgentProfilePolicyStore(makeTempDb());
    const bundle = store.ensureProfileWorkspaceForSubscription({
      managedByNpub: 'npub1manager',
      agentProfileId: 'leon',
      agentLabel: 'Leon',
      agentNpub: 'npub1botone',
      subscription: makeSubscription(),
      backendConnection: makeBackend(),
    });

    const seeded = store.updateWorkspaceDefaults({
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      defaultPipelineDefinitionId: 'workspace-pipeline',
      workspaceContext: 'Workspace guidance',
      workspaceTitle: 'Wingman Workspace',
    });
    expect(seeded.defaultPipelineDefinitionId).toBe('workspace-pipeline');
    expect(seeded.workspaceContext).toBe('Workspace guidance');
    expect(seeded.workspaceTitle).toBe('Wingman Workspace');

    const changedContext = store.updateWorkspaceDefaults({
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      workspaceContext: 'Updated guidance',
    });
    expect(changedContext.defaultPipelineDefinitionId).toBe('workspace-pipeline');
    expect(changedContext.workspaceContext).toBe('Updated guidance');
    expect(changedContext.workspaceTitle).toBe('Wingman Workspace');

    const clearedPipeline = store.updateWorkspaceDefaults({
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      defaultPipelineDefinitionId: '',
    });
    expect(clearedPipeline.defaultPipelineDefinitionId).toBeNull();
    expect(clearedPipeline.workspaceContext).toBe('Updated guidance');
    expect(clearedPipeline.workspaceTitle).toBe('Wingman Workspace');
  });

  test('migrates existing workspace rows with duplicate callback defaults', () => {
    const path = makeTempDb();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE agent_profiles (
        profile_id TEXT NOT NULL, managed_by_npub TEXT NOT NULL, agent_npub TEXT NOT NULL,
        label TEXT NOT NULL, default_pipeline_definition_id TEXT, prompt_context TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, managed_by_npub)
      );
      CREATE TABLE agent_profile_workspaces (
        profile_workspace_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, managed_by_npub TEXT NOT NULL,
        subscription_id TEXT NOT NULL, backend_connection_id TEXT, workspace_owner_npub TEXT NOT NULL,
        source_app_npub TEXT NOT NULL, backend_base_url TEXT NOT NULL, tower_service_npub TEXT,
        workspace_id TEXT, workspace_service_npub TEXT, workspace_title TEXT, app_pubkey TEXT,
        tower_url TEXT NOT NULL, connection_health TEXT NOT NULL, yoke_sync_status TEXT NOT NULL,
        relay_onboarding_status TEXT NOT NULL, default_pipeline_definition_id TEXT, workspace_context TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO agent_profiles VALUES (
        'legacy-profile', 'npub1manager', 'npub1legacyagent', 'Legacy', NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO agent_profile_workspaces VALUES (
        'legacy-workspace', 'legacy-profile', 'npub1manager', 'legacy-subscription', NULL,
        'npub1workspace', 'npub1app', 'https://tower.example.com', 'npub1service', 'workspace-legacy',
        'npub1workspaceservice', 'Legacy Workspace', 'npub1app', 'https://tower.example.com',
        'healthy', 'synced', 'ready', NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const store = new AgentProfilePolicyStore(path);
    expect(store.getWorkspace('legacy-workspace')).toMatchObject({
      duplicateCallbackMarker: 'duplicate callback:',
      duplicateCallbackWindowSeconds: 180,
    });
    expect(store.getDuplicateCallbackPublicationConfig({
      subscriptionId: 'legacy-subscription',
      agentNpub: 'npub1legacyagent',
    })).toEqual({ marker: 'duplicate callback:', windowSeconds: 180 });
  });

  test('keeps duplicate callback settings exact and isolated per workspace', () => {
    const store = new AgentProfilePolicyStore(makeTempDb());
    const first = store.ensureProfileWorkspaceForSubscription({
      managedByNpub: 'npub1manager', agentProfileId: 'leon', agentNpub: 'npub1botone',
      subscription: makeSubscription(), backendConnection: makeBackend(),
    });
    const second = store.ensureProfileWorkspaceForSubscription({
      managedByNpub: 'npub1manager', agentProfileId: 'leon', agentNpub: 'npub1botone',
      subscription: makeSubscription({ subscriptionId: 'subscription-2', workspaceId: 'workspace-2' }),
      backendConnection: makeBackend(),
    });
    store.updateWorkspaceDefaults({
      profileWorkspaceId: first.workspace.profileWorkspaceId,
      duplicateCallbackMarker: '  repeat response:',
      duplicateCallbackWindowSeconds: 45,
    });

    expect(store.getDuplicateCallbackPublicationConfig({
      subscriptionId: 'subscription-1', agentNpub: 'npub1botone',
    })).toEqual({ marker: '  repeat response:', windowSeconds: 45 });
    expect(store.getDuplicateCallbackPublicationConfig({
      subscriptionId: 'subscription-2', agentNpub: 'npub1botone',
    })).toEqual({ marker: 'duplicate callback:', windowSeconds: 180 });
    expect(store.getWorkspace(second.workspace.profileWorkspaceId)).toMatchObject({
      duplicateCallbackMarker: 'duplicate callback:', duplicateCallbackWindowSeconds: 180,
    });
  });

  test('applies a saved workspace policy on the next filter decision', () => {
    const path = makeTempDb();
    const store = new AgentProfilePolicyStore(path);
    const bundle = store.ensureProfileWorkspaceForSubscription({
      managedByNpub: 'npub1manager', agentProfileId: 'leon', agentNpub: 'npub1botone',
      subscription: makeSubscription(), backendConnection: makeBackend(),
    });
    const decisions = new DuplicateCallbackPublicationDecisionStore(path);
    const filter = new DuplicateCallbackPublicationFilter(
      (route) => store.getDuplicateCallbackPublicationConfig(route),
      decisions,
      { warn: () => {} },
    );
    decisions.recordPublished({ decisionId: 'prior', routingKey: 'route-1',
      candidateAt: '2026-08-01T00:00:00.000Z', publishedAt: '2026-08-01T00:00:00.000Z',
      publishedMessageId: 'prior-message' });
    const route = { subscriptionId: 'subscription-1', agentNpub: 'npub1botone', routingKey: 'route-1' };
    expect(filter.evaluate({ ...route, decisionId: 'before-save', body: 'Repeat response: before save',
      candidateAt: '2026-08-01T00:00:10.000Z' })).toMatchObject({ suppress: false, reason: 'marker_not_at_start' });

    store.updateWorkspaceDefaults({ profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      duplicateCallbackMarker: 'repeat response:', duplicateCallbackWindowSeconds: 15 });

    expect(filter.evaluate({ ...route, decisionId: 'after-save', body: 'Repeat response: after save',
      candidateAt: '2026-08-01T00:00:10.000Z' })).toMatchObject({
      suppress: true, reason: 'duplicate_callback_within_window',
    });
  });
});

describe('agent workspace policy helpers', () => {
  test('exposes the required default event policy rows', () => {
    const defaults = defaultAgentWorkspaceEventPolicies();

    expect(defaults.map((policy) => policy.eventType).sort()).toEqual([
      'approval_assigned',
      'chat_mention',
      'chat_observe',
      'direct_message',
      'document_comment_observe',
      'document_comment_tagged',
      'document_created',
      'document_invocation',
      'flow_step_assigned',
      'task_assigned',
      'task_comment',
      'task_invocation',
    ]);
  });

  test('resolves pipeline overrides in event, channel, scope, workspace, profile, built-in order', () => {
    expect(resolveAgentWorkspacePipeline({
      eventPolicy: { pipelineDefinitionId: 'event-pipeline' },
      channelOverride: { pipelineDefinitionId: 'channel-pipeline' },
      scopeOverride: { pipelineDefinitionId: 'scope-pipeline' },
      workspace: { defaultPipelineDefinitionId: 'workspace-pipeline' },
      profile: { defaultPipelineDefinitionId: 'profile-pipeline' },
      builtInDefaultPipelineId: 'built-in',
    })).toEqual({ pipelineDefinitionId: 'event-pipeline', pipelineVersionPolicy: 'latest', source: 'event_policy' });

    expect(resolveAgentWorkspacePipeline({
      eventPolicy: { pipelineDefinitionId: null },
      channelOverride: { pipelineDefinitionId: 'channel-pipeline' },
      scopeOverride: { pipelineDefinitionId: 'scope-pipeline' },
      workspace: { defaultPipelineDefinitionId: 'workspace-pipeline' },
      profile: { defaultPipelineDefinitionId: 'profile-pipeline' },
      builtInDefaultPipelineId: 'built-in',
    })).toEqual({ pipelineDefinitionId: 'channel-pipeline', pipelineVersionPolicy: 'latest', source: 'channel_override' });

    expect(resolveAgentWorkspacePipeline({
      eventPolicy: { pipelineDefinitionId: null },
      channelOverride: null,
      scopeOverride: { pipelineDefinitionId: 'scope-pipeline' },
      workspace: { defaultPipelineDefinitionId: 'workspace-pipeline' },
      profile: { defaultPipelineDefinitionId: 'profile-pipeline' },
      builtInDefaultPipelineId: 'built-in',
    })).toEqual({ pipelineDefinitionId: 'scope-pipeline', pipelineVersionPolicy: 'latest', source: 'scope_override' });

    expect(resolveAgentWorkspacePipeline({
      eventPolicy: null,
      channelOverride: null,
      scopeOverride: null,
      workspace: { defaultPipelineDefinitionId: 'workspace-pipeline' },
      profile: { defaultPipelineDefinitionId: 'profile-pipeline' },
      builtInDefaultPipelineId: 'built-in',
    })).toEqual({ pipelineDefinitionId: 'workspace-pipeline', pipelineVersionPolicy: 'latest', source: 'workspace_default' });

    expect(resolveAgentWorkspacePipeline({
      eventPolicy: null,
      channelOverride: null,
      scopeOverride: null,
      workspace: { defaultPipelineDefinitionId: null },
      profile: { defaultPipelineDefinitionId: 'profile-pipeline' },
      builtInDefaultPipelineId: 'built-in',
    })).toEqual({ pipelineDefinitionId: 'profile-pipeline', pipelineVersionPolicy: 'latest', source: 'profile_default' });

    expect(resolveAgentWorkspacePipeline({
      eventPolicy: null,
      channelOverride: null,
      scopeOverride: null,
      workspace: null,
      profile: null,
      builtInDefaultPipelineId: 'built-in',
    })).toEqual({ pipelineDefinitionId: 'built-in', pipelineVersionPolicy: 'latest', source: 'built_in_default' });
  });

  test('normalises generated built-in dispatch ids to stable latest selections', () => {
    expect(resolveAgentWorkspacePipeline({
      eventPolicy: { pipelineDefinitionId: 'shared:7df6cda5438c' },
      channelOverride: null,
      scopeOverride: null,
      workspace: null,
      profile: null,
      builtInDefaultPipelineId: 'built-in',
    })).toEqual({
      pipelineDefinitionId: 'fd-agent-dispatch-chat',
      pipelineVersionPolicy: 'latest',
      source: 'event_policy',
    });
  });

  test('merges appended context in workspace, scope, channel, event-policy order', () => {
    const result = resolveAgentWorkspaceAppendedContext({
      workspaceContext: 'Workspace guidance',
      scopeContext: 'Scope guidance',
      channelContext: 'Channel guidance',
      eventPolicyContext: 'Mention guidance',
      scopeId: 'scope-autopilot',
      channelId: 'channel-design',
      eventType: 'chat_mention',
    });

    expect(result).toEqual([
      { kind: 'workspace', targetId: null, eventType: null, contextText: 'Workspace guidance' },
      { kind: 'scope', targetId: 'scope-autopilot', eventType: null, contextText: 'Scope guidance' },
      { kind: 'channel', targetId: 'channel-design', eventType: null, contextText: 'Channel guidance' },
      { kind: 'event_policy', targetId: null, eventType: 'chat_mention', contextText: 'Mention guidance' },
    ]);
  });

  test('resolves runtime settings with profile guidance, appended context, and selected pipeline', () => {
    const store = new AgentProfilePolicyStore(makeTempDb());
    const bundle = store.ensureProfileWorkspaceForSubscription({
      managedByNpub: 'npub1manager',
      agentProfileId: 'leon',
      agentLabel: 'Leon',
      agentNpub: 'npub1botone',
      subscription: makeSubscription(),
      backendConnection: makeBackend(),
    });
    store.updateProfileDefaults({
      profileId: bundle.profile.profileId,
      managedByNpub: 'npub1manager',
      defaultPipelineDefinitionId: 'profile-pipeline',
      promptContext: 'Profile guidance',
    });
    store.updateWorkspaceDefaults({
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      defaultPipelineDefinitionId: 'workspace-pipeline',
      workspaceContext: 'Saved workspace guidance',
    });
    store.saveEventPolicy({
      ...store.getPolicy(bundle.workspace.profileWorkspaceId, 'chat_mention')!,
      promptContext: 'Policy prompt guidance',
      updatedAt: new Date().toISOString(),
    });
    store.savePipelineOverride({
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      targetKind: 'scope',
      targetId: 'scope-autopilot',
      pipelineDefinitionId: 'scope-pipeline',
    });
    store.savePipelineOverride({
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      targetKind: 'channel',
      targetId: 'channel-design',
      pipelineDefinitionId: 'channel-pipeline',
    });
    store.replaceAppendedContexts(bundle.workspace.profileWorkspaceId, [
      { contextKind: 'workspace', contextText: 'Workspace guidance' },
      { contextKind: 'scope', targetId: 'scope-autopilot', contextText: 'Scope guidance' },
      { contextKind: 'channel', targetId: 'channel-design', contextText: 'Channel guidance' },
      { contextKind: 'event_policy', eventType: 'chat_mention', contextText: 'Mention guidance' },
    ]);

    const result = store.resolveRuntimeSettingsForEvent({
      profileId: bundle.profile.profileId,
      managedByNpub: 'npub1manager',
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      eventType: 'chat_mention',
      scopeId: 'scope-autopilot',
      channelId: 'channel-design',
      builtInDefaultPipelineId: 'built-in',
    });

    expect(result.policy).toMatchObject({ eventType: 'chat_mention', enabled: true, defaultAction: 'respond' });
    expect(result.pipeline).toEqual({
      pipelineDefinitionId: 'channel-pipeline',
      pipelineVersionPolicy: 'latest',
      source: 'channel_override',
    });
    expect(result.appendedContext).toEqual([
      { kind: 'agent_profile', targetId: 'leon', eventType: null, contextText: 'Profile guidance' },
      { kind: 'workspace', targetId: null, eventType: null, contextText: 'Saved workspace guidance' },
      { kind: 'workspace', targetId: null, eventType: null, contextText: 'Workspace guidance' },
      { kind: 'scope', targetId: 'scope-autopilot', eventType: null, contextText: 'Scope guidance' },
      { kind: 'channel', targetId: 'channel-design', eventType: null, contextText: 'Channel guidance' },
      { kind: 'event_policy', targetId: null, eventType: 'chat_mention', contextText: 'Mention guidance' },
      { kind: 'event_policy', targetId: null, eventType: 'chat_mention', contextText: 'Policy prompt guidance' },
    ]);
  });
});

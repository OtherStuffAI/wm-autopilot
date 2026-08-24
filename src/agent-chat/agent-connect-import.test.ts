import { Buffer } from 'node:buffer';

import { describe, expect, test } from 'bun:test';

import {
  buildAgentConnectImportResult,
  validateAgentConnectPackage,
} from './agent-connect-import';
import { checkBackendConnectionHealth } from './tower-client';
import type { BackendConnectionRecord } from './types';

function encodeToken(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function makePackage(overrides: Record<string, unknown> = {}) {
  const connectionToken = encodeToken({
    type: 'superbased_connection',
    version: 2,
    direct_https_url: 'https://tower.example.com/',
    service_npub: 'npub1service',
    workspace_owner_npub: 'npub1workspace',
    workspace_id: 'workspace-1',
    workspace_service_npub: 'npub1workspaceservice',
    app_npub: 'npub1app',
  });
  return {
    kind: 'coworker_agent_connect',
    version: 5,
    generated_at: '2026-05-05T00:00:00.000Z',
    service: {
      direct_https_url: 'https://tower.example.com',
      service_npub: 'npub1service',
      relay_urls: ['wss://relay.example.com'],
      openapi_url: 'https://tower.example.com/openapi.json',
      docs_url: 'https://tower.example.com/docs',
      health_url: 'https://tower.example.com/health',
    },
    workspace: {
      owner_npub: 'npub1workspace',
      workspace_id: 'workspace-1',
      workspace_service_npub: 'npub1workspaceservice',
    },
    app: { app_npub: 'npub1app', schema_namespace: 'cowork' },
    connection_token: connectionToken,
    capabilities: ['chat_intercept', 'task_dispatch'],
    ...overrides,
  };
}

function makeV6Package(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'coworker_agent_connect',
    version: 6,
    protocol: 'flightdeck_pg',
    generated_at: '2026-07-26T00:00:00.000Z',
    service: {
      direct_https_url: 'https://tower.example.com',
      openapi_url: 'https://tower.example.com/openapi.json',
      docs_url: 'https://tower.example.com/docs',
      health_url: 'https://tower.example.com/health',
    },
    auth: { scheme: 'NIP-98', app_npub: 'npub1app' },
    workspace_descriptor: {
      type: 'wingman_workspace_locator',
      version: 1,
      tower_base_url: 'https://tower.example.com',
      identity: {
        tower_service_npub: 'npub1service',
        workspace_service_npub: 'npub1workspaceservice',
        workspace_owner_npub: 'npub1workspace',
        workspace_id: 'workspace-1',
        app_npub: 'npub1app',
      },
      label: 'Current Flight Deck workspace',
      capabilities: ['task_dispatch'],
    },
    ...overrides,
  };
}

function makeBackendConnection(overrides: Partial<BackendConnectionRecord> = {}): BackendConnectionRecord {
  return {
    backendConnectionId: 'backend-1',
    managedByNpub: 'npub1manager',
    backendBaseUrl: 'https://tower.example.com',
    serviceNpub: 'npub1service',
    setupWorkspaceOwnerNpub: null,
    setupSourceAppNpub: null,
    setupSourceAppSchemaNamespace: null,
    setupConnectionTokenRef: null,
    setupCapabilityDefaults: [],
    relayUrls: ['wss://relay.example.com'],
    openapiUrl: null,
    docsUrl: null,
    healthUrl: 'https://tower.example.com/health',
    supportedVersion: '5',
    sharePolicy: 'private',
    healthStatus: 'degraded',
    lastHealthResult: null,
    createdAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('Agent Connect import validation', () => {
  test('normalizes an untouched Flight Deck v6 package without a connection token', () => {
    const validation = validateAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeV6Package(),
    });

    expect(validation.supportedVersion).toBe('6');
    expect(validation.service.serviceNpub).toBe('npub1service');
    expect(validation.workspaceOwnerNpub).toBe('npub1workspace');
    expect(validation.workspaceId).toBe('workspace-1');
    expect(validation.workspaceServiceNpub).toBe('npub1workspaceservice');
    expect(validation.sourceAppNpub).toBe('npub1app');
    expect(validation.workspaceTitle).toBe('Current Flight Deck workspace');
  });

  test('rejects malformed or inconsistent Flight Deck v6 identities', () => {
    expect(() => validateAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeV6Package({ auth: { app_npub: 'npub1other' } }),
    })).toThrow('app npub does not match');

    const malformed = makeV6Package();
    delete (malformed.workspace_descriptor as { identity?: unknown }).identity;
    expect(() => validateAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: malformed,
    })).toThrow('valid identity object');
  });

  test('validates packages and builds scoped subscription input', () => {
    const validation = validateAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makePackage(),
    });
    const backendConnection: BackendConnectionRecord = {
      backendConnectionId: 'backend-1',
      managedByNpub: 'npub1manager',
      backendBaseUrl: validation.service.directHttpsUrl,
      serviceNpub: validation.service.serviceNpub,
      setupWorkspaceOwnerNpub: validation.workspaceOwnerNpub,
      setupSourceAppNpub: validation.sourceAppNpub,
      setupSourceAppSchemaNamespace: validation.sourceAppSchemaNamespace,
      setupConnectionTokenRef: validation.connectionTokenRef,
      setupCapabilityDefaults: validation.capabilityDefaults,
      relayUrls: validation.service.relayUrls,
      openapiUrl: validation.service.openapiUrl,
      docsUrl: validation.service.docsUrl,
      healthUrl: validation.service.healthUrl,
      supportedVersion: validation.supportedVersion,
      sharePolicy: 'private',
      healthStatus: 'degraded',
      lastHealthResult: null,
      createdAt: '2026-05-05T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.000Z',
    };
    const result = buildAgentConnectImportResult(validation, backendConnection);

    expect(validation.service.directHttpsUrl).toBe('https://tower.example.com');
    expect(validation.capabilityDefaults).toEqual(['chat_intercept', 'task_dispatch']);
    expect(result.subscriptionInput.backendConnectionId).toBe('backend-1');
    expect(result.subscriptionInput.towerServiceNpub).toBe('npub1service');
    expect(result.subscriptionInput.workspaceId).toBe('workspace-1');
    expect(result.subscriptionInput.workspaceServiceNpub).toBe('npub1workspaceservice');
    expect(result.subscriptionInput.workspaceOwnerNpub).toBe('npub1workspace');
    expect(result.subscriptionInput.sourceAppNpub).toBe('npub1app');
    expect(result.subscriptionInput.connectionTokenRef).toStartWith('agent-connect:npub1workspace:npub1app:');
  });

  test('rejects package and token identity mismatches', () => {
    const badToken = encodeToken({
      direct_https_url: 'https://tower.example.com',
      service_npub: 'npub1other',
      workspace_owner_npub: 'npub1workspace',
      workspace_id: 'workspace-1',
      workspace_service_npub: 'npub1workspaceservice',
      app_npub: 'npub1app',
    });

    expect(() => validateAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makePackage({ connection_token: badToken }),
    })).toThrow('service npub');
  });

  test('rejects optional workspace identity mismatches when Agent Connect provides them', () => {
    const badToken = encodeToken({
      direct_https_url: 'https://tower.example.com',
      service_npub: 'npub1service',
      workspace_owner_npub: 'npub1workspace',
      workspace_id: 'workspace-1',
      workspace_service_npub: 'npub1otherworkspace',
      app_npub: 'npub1app',
    });

    expect(() => validateAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makePackage({ connection_token: badToken }),
    })).toThrow('workspace service npub');
  });

  test('checks backend health successfully when health URL is available', async () => {
    const result = await checkBackendConnectionHealth(makeBackendConnection(), async () => (
      new Response(JSON.stringify({ ok: true, version: '5' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ));

    expect(result.healthStatus).toBe('healthy');
    expect(result.diagnostic.ok).toBe(true);
    expect(result.diagnostic.details?.response).toEqual({ ok: true, version: '5' });
  });

  test('marks backend health unhealthy when the health URL fails', async () => {
    const result = await checkBackendConnectionHealth(makeBackendConnection(), async () => (
      new Response('nope', { status: 503, statusText: 'Service Unavailable' })
    ));

    expect(result.healthStatus).toBe('unhealthy');
    expect(result.diagnostic.ok).toBe(false);
    expect(result.diagnostic.code).toBe('backend_health_failed');
    expect(result.diagnostic.details?.detailCode).toBe('backend_health_http_error');
  });

  test('marks backend health degraded when no health URL is configured', async () => {
    const result = await checkBackendConnectionHealth(makeBackendConnection({ healthUrl: null }), async () => {
      throw new Error('fetch should not run');
    });

    expect(result.healthStatus).toBe('degraded');
    expect(result.diagnostic.ok).toBe(false);
    expect(result.diagnostic.code).toBe('backend_health_unavailable');
    expect(result.diagnostic.details?.detailCode).toBe('backend_health_url_missing');
  });
});

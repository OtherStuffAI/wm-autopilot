import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AccessActions } from '../auth/access-control';
import type { RequestAuthContext } from '../auth/request-context';
import type { AppRecord } from '../apps/app-registry';
import type { WappRecord } from '../wapps/types';
import { appCommand } from '../apps/app-command';
import { validateAppCommand } from '../apps/app-command';
import { handleAppsApi, type AppsApiContext } from './apps-api-routes';

const authContext: RequestAuthContext = {
  npub: 'npub1viewer',
  actorNpub: 'npub1viewer',
  signerNpub: 'npub1viewer',
  subjectNpub: 'npub1viewer',
  targetOwnerNpub: 'npub1viewer',
  delegatedOwnerNpub: null,
  delegateRelationshipId: null,
  delegateScopes: null,
  session: {
    npub: 'npub1viewer',
    nonce: 'nonce',
    issuedAt: 0,
    expiresAt: 999999,
  },
  authMethod: 'session',
};

function idleStatus(appId: string) {
  return {
    appId,
    status: 'idle' as const,
    lastAction: null,
    lastExitCode: null,
    message: undefined,
    updatedAt: '2026-07-04T00:00:00.000Z',
    lastSuccessAt: undefined,
    lastFailureAt: undefined,
    running: false,
    inProgressAction: null,
  };
}

function createContext(
  overrides: Partial<AppsApiContext> = {},
): AppsApiContext {
  return {
    adminNpub: null,
    sharedInstanceAccess: false,
    workspaceScope: { defaultDirectory: '/workspace' } as AppsApiContext['workspaceScope'],
    viewerNpub: 'npub1viewer',
    AccessActions: { AppsManage: AccessActions.AppsManage, AppsRead: AccessActions.AppsRead },
    ensureApiAccess: async () => null,
    normaliseOptionalString: (value) => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    },
    normaliseNpub: (npub) => npub ?? null,
    ensureDirectory: async (root) => root,
    ensureWithinAllowedDirectories: () => undefined,
    parseAppScripts: () => ({}),
    parseBooleanInput: () => undefined,
    parsePortInput: () => null,
    parseBooleanFlag: () => false,
    appActions: [],
    canAccessApp: () => true,
    deriveDirectoryNameFromUrl: () => 'starter',
    cloneRepositoryIntoWorkspace: async () => ({
      root: '/workspace/starter',
      label: 'Starter',
      scripts: {},
    }),
    scanDirectoryTree: async () => [],
    buildAppOwnerFilters: () => [],
    defaultAppProcessStatus: idleStatus,
    resolveOwnerAliasCached: () => null,
    buildAppResponse: () => ({}),
    appRegistry: {
      listApps: async () => [],
      getApp: async () => undefined,
      discoverScripts: async () => ({}),
      registerApp: async () => {
        throw new Error('not implemented');
      },
      updateApp: async () => {
        throw new Error('not implemented');
      },
      reviewWappTowerBrokerMigration: async () => {
        throw new Error('not implemented');
      },
      removeApp: async () => false,
    },
    appProcessManager: {
      listStatuses: async () => [],
      getStatus: async (appId) => idleStatus(appId),
      tailLogs: async () => [],
      clearLogs: async () => undefined,
      forget: () => undefined,
      kill: async () => undefined,
      start: async (appId) => idleStatus(appId),
      stop: async (appId) => idleStatus(appId),
      restart: async (appId) => idleStatus(appId),
      setup: async (appId) => idleStatus(appId),
      build: async (appId) => idleStatus(appId),
    },
    appAliasRegistry: {
      getByAppId: async () => undefined,
    },
    appDomainRegistry: {
      listByAppId: async () => [],
      registerDomain: async ({ hostname, appId, status = 'pending_dns' }) => ({
        hostname,
        appId,
        status,
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
        lastVerifiedAt: null,
        error: null,
      }),
      updateDomain: async (hostname, { status = 'active', verified = false, error = null }) => ({
        hostname,
        appId: 'app-1',
        status,
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
        lastVerifiedAt: verified ? '2026-07-04T00:00:00.000Z' : null,
        error,
      }),
      removeDomain: async () => true,
    },
    npubProjectStore: {
      getByPath: () => null,
      setAppId: () => undefined,
      createProject: () => null,
      clearAppIdByAppId: () => undefined,
    },
    createCaproverTargetClientsFromEnv: () => [],
    createAppTarball: async () => ({ buffer: new Uint8Array(), fileCount: 0 }),
    caproverStore: {
      getAppByLocalAppId: () => null,
    } as unknown as AppsApiContext['caproverStore'],
    ...overrides,
  };
}

describe('handleAppsApi', () => {
  test('reviews a complete Tower WApp broker migration without clearing unrelated reasons', async () => {
    const app: AppRecord = {
      id: 'kindling-api',
      label: 'Kindling API',
      root: '/workspace/kindling-api',
      scripts: { start: appCommand('bun', 'run', 'start') },
      tmuxSession: 'kindling-api',
      ownerNpub: 'npub1viewer',
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
      webApp: true,
      webAppPort: 4100,
      lifecycleReviewRequired: true,
      lifecycleReviewReasons: ['app-owner-is-not-a-configured-admin'],
    };
    const ctx = createContext({
      appRegistry: {
        listApps: async () => [app],
        getApp: async () => app,
        discoverScripts: async () => app.scripts,
        registerApp: async () => app,
        updateApp: async () => app,
        reviewWappTowerBrokerMigration: async () => app,
        removeApp: async () => false,
      },
      wappStore: {
        list: () => [],
        getByAppId: () => ({
          id: 'installation-1',
          appId: app.id,
          towerBindingId: 'tower-primary',
          appNpub: 'npub1app',
        } as unknown as WappRecord),
      },
      buildAppResponse: (record) => ({ ...record }),
    });
    const request = new Request('http://localhost/api/apps/kindling-api/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'review-wapp-tower-broker' }),
    });
    const response = await handleAppsApi(request, new URL(request.url), 'POST', authContext, ctx);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      review: {
        clearedReason: 'raw-signing-secret-removed-use-capability-broker',
        remainingReasons: ['app-owner-is-not-a-configured-admin'],
      },
    });
  });

  test('returns 403 for non-Admin app registration, configuration, and lifecycle', async () => {
    const ctx = createContext({
      ensureApiAccess: async (action) => action === AccessActions.AppsManage
        ? Response.json({ error: 'admin-or-execution-delegation-required' }, { status: 403 })
        : null,
    });
    const requests = [
      new Request('http://localhost/api/apps', { method: 'POST', body: JSON.stringify({ root: '/workspace/app' }) }),
      new Request('http://localhost/api/apps/app-1', { method: 'PUT', body: JSON.stringify({ label: 'Changed' }) }),
      new Request('http://localhost/api/apps/app-1/actions', { method: 'POST', body: JSON.stringify({ action: 'start' }) }),
    ];
    for (const request of requests) {
      const response = await handleAppsApi(request, new URL(request.url), request.method as 'POST' | 'PUT', authContext, ctx);
      expect(response?.status).toBe(403);
    }
  });

  test('rejects caller-controlled lifecycle shell strings', async () => {
    const ctx = createContext({
      parseAppScripts: (input) => {
        const record = input as Record<string, unknown>;
        return { start: validateAppCommand(record.start) };
      },
    });
    const request = new Request('http://localhost/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: '/workspace/app', scripts: { start: 'touch /tmp/pwned && curl attacker' } }),
    });
    const response = await handleAppsApi(request, new URL(request.url), 'POST', authContext, ctx);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: expect.stringContaining('objects') });
  });

  test('passes viewer npub to app clone helper for GitHub credentials', async () => {
    const calls: Array<{
      repoUrl: string;
      directoryName: string;
      viewerNpub: string | null;
    }> = [];
    const ctx = createContext({
      cloneRepositoryIntoWorkspace: async (_scope, repoUrl, directoryName, viewerNpub) => {
        calls.push({ repoUrl, directoryName, viewerNpub });
        return {
          root: '/workspace/testwapp',
          label: 'Testwapp',
          scripts: {},
        };
      },
    });
    const request = new Request('http://localhost/api/apps/clone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://github.com/example-org/testwapp.git',
        directory: 'testwapp',
      }),
    });

    const response = await handleAppsApi(
      request,
      new URL(request.url),
      'POST',
      authContext,
      ctx,
    );

    expect(response?.status).toBe(201);
    expect(calls).toEqual([{
      repoUrl: 'https://github.com/example-org/testwapp.git',
      directoryName: 'testwapp',
      viewerNpub: 'npub1viewer',
    }]);
  });

  test('imports app root .env into managed app environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-dotenv-import-'));
    try {
      writeFileSync(join(dir, '.env'), [
        'WAPP_NSEC=nsec1starter',
        'TOWER_URL=https://tower.example',
      ].join('\n'));
      let app: AppRecord = {
        id: 'app-1',
        label: 'App One',
        root: dir,
        scripts: { start: appCommand('bun', 'src/server.ts') },
        tmuxSession: 'app-1',
        ownerNpub: 'npub1viewer',
        env: { EXISTING: 'keep' },
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
        webApp: true,
        webAppPort: 4123,
      };
      const ctx = createContext({
        appRegistry: {
          listApps: async () => [app],
          getApp: async (id) => id === app.id ? app : undefined,
          discoverScripts: async () => ({}),
          registerApp: async () => {
            throw new Error('not implemented');
          },
          updateApp: async (id, input) => {
            if (id !== app.id) throw new Error('unknown app');
            app = {
              ...app,
              ...input,
              notes: input.notes === null ? undefined : input.notes ?? app.notes,
              updatedAt: '2026-07-06T00:01:00.000Z',
            };
            return app;
          },
          removeApp: async () => false,
        },
        buildAppResponse: (record) => ({ id: record.id, env: record.env }),
      });
      const request = new Request('http://localhost/api/apps/app-1/env/import-dotenv', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: '.env' }),
      });

      const response = await handleAppsApi(request, new URL(request.url), 'POST', authContext, ctx);
      expect(response?.status).toBe(200);
      const payload = await response!.json() as any;
      expect(payload.imported.keys).toEqual(['TOWER_URL', 'WAPP_NSEC']);
      expect(app.env).toEqual({
        EXISTING: 'keep',
        TOWER_URL: 'https://tower.example',
        WAPP_NSEC: 'nsec1starter',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('registers and verifies custom domains for web apps', async () => {
    const app: AppRecord = {
      id: 'app-1',
      label: 'Web App',
      root: '/workspace/web-app',
      scripts: {},
      tmuxSession: '',
      ownerNpub: 'npub1viewer',
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
      webApp: true,
      webAppPort: 4123,
    };
    const domains = new Map<string, Awaited<ReturnType<AppsApiContext['appDomainRegistry']['registerDomain']>>>();
    const ctx = createContext({
      appRegistry: {
        listApps: async () => [app],
        getApp: async (id) => id === app.id ? app : undefined,
        discoverScripts: async () => ({}),
        registerApp: async () => {
          throw new Error('not implemented');
        },
        updateApp: async () => {
          throw new Error('not implemented');
        },
        removeApp: async () => false,
      },
      appDomainRegistry: {
        listByAppId: async (appId) => Array.from(domains.values()).filter((domain) => domain.appId === appId),
        registerDomain: async ({ hostname, appId, status = 'pending_dns', error = null }) => {
          const record = {
            hostname,
            appId,
            status,
            createdAt: '2026-07-04T00:00:00.000Z',
            updatedAt: '2026-07-04T00:00:00.000Z',
            lastVerifiedAt: null,
            error,
          };
          domains.set(hostname, record);
          return record;
        },
        updateDomain: async (hostname, { status, verified = false, error = null }) => {
          const existing = domains.get(hostname);
          if (!existing) throw new Error('missing domain');
          const record = {
            ...existing,
            status: status ?? existing.status,
            error,
            lastVerifiedAt: verified ? '2026-07-04T00:01:00.000Z' : existing.lastVerifiedAt,
            updatedAt: '2026-07-04T00:01:00.000Z',
          };
          domains.set(hostname, record);
          return record;
        },
        removeDomain: async (hostname) => domains.delete(hostname),
      },
    });

    const createRequest = new Request('http://localhost/api/apps/app-1/domains', {
      method: 'POST',
      body: JSON.stringify({ hostname: 'BrandName.com' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const createResponse = await handleAppsApi(createRequest, new URL(createRequest.url), 'POST', authContext, ctx);
    expect(createResponse?.status).toBe(201);
    expect(await createResponse?.json()).toMatchObject({
      domain: {
        hostname: 'brandname.com',
        status: 'pending_dns',
      },
    });

    const verifyRequest = new Request('http://localhost/api/apps/app-1/domains/brandname.com/verify', {
      method: 'POST',
    });
    const verifyResponse = await handleAppsApi(verifyRequest, new URL(verifyRequest.url), 'POST', authContext, ctx);
    expect(verifyResponse?.status).toBe(200);
    expect(await verifyResponse?.json()).toMatchObject({
      domain: {
        hostname: 'brandname.com',
        status: 'active',
        lastVerifiedAt: '2026-07-04T00:01:00.000Z',
      },
      verifiedBy: 'caller',
    });

    const listRequest = new Request('http://localhost/api/apps/app-1/domains');
    const listResponse = await handleAppsApi(listRequest, new URL(listRequest.url), 'GET', authContext, ctx);
    expect(listResponse?.status).toBe(200);
    expect(await listResponse?.json()).toMatchObject({
      domains: [
        {
          hostname: 'brandname.com',
          status: 'active',
        },
      ],
    });
  });
});

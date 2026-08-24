import { Buffer } from 'node:buffer';

import { describe, expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';

import {
  SBIP0009_APP_NAMESPACE,
  buildAccessGrantDedupeKey,
  buildAccessGrantId,
  decodeAccessGrantEvent,
  processAccessGrantEvent,
  SBIP0009_ACCESS_GRANT_KIND,
  SBIP0009_PAYLOAD_KIND,
} from './sbip0009';

function makeIdentity() {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return { secret, pubkey, npub: nip19.npubEncode(pubkey) };
}

function encodeToken(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function makeGrantEvent(overrides: {
  payload?: Record<string, unknown>;
  tags?: string[][];
  recipient?: ReturnType<typeof makeIdentity>;
  publisher?: ReturnType<typeof makeIdentity>;
  issuer?: ReturnType<typeof makeIdentity>;
  service?: ReturnType<typeof makeIdentity>;
  workspaceService?: ReturnType<typeof makeIdentity>;
  workspaceOwner?: ReturnType<typeof makeIdentity>;
  app?: ReturnType<typeof makeIdentity>;
} = {}) {
  const recipient = overrides.recipient ?? makeIdentity();
  const issuer = overrides.issuer ?? makeIdentity();
  const publisher = overrides.publisher ?? issuer;
  const service = overrides.service ?? makeIdentity();
  const workspaceService = overrides.workspaceService ?? makeIdentity();
  const workspaceOwner = overrides.workspaceOwner ?? makeIdentity();
  const app = overrides.app ?? makeIdentity();
  const dedupeKey = buildAccessGrantDedupeKey({
    serviceNpub: service.npub,
    workspaceServiceNpub: workspaceService.npub,
    appNpub: app.npub,
    recipientNpub: recipient.npub,
  });
  const grantId = buildAccessGrantId(dedupeKey);
  const connectionToken = encodeToken({
    type: 'superbased_connection',
    direct_https_url: 'https://tower.example.com',
    service_npub: service.npub,
    workspace_owner_npub: workspaceOwner.npub,
    workspace_service_npub: workspaceService.npub,
    app_npub: app.npub,
  });
  const agentConnectPackage = {
    kind: 'coworker_agent_connect',
    version: 5,
    generated_at: '2026-06-06T00:00:00.000Z',
    service: {
      direct_https_url: 'https://tower.example.com',
      service_npub: service.npub,
      relay_urls: ['wss://relay.example'],
    },
    workspace: {
      owner_npub: workspaceOwner.npub,
      workspace_service_npub: workspaceService.npub,
      workspace_id: null,
    },
    app: { app_npub: app.npub, app_pubkey: app.pubkey },
    connection_token: connectionToken,
    capabilities: ['task_dispatch'],
  };
  const payload = {
    kind: SBIP0009_PAYLOAD_KIND,
    version: 1,
    status: 'active',
    grant_id: grantId,
    dedupe_key: dedupeKey,
    issued_at: '2026-06-06T00:00:00.000Z',
    expires_at: null,
    reason: 'workspace_member_added',
    issuer: { npub: issuer.npub, display_name: null },
    recipient: { npub: recipient.npub },
    service: {
      direct_https_url: 'https://tower.example.com',
      service_npub: service.npub,
      relay_urls: ['wss://relay.example'],
    },
    workspace: {
      owner_npub: workspaceOwner.npub,
      workspace_service_npub: workspaceService.npub,
      workspace_id: null,
    },
    app: { app_npub: app.npub, namespace: SBIP0009_APP_NAMESPACE },
    agent_connect_package: agentConnectPackage,
    verification: { required: true, method: 'tower_nip98_current_membership' },
    ...overrides.payload,
  };
  const conversationKey = nip44.v2.utils.getConversationKey(publisher.secret, recipient.pubkey);
  const content = nip44.v2.encrypt(JSON.stringify(payload), conversationKey);
  const tags = overrides.tags ?? [
    ['d', dedupeKey],
    ['p', recipient.pubkey, '', 'recipient'],
    ['app', SBIP0009_APP_NAMESPACE],
    ['app_npub', app.npub],
    ['service_npub', service.npub],
    ['workspace_service_npub', workspaceService.npub],
    ['workspace_owner_npub', workspaceOwner.npub],
    ['recipient', recipient.npub],
    ['issuer', issuer.npub],
    ['grant', grantId],
    ['alt', 'Wingman Flight Deck access grant announcement'],
  ];
  const event = finalizeEvent({
    kind: SBIP0009_ACCESS_GRANT_KIND,
    created_at: Math.floor(Date.parse('2026-06-06T00:00:00.000Z') / 1000),
    tags,
    content,
  }, publisher.secret);
  return { event, recipient, publisher, issuer, payload, service, workspaceService, workspaceOwner, app, grantId };
}

function makeCurrentFlightDeckGrantEvent(overrides: Parameters<typeof makeGrantEvent>[0] = {}) {
  const issuer = overrides.issuer ?? makeIdentity();
  const base = makeGrantEvent({
    ...overrides,
    issuer,
  });
  const payload = {
    ...base.payload,
    kind: undefined,
    type: 'flightdeck_onboarding',
    protocol: 'onboarding',
    grant_id: undefined,
    dedupe_key: undefined,
    recipient: undefined,
    issuer: undefined,
    recipient_npub: base.recipient.npub,
    issued_by_npub: issuer.npub,
    workspace: {
      ...base.payload.workspace,
      app_npub: base.app.npub,
      label: 'Wingers',
      descriptor_url: 'https://tower.example.com/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
      me_url: 'https://tower.example.com/api/v4/flightdeck-pg/workspaces/workspace-1/me',
    },
    app: {
      app_npub: base.app.npub,
      app_pubkey: base.app.pubkey,
    },
    agent_connect: base.payload.agent_connect_package,
    agent_connect_package: undefined,
    grant: {
      grant_id: overrides.payload?.grant && typeof overrides.payload.grant === 'object'
        ? (overrides.payload.grant as { grant_id?: string }).grant_id
        : 'fd-onboard:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      reason: 'added_to_workspace_or_group',
    },
    ...overrides.payload,
  };
  return makeGrantEvent({
    ...overrides,
    recipient: base.recipient,
    publisher: base.publisher,
    issuer,
    service: base.service,
    workspaceService: base.workspaceService,
    workspaceOwner: base.workspaceOwner,
    app: base.app,
    payload,
    tags: overrides.tags ?? [
      ['p', base.recipient.pubkey],
      ['app_pub', base.app.pubkey],
      ['protocol', 'onboarding'],
    ],
  });
}

describe('Flight Deck 33357 onboarding validation', () => {
  test('imports an embedded v6 package after successful Tower verification', async () => {
    const service = makeIdentity();
    const workspaceService = makeIdentity();
    const workspaceOwner = makeIdentity();
    const app = makeIdentity();
    const v6Package = {
      kind: 'coworker_agent_connect',
      version: 6,
      protocol: 'flightdeck_pg',
      generated_at: '2026-07-26T00:00:00.000Z',
      service: { direct_https_url: 'https://tower.example.com' },
      auth: { scheme: 'NIP-98', app_npub: app.npub },
      workspace_descriptor: {
        type: 'wingman_workspace_locator',
        version: 1,
        tower_base_url: 'https://tower.example.com',
        identity: {
          tower_service_npub: service.npub,
          workspace_service_npub: workspaceService.npub,
          workspace_owner_npub: workspaceOwner.npub,
          workspace_id: 'workspace-1',
          app_npub: app.npub,
        },
      },
    };
    const fixture = makeGrantEvent({
      service,
      workspaceService,
      workspaceOwner,
      app,
      payload: {
        workspace: {
          owner_npub: workspaceOwner.npub,
          workspace_service_npub: workspaceService.npub,
          workspace_id: 'workspace-1',
        },
        agent_connect_package: v6Package,
      },
    });
    let imported: Record<string, unknown> | string | null = null;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.issuer.npub,
      subscriptionManager: {
        importAgentConnectPackage: async (input) => {
          imported = input.packageJson;
          return { subscription: { subscriptionId: 'sub-v6' } };
        },
      },
      fetchImpl: (async () => new Response(JSON.stringify({
        allowed: true,
        service_npub: service.npub,
        workspace_service_npub: workspaceService.npub,
        workspace_owner_npub: workspaceOwner.npub,
      }), { status: 200 })) as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe('imported');
    expect(imported).toMatchObject({ version: 6, protocol: 'flightdeck_pg' });
    expect((imported as unknown as { connection_token?: unknown }).connection_token).toBeUndefined();
  });

  test('validates and decrypts a canonical signed onboarding event', () => {
    const fixture = makeGrantEvent();
    const grant = decodeAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      now: new Date('2026-06-06T00:00:01.000Z'),
    });
    expect(grant.grantId).toBe(fixture.grantId);
    expect(grant.payload.agent_connect_package?.kind).toBe('coworker_agent_connect');
    expect(grant.workspaceOwnerNpub).toBe(fixture.workspaceOwner.npub);
    expect(grant.workspaceServiceNpub).toBe(fixture.workspaceService.npub);
  });

  test('accepts current Flight Deck grants with only p/app_pub/protocol cleartext tags', async () => {
    const fixture = makeCurrentFlightDeckGrantEvent();
    const grant = decodeAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      now: new Date('2026-06-07T00:00:01.000Z'),
    });

    expect(fixture.event.tags).toEqual([
      ['p', fixture.recipient.pubkey],
      ['app_pub', fixture.app.pubkey],
      ['protocol', 'onboarding'],
    ]);
    expect(grant.grantId).toMatch(/^fd-onboard:/);
    expect(grant.dedupeKey).toBe(buildAccessGrantDedupeKey({
      serviceNpub: fixture.service.npub,
      workspaceServiceNpub: fixture.workspaceService.npub,
      appNpub: fixture.app.npub,
      recipientNpub: fixture.recipient.npub,
    }));
    expect(grant.payload.agent_connect_package?.kind).toBe('coworker_agent_connect');
    expect(grant.payload.grant_id).toBe(grant.grantId);

    let importedPackage: Record<string, unknown> | string | null = null;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.issuer.npub,
      subscriptionManager: {
        importAgentConnectPackage: async (input) => {
          importedPackage = input.packageJson;
          return { subscription: { subscriptionId: 'sub-current' } };
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({
        allowed: true,
        service_npub: fixture.service.npub,
        workspace_service_npub: fixture.workspaceService.npub,
        workspace_owner_npub: fixture.workspaceOwner.npub,
        descriptor: {
          identity: {
            tower_service_npub: fixture.service.npub,
            workspace_service_npub: fixture.workspaceService.npub,
            workspace_owner_npub: fixture.workspaceOwner.npub,
            app_npub: fixture.app.npub,
          },
        },
      }), { status: 200 }),
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe('imported');
    expect(importedPackage).not.toBeNull();
    expect(typeof importedPackage).toBe('object');
    const imported = importedPackage as unknown as { kind?: unknown; workspace?: Record<string, unknown> };
    expect(imported.kind).toBe('coworker_agent_connect');
    expect(imported.workspace).toMatchObject({
      owner_npub: fixture.workspaceOwner.npub,
      workspace_service_npub: fixture.workspaceService.npub,
      label: 'Wingers',
    });
  });

  test('verifies current Flight Deck grants through encrypted workspace me_url when generic Tower verify is unavailable', async () => {
    const fixture = makeCurrentFlightDeckGrantEvent();
    const requestedUrls: string[] = [];
    let imports = 0;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.issuer.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return { subscription: { subscriptionId: 'sub-current' } };
        },
      },
      fetchImpl: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.endsWith('/api/v4/access-grants/verify')) {
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }
        if (url.endsWith('/api/v4/flightdeck-pg/workspaces/workspace-1/me')) {
          return new Response(JSON.stringify({
            identity: {
              tower_service_npub: fixture.service.npub,
              workspace_service_npub: fixture.workspaceService.npub,
              workspace_owner_npub: fixture.workspaceOwner.npub,
              workspace_id: 'workspace-1',
              app_npub: fixture.app.npub,
            },
            actor: {
              npub: fixture.recipient.npub,
            },
            membership: {
              role: 'member',
            },
            permissions: ['workspace.read'],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe('imported');
    expect(imports).toBe(1);
    expect(requestedUrls).toEqual([
      'https://tower.example.com/api/v4/access-grants/verify',
      'https://tower.example.com/api/v4/flightdeck-pg/workspaces/workspace-1/me',
    ]);
  });

  test('uses the derived dedupe key for current Flight Deck duplicate delivery', async () => {
    const firstFixture = makeCurrentFlightDeckGrantEvent();
    const secondFixture = makeCurrentFlightDeckGrantEvent({
      recipient: firstFixture.recipient,
      publisher: firstFixture.publisher,
      issuer: firstFixture.issuer,
      service: firstFixture.service,
      workspaceService: firstFixture.workspaceService,
      workspaceOwner: firstFixture.workspaceOwner,
      app: firstFixture.app,
      payload: {
        grant: {
          grant_id: 'fd-onboard:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        },
      },
    });
    const processedKeys = new Set<string>();
    let imports = 0;
    const baseInput = {
      recipientSecretKey: firstFixture.recipient.secret,
      recipientNpub: firstFixture.recipient.npub,
      managedByNpub: firstFixture.issuer.npub,
      processedKeys,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return { subscription: { subscriptionId: 'sub-current' } };
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({
        allowed: true,
        service_npub: firstFixture.service.npub,
        workspace_service_npub: firstFixture.workspaceService.npub,
        workspace_owner_npub: firstFixture.workspaceOwner.npub,
      }), { status: 200 }),
    };

    const first = await processAccessGrantEvent({ ...baseInput, event: firstFixture.event });
    const second = await processAccessGrantEvent({ ...baseInput, event: secondFixture.event });

    expect(first.ok).toBe(true);
    expect(first.code).toBe('imported');
    expect(second.ok).toBe(true);
    expect(second.code).toBe('duplicate_skipped');
    expect(imports).toBe(1);
  });

  test('rejects public tags and decrypted payload mismatches', () => {
    const fixture = makeGrantEvent({
      payload: {
        app: { app_npub: makeIdentity().npub, namespace: SBIP0009_APP_NAMESPACE },
      },
    });
    expect(() => decodeAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
    })).toThrow(/app npub mismatch|dedupe key mismatch/);
  });

  test('rejects current Flight Deck app, recipient, and Tower identity mismatches', async () => {
    const appMismatch = makeCurrentFlightDeckGrantEvent({
      tags: undefined,
    });
    appMismatch.event.tags = [
      ['p', appMismatch.recipient.pubkey],
      ['app_pub', makeIdentity().pubkey],
      ['protocol', 'onboarding'],
    ];
    expect(() => decodeAccessGrantEvent({
      event: appMismatch.event,
      recipientSecretKey: appMismatch.recipient.secret,
      recipientNpub: appMismatch.recipient.npub,
      verifySignature: false,
    })).toThrow(/app pubkey mismatch/);

    const recipientMismatch = makeCurrentFlightDeckGrantEvent();
    const wrongRecipient = makeIdentity();
    expect(() => decodeAccessGrantEvent({
      event: recipientMismatch.event,
      recipientSecretKey: recipientMismatch.recipient.secret,
      recipientNpub: wrongRecipient.npub,
      verifySignature: false,
    })).toThrow(/recipient p tag mismatch/);

    const towerMismatch = makeCurrentFlightDeckGrantEvent();
    let imports = 0;
    const result = await processAccessGrantEvent({
      event: towerMismatch.event,
      recipientSecretKey: towerMismatch.recipient.secret,
      recipientNpub: towerMismatch.recipient.npub,
      managedByNpub: towerMismatch.issuer.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return {};
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({
        allowed: true,
        service_npub: towerMismatch.service.npub,
        descriptor: {
          identity: {
            workspace_service_npub: makeIdentity().npub,
            workspace_owner_npub: towerMismatch.workspaceOwner.npub,
            app_npub: towerMismatch.app.npub,
          },
        },
      }), { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('tower_verify_failed');
    expect(imports).toBe(0);
  });

  test('rejects onboarding signed by someone other than the payload issuer', () => {
    const fixture = makeCurrentFlightDeckGrantEvent({
      publisher: makeIdentity(),
    });

    expect(() => decodeAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
    })).toThrow(/event signer issuer mismatch/);
  });

  test('rejects onboarding from an issuer other than the bot manager before Tower verification', async () => {
    const fixture = makeCurrentFlightDeckGrantEvent();
    const otherManager = makeIdentity();
    let verifies = 0;
    let imports = 0;

    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: otherManager.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return {};
        },
      },
      fetchImpl: async () => {
        verifies += 1;
        return new Response(JSON.stringify({ allowed: true }), { status: 200 });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('unauthorized_issuer');
    expect(verifies).toBe(0);
    expect(imports).toBe(0);
  });

  test('allows onboarding from an authorized Autopilot user when the shared manager is different', async () => {
    const fixture = makeCurrentFlightDeckGrantEvent();
    const sharedManager = makeIdentity();
    let imports = 0;

    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: sharedManager.npub,
      isAuthorizedIssuerNpub: (npub) => npub === fixture.issuer.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return { subscription: { subscriptionId: 'sub-shared' } };
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({
        allowed: true,
        service_npub: fixture.service.npub,
        workspace_service_npub: fixture.workspaceService.npub,
        workspace_owner_npub: fixture.workspaceOwner.npub,
      }), { status: 200 }),
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe('imported');
    expect(imports).toBe(1);
  });

  test('reports decrypt failure before import', async () => {
    const fixture = makeGrantEvent();
    const wrongRecipient = makeIdentity();
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: wrongRecipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.issuer.npub,
      subscriptionManager: { importAgentConnectPackage: async () => ({}) },
      fetchImpl: async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('decrypt_failed');
  });

  test('blocks import when Tower verification fails', async () => {
    const fixture = makeGrantEvent();
    let imports = 0;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.issuer.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return {};
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({ allowed: false }), { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('tower_verify_failed');
    expect(imports).toBe(0);
  });

  test('imports only once for repeated verified relay events and runs post-connect sync', async () => {
    const fixture = makeGrantEvent();
    const processedKeys = new Set<string>();
    let imports = 0;
    let syncs = 0;
    let importSource = '';
    const input = {
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.issuer.npub,
      processedKeys,
      subscriptionManager: {
        importAgentConnectPackage: async (input) => {
          imports += 1;
          importSource = input.onboardingSource ?? '';
          return { subscription: { subscriptionId: 'sub-1' } };
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({
        allowed: true,
        service_npub: fixture.service.npub,
        workspace_owner_npub: fixture.workspaceOwner.npub,
      }), { status: 200 }),
      onPostConnectSync: async () => {
        syncs += 1;
      },
    };
    const first = await processAccessGrantEvent(input);
    const second = await processAccessGrantEvent(input);
    expect(first.ok).toBe(true);
    expect(first.code).toBe('imported');
    expect(second.ok).toBe(true);
    expect(second.code).toBe('duplicate_skipped');
    expect(imports).toBe(1);
    expect(importSource).toBe('nostr_33357');
    expect(syncs).toBe(1);
  });

  test('confirms revoked onboarding with Tower before handling local removal', async () => {
    const fixture = makeCurrentFlightDeckGrantEvent({
      payload: {
        action: 'deleted',
        status: 'deleted',
        agent_connect: undefined,
        agent_connect_package: undefined,
        revocation: {
          reason: 'workspace_deleted',
          revoked_at: '2026-06-06T00:00:00.000Z',
          source: 'tower',
        },
      },
    });
    let imports = 0;
    let handledVerification = '';
    let revocationSyncs = 0;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.issuer.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return {};
        },
        handleAccessGrantRevocation: async (input) => {
          handledVerification = input.verification.towerResult;
          return { updatedSubscriptions: ['sub-1'] };
        },
      },
      fetchImpl: async () => new Response('', { status: 410 }),
      onPostRevocationSync: async () => {
        revocationSyncs += 1;
      },
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe('revocation_confirmed');
    expect(handledVerification).toBe('workspace_deleted');
    expect(imports).toBe(0);
    expect(revocationSyncs).toBe(1);
  });

  test('keeps revoked onboarding active when Tower still confirms access', async () => {
    const fixture = makeCurrentFlightDeckGrantEvent({
      payload: {
        action: 'revoked',
        status: 'revoked',
        agent_connect: undefined,
        agent_connect_package: undefined,
      },
    });
    let imports = 0;
    let handledConfirmed = true;
    let revocationSyncs = 0;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.issuer.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return {};
        },
        handleAccessGrantRevocation: async (input) => {
          handledConfirmed = input.verification.confirmed;
          return { diagnostic: 'recorded' };
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({
        allowed: true,
        service_npub: fixture.service.npub,
        workspace_owner_npub: fixture.workspaceOwner.npub,
      }), { status: 200 }),
      onPostRevocationSync: async () => {
        revocationSyncs += 1;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('revocation_unconfirmed_access_active');
    expect(handledConfirmed).toBe(false);
    expect(imports).toBe(0);
    expect(revocationSyncs).toBe(0);
  });

  test('keeps revoked current Flight Deck onboarding active when PG me_url still confirms access', async () => {
    const fixture = makeCurrentFlightDeckGrantEvent({
      payload: {
        action: 'revoked',
        status: 'revoked',
        agent_connect: undefined,
        agent_connect_package: undefined,
      },
    });
    let handledConfirmed = true;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.issuer.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => ({}),
        handleAccessGrantRevocation: async (input) => {
          handledConfirmed = input.verification.confirmed;
          return { diagnostic: 'recorded' };
        },
      },
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/api/v4/access-grants/verify')) {
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }
        if (url.endsWith('/api/v4/flightdeck-pg/workspaces/workspace-1/me')) {
          return new Response(JSON.stringify({
            identity: {
              tower_service_npub: fixture.service.npub,
              workspace_service_npub: fixture.workspaceService.npub,
              workspace_owner_npub: fixture.workspaceOwner.npub,
              workspace_id: 'workspace-1',
              app_npub: fixture.app.npub,
            },
            actor: {
              npub: fixture.recipient.npub,
            },
            membership: {
              role: 'member',
            },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('revocation_unconfirmed_access_active');
    expect(handledConfirmed).toBe(false);
  });

  test('rejects mismatched Agent Connect packages after Tower verification and before import', async () => {
    const otherWorkspace = makeIdentity();
    const fixture = makeGrantEvent({
      payload: {
        agent_connect_package: {
          kind: 'coworker_agent_connect',
          version: 5,
          generated_at: '2026-06-06T00:00:00.000Z',
          service: { direct_https_url: 'https://tower.example.com', service_npub: null },
          workspace: { owner_npub: otherWorkspace.npub },
          app: { app_npub: makeIdentity().npub, namespace: SBIP0009_APP_NAMESPACE },
          connection_token: encodeToken({
            type: 'superbased_connection',
            direct_https_url: 'https://tower.example.com',
            service_npub: makeIdentity().npub,
            workspace_owner_npub: otherWorkspace.npub,
            app_npub: makeIdentity().npub,
          }),
        },
      },
    });
    let imports = 0;
    let syncs = 0;
    const result = await processAccessGrantEvent({
      event: fixture.event,
      recipientSecretKey: fixture.recipient.secret,
      recipientNpub: fixture.recipient.npub,
      managedByNpub: fixture.issuer.npub,
      subscriptionManager: {
        importAgentConnectPackage: async () => {
          imports += 1;
          return {};
        },
      },
      fetchImpl: async () => new Response(JSON.stringify({
        allowed: true,
        service_npub: fixture.service.npub,
        workspace_service_npub: fixture.workspaceService.npub,
        workspace_owner_npub: fixture.workspaceOwner.npub,
      }), { status: 200 }),
      onPostConnectSync: async () => {
        syncs += 1;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('agent_connect_mismatch');
    expect(imports).toBe(0);
    expect(syncs).toBe(0);
  });

  test('returns stable stale and inactive diagnostics without import or sync', async () => {
    const cases = [
      { name: 'expired', overrides: { expires_at: '2026-06-05T00:00:00.000Z' }, code: 'stale_event' },
      { name: 'superseded', overrides: { status: 'superseded' }, code: 'grant_superseded' },
    ];
    for (const entry of cases) {
      const fixture = makeGrantEvent({ payload: entry.overrides });
      let imports = 0;
      let syncs = 0;
      let verifies = 0;
      const result = await processAccessGrantEvent({
        event: fixture.event,
        recipientSecretKey: fixture.recipient.secret,
        recipientNpub: fixture.recipient.npub,
        managedByNpub: fixture.issuer.npub,
        subscriptionManager: {
          importAgentConnectPackage: async () => {
            imports += 1;
            return {};
          },
        },
        fetchImpl: async () => {
          verifies += 1;
          return new Response(JSON.stringify({ allowed: true }), { status: 200 });
        },
        now: new Date('2026-06-06T00:00:01.000Z'),
        onPostConnectSync: async () => {
          syncs += 1;
        },
      });
      expect(result.code).toBe(entry.code);
      expect(result.ok).toBe(false);
      expect(imports).toBe(0);
      expect(syncs).toBe(0);
      expect(verifies).toBe(0);
    }
  });
});

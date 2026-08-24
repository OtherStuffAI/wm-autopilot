import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import {
  buildFlightDeckPgMessageInstructionSignature,
  createFlightDeckPgChannelDocument,
  decodeFlightDeckPgDocumentBody,
  fetchFlightDeckPgDailyScope,
  fetchFlightDeckPgEvents,
  parseTowerError,
  reconcileFlightDeckPgEventSubscriptionAgents,
  upsertFlightDeckPgAgentActivity,
  upsertFlightDeckPgDailyScope,
} from './tower-client';

describe('Flight Deck PG Tower client', () => {
  test('signs one event stream request with a sorted repeatable agent audience', async () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return Response.json({ events: [], next_cursor: 'eyJyb3dfdmVyc2lvbiI6MTB9', subscription_audience_npubs: ['npub1Builder', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg'] });
    }) as typeof fetch;
    try {
      await fetchFlightDeckPgEvents({
        backendBaseUrl: 'http://tower.test', workspaceId: 'workspace-1', appNpub: 'npub1app',
        botIdentity: { botNpub, botPubkeyHex, botSecret }, audienceNpubs: ['npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1Builder', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg'],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(new URL(requestedUrl).searchParams.getAll('audience_npub')).toEqual(['npub1Builder', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg']);
  });

  test('atomically reconciles the managed agent audience with the legacy response field', async () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const originalFetch = globalThis.fetch;
    let request: { url: string; init?: RequestInit } | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init };
      return Response.json({ manager_npub: botNpub, agent_npubs: ['npub1Builder', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg'] });
    }) as typeof fetch;
    let result: Awaited<ReturnType<typeof reconcileFlightDeckPgEventSubscriptionAgents>> | undefined;
    try {
      result = await reconcileFlightDeckPgEventSubscriptionAgents({
        backendBaseUrl: 'http://tower.test', workspaceId: 'workspace-1', appNpub: 'npub1app',
        botIdentity: { botNpub, botPubkeyHex, botSecret }, agentNpubs: ['npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1Builder'],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(request!.url).toEndWith('/api/v4/flightdeck-pg/workspaces/workspace-1/event-subscription-agents');
    expect(request!.init?.method).toBe('PUT');
    expect(JSON.parse(String(request!.init?.body))).toEqual({ agent_npubs: ['npub1Builder', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg'] });
    expect(result?.audience_npubs).toEqual(['npub1Builder', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg']);
    expect(result?.rejected_audience).toEqual([]);
  });

  test('prefers the identity-neutral audience response and preserves rejection diagnostics', async () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      manager_npub: botNpub,
      agent_npubs: ['npub1legacy'],
      audience_npubs: ['npub1accepted'],
      rejected_audience: [{ npub: 'npub1removed', code: 'inactive_or_unknown_workspace_member' }],
    })) as typeof fetch;
    try {
      const result = await reconcileFlightDeckPgEventSubscriptionAgents({
        backendBaseUrl: 'http://tower.test', workspaceId: 'workspace-1', appNpub: 'npub1app',
        botIdentity: { botNpub, botPubkeyHex, botSecret }, agentNpubs: ['npub1accepted', 'npub1removed'],
      });
      expect(result.agent_npubs).toEqual(['npub1accepted']);
      expect(result.audience_npubs).toEqual(['npub1accepted']);
      expect(result.rejected_audience).toEqual([{ npub: 'npub1removed', code: 'inactive_or_unknown_workspace_member' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('surfaces an undeployed Tower managed-agent audience contract precisely', async () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as typeof fetch;
    try {
      await expect(reconcileFlightDeckPgEventSubscriptionAgents({
        backendBaseUrl: 'http://tower.test', workspaceId: 'workspace-1', appNpub: 'npub1app',
        botIdentity: { botNpub, botPubkeyHex, botSecret }, agentNpubs: ['npub1Builder'],
      })).rejects.toMatchObject({
        detailCode: 'flightdeck_pg_event_subscription_agents_contract_missing',
        message: 'Tower does not expose the managed-agent event subscription contract.',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('preserves Tower idempotency conflict codes for durable publication reconciliation', async () => {
    const error = await parseTowerError(new Response(JSON.stringify({
      error: 'client_request_id was already used for a materially different message',
      code: 'idempotency_conflict',
    }), { status: 409 }), 'flightdeck_pg_channel_message_create');
    expect(error).toMatchObject({ status: 409, detailCode: 'idempotency_conflict' });
  });

  test('serializes the immutable turn identity in agent activity PUTs', async () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const originalFetch = globalThis.fetch;
    let request: { url: string; init?: RequestInit } | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init };
      return Response.json({ agent_activity: { id: 'activity-1', turn_id: 'turn-1' } });
    }) as typeof fetch;
    try {
      await upsertFlightDeckPgAgentActivity({
        backendBaseUrl: 'http://tower.test', workspaceId: 'workspace-1', activityId: 'activity-1',
        appNpub: 'npub1app', botIdentity: { botNpub, botPubkeyHex, botSecret }, channelId: 'channel-1',
        threadId: 'thread-1', triggerMessageId: 'message-1', turnId: 'turn-1', sessionId: 'session-1',
        agentNpub: botNpub, state: 'working', sequence: 1_786_336_283_299_001,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(request!.url).toEndWith('/api/v4/flightdeck-pg/workspaces/workspace-1/agent-activities/activity-1');
    expect(request!.init?.method).toBe('PUT');
    expect(JSON.parse(String(request!.init?.body))).toEqual({
      channel_id: 'channel-1', thread_id: 'thread-1', trigger_message_id: 'message-1', turn_id: 'turn-1',
      session_id: 'session-1', agent_npub: botNpub, state: 'working', visibility: 'user_visible', sequence: 1_786_336_283_299_001,
    });
  });

  test('preserves Tower validation fields for activity publication telemetry', async () => {
    const error = await parseTowerError(new Response(JSON.stringify({
      error: 'Request body failed validation',
      code: 'validation_error',
      details: { fields: [{ path: 'sequence', code: 'invalid', message: 'sequence must be a non-negative safe integer' }] },
    }), { status: 400 }), 'flightdeck_pg_agent_activity_upsert');
    expect(error).toEqual({
      status: 400,
      message: 'Request body failed validation',
      detailCode: 'validation_error',
      details: { fields: [{ path: 'sequence', code: 'invalid', message: 'sequence must be a non-negative safe integer' }] },
    });
  });

  test('builds a signed PG message instruction for bot-authored replies', () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const body = 'I am here and ready.';
    const signature = buildFlightDeckPgMessageInstructionSignature({
      botIdentity: { botNpub, botPubkeyHex, botSecret },
      body,
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });
    const event = signature.nostr_event as Parameters<typeof verifyEvent>[0];
    const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');

    expect(signature).toMatchObject({
      version: 1,
      protocol: 'flightdeck_pg_message_instruction',
      kind: 33358,
      signer_npub: botNpub,
      body_sha256: bodySha256,
    });
    expect(verifyEvent(event)).toBe(true);
    expect(event.content).toBe(body);
    expect(event.tags).toEqual(expect.arrayContaining([
      ['protocol', 'flightdeck_pg_message_instruction'],
      ['body_sha256', bodySha256],
      ['workspace_id', 'workspace-1'],
      ['channel_id', 'channel-1'],
      ['thread_id', 'thread-1'],
    ]));
  });

  test('creates PG channel documents with Flight Deck document content storage', async () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ url, init });
      if (url.endsWith('/storage/prepare')) {
        return new Response(JSON.stringify({
          object_id: 'object-1',
          upload_url: 'http://tower.test/upload/object-1',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/v4/storage/object-1') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ object_id: 'object-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/v4/storage/object-1/complete')) {
        return new Response(JSON.stringify({ object_id: 'object-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/channels/channel-1/docs')) {
        return new Response(JSON.stringify({
          doc: {
            id: 'doc-1',
            storage_object_id: 'object-1',
            title: 'Plan',
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    try {
      await createFlightDeckPgChannelDocument({
        backendBaseUrl: 'http://tower.test',
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
        appNpub: 'npub_app',
        botIdentity: { botNpub, botPubkeyHex, botSecret },
        title: 'Plan',
        body: '# Updated\n\nBody',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const prepare = requests.find((request) => request.url.endsWith('/storage/prepare'));
    expect(JSON.parse(String(prepare?.init?.body))).toMatchObject({
      content_type: 'application/vnd.wingman.flightdeck.document-content+json',
    });

    const upload = requests.find((request) => request.url.endsWith('/api/v4/storage/object-1') && request.init?.method === 'PUT');
    expect(upload?.init?.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
    const uploadBody = JSON.parse(String(upload?.init?.body));
    const uploadedBody = JSON.parse(Buffer.from(uploadBody.base64_data, 'base64').toString('utf8'));
    expect(uploadedBody).toMatchObject({
      format: 'document_content_v1',
      content_model: {
        content: '# Updated\n\nBody',
        content_blocks: [],
      },
    });
  });

  test('decodes Flight Deck document content storage bodies', () => {
    const base64_data = Buffer.from(JSON.stringify({
      format: 'document_content_v1',
      content_model: {
        content: '# Existing\n\nBody',
        content_format: null,
        content_blocks: [],
      },
    })).toString('base64');

    expect(decodeFlightDeckPgDocumentBody({ body: { encoding: 'base64', base64_data } })).toBe('# Existing\n\nBody');
  });

  test('reads and upserts Daily Scope through signed Flight Deck PG routes', async () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ url, init });
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({
          daily_note: {
            id: 'daily-1',
            owner_actor_id: 'owner-1',
            note_date: '2026-06-17',
            items: JSON.parse(String(init.body)).items,
            body: JSON.parse(String(init.body)).body,
            row_version: 2,
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        daily_notes: [{ id: 'daily-1', owner_actor_id: 'owner-1', note_date: '2026-06-17', row_version: 1 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
      const read = await fetchFlightDeckPgDailyScope({
        backendBaseUrl: 'http://tower.test',
        workspaceId: 'workspace-1',
        appNpub: 'npub-app',
        botIdentity: { botNpub, botPubkeyHex, botSecret },
        ownerActorId: 'owner-1',
        noteDate: '2026-06-17',
      });
      expect(read.daily_notes[0].id).toBe('daily-1');

      const write = await upsertFlightDeckPgDailyScope({
        backendBaseUrl: 'http://tower.test',
        workspaceId: 'workspace-1',
        appNpub: 'npub-app',
        botIdentity: { botNpub, botPubkeyHex, botSecret },
        ownerActorId: 'owner-1',
        noteDate: '2026-06-17',
        body: 'Morning narrative',
        items: [
          { text: 'One', completed: false },
          { text: 'Two', completed: false },
          { text: 'Three', completed: false },
          { text: 'Four', completed: false },
          { text: 'Five', completed: false },
          { text: 'Six', completed: false },
        ],
      });
      expect(write.daily_note.id).toBe('daily-1');
    } finally {
      globalThis.fetch = originalFetch;
    }

    const readRequest = requests.find((request) => request.init?.method !== 'POST');
    expect(readRequest?.url).toContain('/api/v4/flightdeck-pg/workspaces/workspace-1/daily-notes');
    expect(readRequest?.url).toContain('owner_actor_id=owner-1');
    expect(readRequest?.url).toContain('note_date=2026-06-17');
    expect(readRequest?.init?.headers).toMatchObject({
      Accept: 'application/json',
      'x-flightdeck-pg-app-npub': 'npub-app',
    });

    const writeRequest = requests.find((request) => request.init?.method === 'POST');
    const writeBody = JSON.parse(String(writeRequest?.init?.body));
    expect(writeBody).toMatchObject({
      owner_actor_id: 'owner-1',
      note_date: '2026-06-17',
      title: 'Daily Scope',
      body: 'Morning narrative',
      metadata: { source: 'agent', autopilot_daily_scope_helper: true },
    });
    expect(writeBody.items).toHaveLength(5);
  });

  test('maps Daily Scope permission failures to daily_scope_forbidden', async () => {
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: 'Daily Scope access denied',
      message: 'permission denied',
    }), { status: 403, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    try {
      let thrown: unknown;
      try {
        await fetchFlightDeckPgDailyScope({
          backendBaseUrl: 'http://tower.test',
          workspaceId: 'workspace-1',
          appNpub: 'npub-app',
          botIdentity: { botNpub, botPubkeyHex, botSecret },
          ownerActorId: 'owner-1',
          noteDate: '2026-06-17',
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('Daily Scope access');
      expect((thrown as { detailCode?: string }).detailCode).toBe('daily_scope_forbidden');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

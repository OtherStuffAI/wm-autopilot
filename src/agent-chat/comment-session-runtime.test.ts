import { describe, expect, test } from 'bun:test';

import type { SessionSnapshot } from '../agents/process-manager';
import type { SessionMetadataInput } from '../sessions/session-metadata';
import { AgentCommentSessionRuntime } from './comment-session-runtime';
import type {
  AgentDefinitionRecord,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
} from './types';

function makeSession(
  id: string,
  metadata: SessionSnapshot['metadata'] = { AGENT: true, billingMode: 'subscription' },
): SessionSnapshot {
  return {
    id,
    agent: 'codex',
    port: 3700,
    name: id,
    status: 'running',
    agentRuntimeStatus: 'stable',
    startedAt: new Date().toISOString(),
    npub: 'npub1manager',
    pid: 1234,
    command: ['codex'],
    workingDirectory: '/tmp/comment-agent',
    logs: [],
    metadata,
  };
}

function mergeSessionMetadata(
  existing: SessionSnapshot,
  metadata: SessionMetadataInput,
): SessionSnapshot['metadata'] {
  const existingMetadata = existing.metadata ?? { AGENT: true, billingMode: 'subscription' };
  return {
    ...existingMetadata,
    ...(metadata ?? {}),
    AGENT: metadata?.AGENT ?? existingMetadata.AGENT,
    billingMode: metadata?.billingMode ?? existingMetadata.billingMode,
  };
}

function makeSubscription(): WorkspaceSubscriptionRecord {
  const now = new Date().toISOString();
  return {
    subscriptionId: 'sub-comment-1',
    workspaceOwnerNpub: 'npub1workspace',
    backendBaseUrl: 'https://tower.example.com',
    botNpub: 'npub1bot',
    sourceAppNpub: 'npub1source',
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
  };
}

function makeAgent(): AgentDefinitionRecord {
  const now = new Date().toISOString();
  return {
    agentId: 'agent-comment',
    label: 'Comment Agent',
    botNpub: 'npub1bot',
    workspaceOwnerNpub: 'npub1workspace',
    groupNpubs: ['npub1group'],
    workingDirectory: '/tmp/comment-agent',
    capabilities: ['chat_intercept'],
    chatPromptTemplate: '',
    taskPromptTemplate: '',
    flowDispatchPromptTemplate: '',
    taskReviewPromptTemplate: '',
    approvalDispatchPromptTemplate: '',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    managedByNpub: 'npub1manager',
  };
}

function makeBotIdentity(): RuntimeBotIdentity {
  return {
    botNpub: 'npub1bot',
    botPubkeyHex: 'ab'.repeat(32),
    botSecret: new Uint8Array(32),
  };
}

function makeDocumentCommentInput(commentId = 'comment-1') {
  return {
    subscription: makeSubscription(),
    agent: makeAgent(),
    recordId: `record-${commentId}`,
    comment: {
      commentId,
      targetRecordId: 'doc-1',
      targetRecordFamilyHash: 'npub1source:document',
      parentCommentId: null,
      anchorLineNumber: 42,
      commentStatus: 'open' as const,
      body: 'Please update this section and respond in the thread.',
      attachments: [],
      senderNpub: 'npub1reviewer',
      recordState: 'active',
    },
    botIdentity: makeBotIdentity(),
  };
}

describe('AgentCommentSessionRuntime', () => {
  test('creates then reuses a document comment thread session and queues reply instructions', async () => {
    const sessions = new Map<string, SessionSnapshot>();
    const prompts: Array<{ sessionId: string; content: string }> = [];
    const dispatches: string[] = [];
    let createCount = 0;

    const runtime = new AgentCommentSessionRuntime({
      defaultAgent: 'codex',
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      listSessions: () => [...sessions.values()],
      createSession: async (_agent, workingDirectory, name, origin, explicitNpub, metadata) => {
        createCount += 1;
        const session = makeSession(`comment-session-${createCount}`, {
          AGENT: true,
          billingMode: 'subscription',
          ...metadata,
        });
        session.name = name;
        session.origin = origin;
        session.npub = explicitNpub;
        session.workingDirectory = workingDirectory;
        sessions.set(session.id, session);
        return session;
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next: SessionSnapshot = {
          ...existing,
          metadata: mergeSessionMetadata(existing, metadata),
        };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: (sessionId, content) => {
        prompts.push({ sessionId, content });
        return null;
      },
      hasQueuedPrompt: (sessionId, content) =>
        prompts.some((prompt) => prompt.sessionId === sessionId && prompt.content === content),
      maybeAutoDispatchQueuedPrompt: (session) => {
        if (session) {
          dispatches.push(session.id);
        }
      },
      prepareWorkspaceYokeRuntime: async () => ({
        stateDir: '/tmp/agent-comment-thread',
        commandPrefix: 'ignored',
        didSync: true,
      }),
    });

    const input = makeDocumentCommentInput();

    const first = await runtime.handleDocumentCommentDispatch(input);
    const second = await runtime.handleDocumentCommentDispatch(input);

    expect(first?.id).toBe('comment-session-1');
    expect(second?.id).toBe('comment-session-1');
    expect(createCount).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.content).toContain('Dispatch reason: document comment added.');
    expect(prompts[0]?.content).toContain('/docs?docid=doc-1&commentid=comment-1');
    expect(prompts[0]?.content).toContain("docs show 'doc-1'");
    expect(prompts[0]?.content).toContain("docs reply 'comment-1'");
    expect(sessions.get('comment-session-1')?.metadata?.bindingType).toBe('thread');
    expect(sessions.get('comment-session-1')?.metadata?.routedBy).toBe('agent-comment');
    expect(dispatches).toEqual(['comment-session-1', 'comment-session-1']);
  });

  test('reuses one document comment session for separate comments on the same document', async () => {
    const sessions = new Map<string, SessionSnapshot>();
    const prompts: Array<{ sessionId: string; content: string }> = [];
    const dispatches: string[] = [];
    let createCount = 0;

    const runtime = new AgentCommentSessionRuntime({
      defaultAgent: 'codex',
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      listSessions: () => [...sessions.values()],
      createSession: async (_agent, workingDirectory, name, origin, explicitNpub, metadata) => {
        createCount += 1;
        const session = makeSession(`comment-session-${createCount}`, {
          AGENT: true,
          billingMode: 'subscription',
          ...metadata,
        });
        session.name = name;
        session.origin = origin;
        session.npub = explicitNpub;
        session.workingDirectory = workingDirectory;
        sessions.set(session.id, session);
        return session;
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next: SessionSnapshot = {
          ...existing,
          metadata: mergeSessionMetadata(existing, metadata),
        };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: (sessionId, content) => {
        prompts.push({ sessionId, content });
        return null;
      },
      hasQueuedPrompt: (sessionId, content) =>
        prompts.some((prompt) => prompt.sessionId === sessionId && prompt.content === content),
      maybeAutoDispatchQueuedPrompt: (session) => {
        if (session) {
          dispatches.push(session.id);
        }
      },
      prepareWorkspaceYokeRuntime: async () => ({
        stateDir: '/tmp/agent-comment-thread',
        commandPrefix: 'ignored',
        didSync: true,
      }),
    });

    const first = await runtime.handleDocumentCommentDispatch(makeDocumentCommentInput('comment-1'));
    const second = await runtime.handleDocumentCommentDispatch(makeDocumentCommentInput('comment-2'));

    expect(first?.id).toBe('comment-session-1');
    expect(second?.id).toBe('comment-session-1');
    expect(createCount).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.content).toContain('/docs?docid=doc-1&commentid=comment-2');
    expect(dispatches).toEqual(['comment-session-1', 'comment-session-1']);
  });

  test('does not recreate document comment work after the document session was stopped', async () => {
    const sessions = new Map<string, SessionSnapshot>();
    const prompts: Array<{ sessionId: string; content: string }> = [];
    const stoppedSession = makeSession('stopped-comment-session', {
      AGENT: true,
      billingMode: 'subscription',
      routedBy: 'agent-comment',
      agentChatAgentId: 'agent-comment',
      bindingType: 'thread',
      bindingId: 'legacy-thread-key',
      nextActionPayload: '/docs?docid=doc-1&commentid=comment-previous',
    });
    stoppedSession.status = 'stopped';
    sessions.set(stoppedSession.id, stoppedSession);

    const runtime = new AgentCommentSessionRuntime({
      defaultAgent: 'codex',
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      listSessions: () => [...sessions.values()],
      createSession: async () => {
        throw new Error('createSession should not run after comment work is stopped');
      },
      updateSessionMetadata: () => {
        throw new Error('updateSessionMetadata should not run after comment work is stopped');
      },
      addPrompt: (sessionId, content) => {
        prompts.push({ sessionId, content });
        return null;
      },
      maybeAutoDispatchQueuedPrompt: () => {
        throw new Error('maybeAutoDispatchQueuedPrompt should not run after comment work is stopped');
      },
      prepareWorkspaceYokeRuntime: async () => ({
        stateDir: '/tmp/agent-comment-thread',
        commandPrefix: 'ignored',
        didSync: true,
      }),
    });

    const session = await runtime.handleDocumentCommentDispatch(makeDocumentCommentInput('comment-2'));

    expect(session).toBeNull();
    expect(prompts).toHaveLength(0);
  });
});

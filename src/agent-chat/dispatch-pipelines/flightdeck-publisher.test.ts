import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  DuplicateCallbackPublicationDecisionStore,
  DuplicateCallbackPublicationFilter,
} from '../duplicate-callback-publication-filter';
import { buildDirectChatRoutingKey } from '../direct-chat-contract';

const yokeCommandCalls: string[][] = [];
const pgMessageFetchCalls: Array<Record<string, unknown>> = [];
const pgMessageCreateCalls: Array<Record<string, unknown>> = [];
const pgStorageUploadCalls: Array<Record<string, unknown>> = [];
const pgDocumentCreateCalls: Array<Record<string, unknown>> = [];
const pgDocumentListCalls: Array<Record<string, unknown>> = [];
const pgDocumentFetchCalls: Array<Record<string, unknown>> = [];
const pgDocumentCommentFetchCalls: Array<Record<string, unknown>> = [];
const pgAudioNoteCreateCalls: Array<Record<string, unknown>> = [];
const pgReactionCreateCalls: Array<Record<string, unknown>> = [];
const pgTaskCreateCalls: Array<Record<string, unknown>> = [];
const pgTaskFetchCalls: Array<Record<string, unknown>> = [];
const pgTaskCommentFetchCalls: Array<Record<string, unknown>> = [];
const pgTaskStateUpdateCalls: Array<Record<string, unknown>> = [];
const pgTaskCommentCreateCalls: Array<Record<string, unknown>> = [];
const pgLeaseAcquireCalls: Array<Record<string, unknown>> = [];
const pgWorkspaceMemberFetchCalls: Array<Record<string, unknown>> = [];
const pgTaskAssignmentCalls: Array<Record<string, unknown>> = [];
const pgResponseActivityUpsertCalls: Array<Record<string, unknown>> = [];
let failChatContextCount = 0;
let failReactionCount = 0;
let failTaskCreateCount = 0;
let pgHydratedMessageBody = 'Hydrated PG thread body.';

async function flushBackgroundSpeech(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

const runAgentWorkspaceYokeCommandMock = mock(async (input: { args: string[] }) => {
  yokeCommandCalls.push(input.args);
  if (input.args[0] === 'chat' && input.args[1] === 'context') {
    if (failChatContextCount > 0) {
      failChatContextCount -= 1;
      throw new Error(`Chat thread not found locally: ${input.args[input.args.indexOf('--thread') + 1]}`);
    }
    return JSON.stringify({
      channel_id: input.args[input.args.indexOf('--channel') + 1],
      thread_id: input.args[input.args.indexOf('--thread') + 1],
      recent_messages: [
        {
          message_id: 'chat-message-1',
          sender_npub: 'npub1requester',
          body: 'Hydrated thread body.',
        },
      ],
    });
  }
  if (input.args[0] === 'chat' && input.args[1] === 'react') {
    if (failReactionCount > 0) {
      failReactionCount -= 1;
      throw new Error('reaction sync failed');
    }
    return JSON.stringify({
      reacted: true,
      status: 'ok',
      target_record_id: input.args[input.args.indexOf('--message') + 1],
      emoji: input.args[input.args.indexOf('--emoji') + 1],
    });
  }
  if (input.args[0] === 'tasks' && input.args[1] === 'create') {
    if (failTaskCreateCount > 0) {
      failTaskCreateCount -= 1;
      throw new Error('fetch failed');
    }
    return JSON.stringify({
      record_id: 'task-created-1',
      synced: 1,
      created: 1,
      rejected: [],
      warnings: [],
    });
  }
  if (input.args[0] === 'docs' && input.args[1] === 'create') {
    return JSON.stringify({
      record_id: 'doc-created-1',
      synced: 1,
      created: 1,
      rejected: [],
      warnings: [],
    });
  }
  if (input.args[0] === 'chat' && input.args[1] === 'reply-current') {
    return JSON.stringify({
      channel_id: input.args[input.args.indexOf('--channel') + 1],
      thread_id: input.args[input.args.indexOf('--thread') + 1],
      message_id: 'chat-reply-1',
      status: 'sent',
    });
  }
  return JSON.stringify({
    synced: 1,
    created: input.args[0] === 'tasks' && input.args[1] === 'comment' ? 1 : 0,
    updated: input.args[0] === 'tasks' && input.args[1] === 'update' ? 1 : 0,
    rejected: [],
    warnings: [],
  });
});

mock.module('../yoke-runtime', () => ({
  buildAgentChatYokeCommands: () => ({}),
  buildAgentDocumentCommentYokeCommands: () => ({}),
  buildAgentTaskCommentYokeCommands: () => ({}),
  prepareAgentWorkspaceYokeRuntime: mock(async () => ({
    stateDir: '/tmp/yoke-state',
    commandPrefix: 'node yoke',
    didSync: true,
  })),
  runAgentWorkspaceYokeCommand: runAgentWorkspaceYokeCommandMock,
}));

mock.module('../../server/audio-speech', () => ({
  normalizeSpeechText: (value: string) => value
    .replace(/!?@?\[([^\]\n]+)\]\((?:mention:[^)]+|[^)]*[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[^)]*)\)/gi, '$1')
    .replace(/!?@?\[([^\]\n]+)\]\([^)]+\)/g, '$1')
    .replace(/\s*\((?:mention:[^)]+|[^)]*[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[^)]*)\)/gi, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '')
    .replace(/\s+/g, ' ')
    .trim(),
  generateSpeechAudio: mock(async () => ({
    audio: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/mpeg',
    model: 'hexgrad/kokoro-82m',
    voice: 'af_heart',
    format: 'mp3',
  })),
  resolveSpeechExtension: (format: string) => format === 'wav' ? '.wav' : '.mp3',
}));

mock.module('../../server/speech-summary', () => ({
  generateSpeechSummary: mock(async () => 'Short spoken summary.'),
}));

mock.module('../tower-client', () => ({
  fetchFlightDeckPgChannelMessages: mock(async (input: Record<string, unknown>) => {
    pgMessageFetchCalls.push(input);
    return {
      messages: [
        {
          id: 'pg-message-1',
          channel_id: input.channelId,
          thread_id: input.threadId,
          body: pgHydratedMessageBody,
          created_by_actor_id: 'actor-requester',
          created_at: '2026-06-10T01:00:00.000Z',
          row_version: 12,
          metadata: {},
        },
      ],
      next_cursor: null,
    };
  }),
  fetchFlightDeckPgScopeChannels: mock(async () => ({
    channels: [
      {
        id: 'channel-1',
        scope_id: 'scope-1',
        name: 'Features',
        metadata: {
          basePrompt: 'Iterate on feature docs before implementing.',
        },
      },
    ],
    next_cursor: null,
  })),
  createFlightDeckPgChannelMessage: mock(async (input: Record<string, unknown>) => {
    pgMessageCreateCalls.push(input);
    return {
      message: {
        id: 'pg-reply-1',
        channel_id: input.channelId,
        thread_id: input.threadId,
        body: input.body,
      },
    };
  }),
  createFlightDeckPgChannelDocument: mock(async (input: Record<string, unknown>) => {
    pgDocumentCreateCalls.push(input);
    return {
      doc: {
        id: 'pg-doc-created-1',
        channel_id: input.channelId,
        title: input.title,
        row_version: 1,
      },
    };
  }),
  listFlightDeckPgChannelDocs: mock(async (input: Record<string, unknown>) => {
    pgDocumentListCalls.push(input);
    return {
      channel_id: input.channelId,
      docs: [
        {
          id: 'pg-doc-adapt-feedback',
          channel_id: input.channelId,
          title: 'Adapt - Kindling Feedback',
          row_version: 4,
        },
      ],
      next_cursor: null,
    };
  }),
  fetchFlightDeckPgDocument: mock(async (input: Record<string, unknown>) => {
    pgDocumentFetchCalls.push(input);
    return {
      doc: {
        id: input.documentId,
        title: 'Design for Autopilot Overview',
        row_version: 7,
      },
      body: {
        encoding: 'base64',
        base64_data: Buffer.from(JSON.stringify({
          body: '# Design for Autopilot Overview\n\nBuild the Autopilot overview screen.',
        }), 'utf8').toString('base64'),
      },
    };
  }),
  fetchFlightDeckPgDocumentComments: mock(async (input: Record<string, unknown>) => {
    pgDocumentCommentFetchCalls.push(input);
    return {
      doc_id: input.documentId,
      comments: [
        {
          id: 'doc-comment-1',
          doc_id: input.documentId,
          body: 'Please make the padding fix more explicit.',
          created_by_actor_npub: 'npub1requester',
          created_at: '2026-06-10T02:00:00.000Z',
        },
      ],
      next_cursor: null,
    };
  }),
  decodeFlightDeckPgDocumentBody: (result: any) => {
    const raw = Buffer.from(result.body.base64_data, 'base64').toString('utf8');
    return JSON.parse(raw).body;
  },
  uploadFlightDeckPgStorageObject: mock(async (input: Record<string, unknown>) => {
    pgStorageUploadCalls.push(input);
    return {
      object_id: 'storage-tts-1',
      content_type: input.contentType,
      size_bytes: input.content instanceof Uint8Array ? input.content.byteLength : 0,
    };
  }),
  createFlightDeckPgAudioNote: mock(async (input: Record<string, unknown>) => {
    pgAudioNoteCreateCalls.push(input);
    return {
      audio_note: {
        id: 'audio-note-tts-1',
        storage_object_id: input.storageObjectId,
        target_type: input.targetType,
        target_id: input.targetId,
      },
    };
  }),
  createFlightDeckPgReaction: mock(async (input: Record<string, unknown>) => {
    pgReactionCreateCalls.push(input);
    return {
      reaction: {
        target_type: input.targetType,
        target_id: input.targetId,
        emoji: input.emoji,
      },
    };
  }),
  upsertFlightDeckPgResponseActivity: mock(async (input: Record<string, unknown>) => {
    pgResponseActivityUpsertCalls.push(input);
    return {
      response_activity: {
        id: `activity-${input.status || 'unknown'}`,
        target_type: input.targetType,
        target_id: input.targetId,
        status: input.status,
      },
    };
  }),
  createFlightDeckPgChannelTask: mock(async (input: Record<string, unknown>) => {
    pgTaskCreateCalls.push(input);
    const taskIndex = pgTaskCreateCalls.length;
    return {
      task: {
        id: `pg-task-${taskIndex}`,
        channel_id: input.channelId,
        thread_id: input.threadId,
        title: input.title,
        description: input.description,
        state: input.state,
        row_version: 1,
      },
    };
  }),
  fetchFlightDeckPgTask: mock(async (input: Record<string, unknown>) => {
    pgTaskFetchCalls.push(input);
    return {
      task: {
        id: input.taskId,
        title: 'Fix padding',
        description: 'The dashboard cards need tighter padding.',
        state: 'in_progress',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
        row_version: 2,
      },
    };
  }),
  fetchFlightDeckPgTaskComments: mock(async (input: Record<string, unknown>) => {
    pgTaskCommentFetchCalls.push(input);
    return {
      task_id: input.taskId,
      comments: [
        {
          id: 'task-comment-1',
          task_id: input.taskId,
          body: 'Prior task comment.',
          created_by_actor_npub: 'npub1requester',
          created_at: '2026-06-10T02:00:00.000Z',
        },
      ],
      next_cursor: null,
    };
  }),
  acquireFlightDeckPgEditLease: mock(async (input: Record<string, unknown>) => {
    pgLeaseAcquireCalls.push(input);
    return {
      lease: {
        id: 'lease-1',
        lease_token: 'lease-token-1',
      },
    };
  }),
  updateFlightDeckPgTaskState: mock(async (input: Record<string, unknown>) => {
    pgTaskStateUpdateCalls.push(input);
    return {
      task: {
        id: input.taskId,
        state: input.state,
        row_version: 3,
      },
    };
  }),
  createFlightDeckPgTaskComment: mock(async (input: Record<string, unknown>) => {
    pgTaskCommentCreateCalls.push(input);
    return {
      comment: {
        id: 'pg-comment-1',
        task_id: input.taskId,
        body: input.body,
      },
    };
  }),
  fetchFlightDeckPgWorkspaceMembers: mock(async (input: Record<string, unknown>) => {
    pgWorkspaceMemberFetchCalls.push(input);
    return {
      members: [
        { actor: { id: 'actor-bot', npub: 'npub1bot' } },
        { actor: { id: 'actor-requester', npub: 'npub1requester' } },
      ],
      next_cursor: null,
    };
  }),
  assignFlightDeckPgTask: mock(async (input: Record<string, unknown>) => {
    pgTaskAssignmentCalls.push(input);
    return {
      assignment: {
        task_id: input.taskId,
        actor_id: input.actorId,
      },
    };
  }),
}));

const {
  createDispatchFlightDeckPublisher,
  createDispatchChatContextHydrator,
  createDispatchChatThreadReloader,
  createDispatchDiscussionDocumentEnsurer,
  createDispatchDocumentInvocationContextPreparer,
  createDispatchDocumentInvocationSummaryPublisher,
  createDispatchTaskInvocationContextPreparer,
  createDispatchTaskInvocationResponsePublisher,
  createDispatchChatTaskCreator,
  createDispatchImplementationReviewProgressCommenter,
  createDispatchImplementationReviewTaskEnsurer,
  createDispatchNeedsInputPublisher,
  createDispatchReviewTaskCompleter,
  createDispatchTaskStateUpdater,
} = await import('./flightdeck-publisher');
const { DispatchPipelineRuntime } = await import('./runtime');
const { PipelineStore } = await import('../../pipelines/pipeline-store');

function buildChatPublisherContext(eventInputPatch: Record<string, any> = {}) {
  const payload = {
    channel_id: 'channel-1',
    thread_id: 'thread-1',
    sender_npub: 'npub1requester',
    ...(eventInputPatch.payload ?? {}),
  };
  return {
    eventInput: {
      subscription: {
        subscriptionId: 'sub-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        botNpub: 'npub1bot',
        wsKeyNpub: 'npub1wskey',
        ...(eventInputPatch.subscription ?? {}),
      },
      triggerKind: 'chat',
      capability: 'chat_intercept',
      recordId: 'chat-message-1',
      record: {},
      recordFamily: 'chat',
      recordState: null,
      recordVersion: 1,
      updaterNpub: 'npub1requester',
      bindingType: 'thread',
      bindingId: 'thread-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      ...eventInputPatch,
      subscription: {
        subscriptionId: 'sub-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        botNpub: 'npub1bot',
        wsKeyNpub: 'npub1wskey',
        ...(eventInputPatch.subscription ?? {}),
      },
      payload: {
        ...payload,
        ...(eventInputPatch.payload ?? {}),
      },
    },
    agent: {
      agentId: 'agent-1',
      workingDirectory: '/tmp/agent-work',
    },
    botIdentity: {
      botNpub: 'npub1bot',
      botPubkeyHex: 'ab'.repeat(32),
      botSecret: new Uint8Array(32),
    },
    runtime: {
      mode: eventInputPatch.runtime?.mode ?? 'yoke',
      yokeStateDir: '/tmp/yoke-state',
      commandPrefix: 'node yoke',
      commands: {},
      error: null,
      ...(eventInputPatch.runtime ?? {}),
    },
    userSettingsStore: {
      getAll: () => eventInputPatch.userSettings ?? {},
      set: () => {},
      delete: () => {},
    },
    publicationFilter: eventInputPatch.publicationFilter,
  } as never;
}

describe('dispatch pipeline Flight Deck publisher', () => {
  beforeEach(() => {
    yokeCommandCalls.length = 0;
    pgMessageFetchCalls.length = 0;
    pgMessageCreateCalls.length = 0;
    pgStorageUploadCalls.length = 0;
    pgDocumentCreateCalls.length = 0;
    pgDocumentListCalls.length = 0;
    pgDocumentFetchCalls.length = 0;
    pgDocumentCommentFetchCalls.length = 0;
    pgAudioNoteCreateCalls.length = 0;
    pgReactionCreateCalls.length = 0;
    pgTaskCreateCalls.length = 0;
    pgTaskFetchCalls.length = 0;
    pgTaskCommentFetchCalls.length = 0;
    pgTaskStateUpdateCalls.length = 0;
    pgTaskCommentCreateCalls.length = 0;
    pgLeaseAcquireCalls.length = 0;
    pgWorkspaceMemberFetchCalls.length = 0;
    pgHydratedMessageBody = 'Hydrated PG thread body.';
    pgTaskAssignmentCalls.length = 0;
    pgResponseActivityUpsertCalls.length = 0;
    failChatContextCount = 0;
    failReactionCount = 0;
    failTaskCreateCount = 0;
    runAgentWorkspaceYokeCommandMock.mockClear();
  });

  test('chat context hydration fails closed without Flight Deck PG runtime', async () => {
    const hydrate = createDispatchChatContextHydrator(buildChatPublisherContext());

    const result = await hydrate({ availablePipelines: [] });

    expect(result).toMatchObject({
      hydrated: false,
      status: 'failed',
      operation: 'chat.hydrate-context',
      reason: 'Flight Deck runtime was not prepared.',
    });
    expect(yokeCommandCalls).toHaveLength(0);
  });

  test('document invocation context preparation loads target document, comments, and snapshot', async () => {
    const prepare = createDispatchDocumentInvocationContextPreparer(buildChatPublisherContext({
      triggerKind: 'task',
      capability: 'task_dispatch',
      recordId: 'invocation-1',
      recordFamily: 'invocation',
      bindingType: 'document',
      bindingId: 'doc-1',
      threadId: null,
      subscription: { workspaceId: 'workspace-1' },
      payload: {
        invocation_id: 'invocation-1',
        prompt: 'Please flesh out this fix and check the embedded image.',
        target_id: 'doc-1',
        target_title: 'Bug Padding',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
      },
      runtime: { mode: 'flightdeck_pg' },
    }));

    const result = await prepare({
      agent: { workingDirectory: join(tmpdir(), 'wm-doc-invocation-test') },
      workspace: { workspaceOwnerNpub: 'npub1workspace' },
      flightDeckContext: {
        channel: {
          name: 'Bugs',
          contextPrompt: 'Diagnose before solving.',
          hasSpecificContext: true,
        },
      },
    });

    expect(result).toMatchObject({
      status: 'loaded',
      operation: 'docs.prepare-document-invocation',
      invocation: {
        invocationId: 'invocation-1',
        prompt: 'Please flesh out this fix and check the embedded image.',
      },
      document: {
        documentId: 'doc-1',
        title: 'Design for Autopilot Overview',
        comments: [
          expect.objectContaining({
            commentId: 'doc-comment-1',
          }),
        ],
      },
    });
    expect(pgDocumentFetchCalls).toHaveLength(1);
    expect(pgDocumentFetchCalls[0]).toMatchObject({ documentId: 'doc-1', includeBody: true });
    expect(pgDocumentCommentFetchCalls).toHaveLength(1);
    const localPath = (result as any).document.localPath;
    expect(typeof localPath).toBe('string');
    const snapshot = await readFile(localPath, 'utf8');
    expect(snapshot).toContain('Please flesh out this fix');
    expect(snapshot).toContain('# Design for Autopilot Overview');
  });

  test('document invocation summary publisher posts a channel message with document mention', async () => {
    const publish = createDispatchDocumentInvocationSummaryPublisher(buildChatPublisherContext({
      triggerKind: 'task',
      capability: 'task_dispatch',
      recordId: 'invocation-1',
      recordFamily: 'invocation',
      bindingType: 'document',
      bindingId: 'doc-1',
      threadId: null,
      subscription: { workspaceId: 'workspace-1' },
      payload: {
        invocation_id: 'invocation-1',
        prompt: 'Please update this document.',
        target_id: 'doc-1',
        target_title: 'Bug Padding',
        channel_id: 'channel-1',
      },
      runtime: { mode: 'flightdeck_pg' },
    }));

    const result = await publish({
      invocationContext: {
        invocation: {
          invocationId: 'invocation-1',
          prompt: 'Please update this document.',
        },
        location: {
          channelId: 'channel-1',
        },
        document: {
          documentId: 'doc-1',
          title: 'Bug Padding',
          mention: '@[Bug Padding](mention:document:doc-1)',
        },
      },
      agentResult: {
        summary: 'Expanded the fix and verified the screenshot.',
        changedSections: ['Fix notes'],
        commentsCreated: ['Question about rollout'],
      },
    });

    expect(result).toMatchObject({
      published: true,
      status: 'ok',
      operation: 'docs.publish-document-invocation-summary',
      channelId: 'channel-1',
      documentId: 'doc-1',
    });
    expect(pgMessageCreateCalls).toHaveLength(1);
    expect(pgMessageCreateCalls[0]).toMatchObject({
      channelId: 'channel-1',
      createThread: true,
    });
    expect(String(pgMessageCreateCalls[0].body)).toContain('@[Bug Padding](mention:document:doc-1)');
    expect(String(pgMessageCreateCalls[0].body)).toContain('Expanded the fix');
  });

  test('task invocation context preparation loads target task, comments, and snapshot', async () => {
    const prepare = createDispatchTaskInvocationContextPreparer(buildChatPublisherContext({
      triggerKind: 'task',
      capability: 'task_dispatch',
      recordId: 'invocation-1',
      recordFamily: 'invocation',
      bindingType: 'task',
      bindingId: 'task-1',
      threadId: null,
      subscription: { workspaceId: 'workspace-1' },
      payload: {
        invocation_id: 'invocation-1',
        prompt: 'Please implement the padding fix.',
        target_id: 'task-1',
        target_title: 'Fix padding',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
      },
      runtime: { mode: 'flightdeck_pg' },
    }));

    const result = await prepare({
      agent: { workingDirectory: join(tmpdir(), 'wm-task-invocation-test') },
      workspace: { workspaceOwnerNpub: 'npub1workspace' },
      flightDeckContext: {
        channel: {
          name: 'Bugs',
          contextPrompt: 'Diagnose before solving.',
          hasSpecificContext: true,
        },
      },
    });

    expect(result).toMatchObject({
      status: 'loaded',
      operation: 'tasks.prepare-task-invocation',
      invocation: {
        invocationId: 'invocation-1',
        prompt: 'Please implement the padding fix.',
      },
      task: {
        taskId: 'task-1',
        title: 'Fix padding',
        comments: [
          expect.objectContaining({
            commentId: 'task-comment-1',
            body: 'Prior task comment.',
          }),
        ],
      },
    });
    expect(pgTaskFetchCalls).toHaveLength(1);
    expect(pgTaskFetchCalls[0]).toMatchObject({ taskId: 'task-1' });
    expect(pgTaskCommentFetchCalls).toHaveLength(1);
    expect(pgTaskCommentFetchCalls[0]).toMatchObject({ taskId: 'task-1' });
    const localPath = (result as any).task.localPath;
    expect(typeof localPath).toBe('string');
    const snapshot = await readFile(localPath, 'utf8');
    expect(snapshot).toContain('Please implement the padding fix');
    expect(snapshot).toContain('Prior task comment.');
  });

  test('task invocation response publisher comments on invoked task', async () => {
    const publish = createDispatchTaskInvocationResponsePublisher(buildChatPublisherContext({
      triggerKind: 'task',
      capability: 'task_dispatch',
      recordId: 'invocation-1',
      recordFamily: 'invocation',
      bindingType: 'task',
      bindingId: 'task-1',
      threadId: null,
      subscription: { workspaceId: 'workspace-1' },
      payload: {
        invocation_id: 'invocation-1',
        prompt: 'Please update this task.',
        target_id: 'task-1',
        target_title: 'Fix padding',
        channel_id: 'channel-1',
      },
      runtime: { mode: 'flightdeck_pg' },
    }));

    const result = await publish({
      invocationContext: {
        invocation: {
          invocationId: 'invocation-1',
          prompt: 'Please update this task.',
        },
        location: {
          channelId: 'channel-1',
        },
        task: {
          taskId: 'task-1',
          title: 'Fix padding',
          mention: '@[Fix padding](mention:task:task-1)',
        },
      },
      plan: {
        action: 'direct_response',
        taskId: 'task-1',
        taskComment: 'I checked it and updated the task details.',
      },
    });

    expect(result).toMatchObject({
      published: true,
      status: 'ok',
      operation: 'tasks.publish-task-invocation-response',
      taskId: 'task-1',
    });
    expect(pgTaskCommentCreateCalls).toHaveLength(1);
    expect(pgTaskCommentCreateCalls[0]).toMatchObject({
      workspaceId: 'workspace-1',
      taskId: 'task-1',
    });
    expect(String(pgTaskCommentCreateCalls[0].body)).toContain('I checked it and updated the task details.');
  });

  test.skip('legacy Yoke chat context hydration retries sync and falls back to the dispatch payload', async () => {
    failChatContextCount = 2;
    const hydrate = createDispatchChatContextHydrator({
      eventInput: {
        subscription: {
          subscriptionId: 'sub-1',
          workspaceOwnerNpub: 'npub1workspace',
          sourceAppNpub: 'npub1source',
          backendBaseUrl: 'https://tower.example.com',
          botNpub: 'npub1bot',
          wsKeyNpub: 'npub1wskey',
        },
        triggerKind: 'chat',
        capability: 'chat_intercept',
        recordId: 'chat-message-1',
        record: {},
        payload: {
          channel_id: 'channel-1',
          body: 'Fallback body from dispatch payload.',
          sender_npub: 'npub1requester',
          attachments: [],
          updated_at: '2026-06-01T01:11:45.306Z',
        },
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        bindingType: 'thread',
        bindingId: 'thread-1',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      agent: {
        agentId: 'agent-1',
        workingDirectory: '/tmp/agent-work',
      },
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      runtime: {
        yokeStateDir: '/tmp/yoke-state',
        commandPrefix: 'node yoke',
        commands: {},
        error: null,
      },
    } as never);

    const result = await hydrate({
      availablePipelines: [],
      flightDeckContext: {
        channel: {
          id: 'channel-1',
          scopeId: 'scope-1',
          name: 'Features',
          contextPrompt: 'Iterate on feature docs before implementing.',
          hasSpecificContext: true,
        },
      },
    });

    expect(result).toMatchObject({
      hydrated: true,
      status: 'partial',
      shouldProceed: true,
      fallbackContext: true,
    });
    expect(result.acknowledgement).toMatchObject({
      acknowledged: true,
      status: 'ok',
      operation: 'chat.acknowledge-message',
      emoji: 'shaka',
      targetMessageId: 'chat-message-1',
    });
    expect((result.thread as any).recent_messages[0]).toMatchObject({
      message_id: 'chat-message-1',
      body: 'Fallback body from dispatch payload.',
    });
    expect(result.channelContext).toEqual({
      channelId: 'channel-1',
      scopeId: 'scope-1',
      name: 'Features',
      contextPrompt: 'Iterate on feature docs before implementing.',
      hasSpecificContext: true,
    });
    expect(result.hydrationWarnings).toHaveLength(2);
    expect(yokeCommandCalls.filter((args) => args[0] === 'chat' && args[1] === 'context')).toHaveLength(2);
    expect(yokeCommandCalls.some((args) => args[0] === 'sync')).toBe(true);
  });

  test.skip('legacy Yoke chat context hydration acknowledges eligible inbound messages before scope loading', async () => {
    const hydrate = createDispatchChatContextHydrator(buildChatPublisherContext());

    const result = await hydrate({ availablePipelines: [] });

    expect(result).toMatchObject({
      hydrated: true,
      shouldProceed: true,
      acknowledgement: {
        acknowledged: true,
        status: 'ok',
        operation: 'chat.acknowledge-message',
        emoji: 'shaka',
        targetMessageId: 'chat-message-1',
      },
    });
    const reactionCall = yokeCommandCalls.find((args) => args[0] === 'chat' && args[1] === 'react');
    expect(reactionCall).toContain('--channel');
    expect(reactionCall).toContain('channel-1');
    expect(reactionCall).toContain('--message');
    expect(reactionCall).toContain('chat-message-1');
    expect(reactionCall).toContain('--emoji');
    expect(reactionCall).toContain('shaka');
    expect(reactionCall).toContain('--skip-refresh');
    const reactionIndex = yokeCommandCalls.findIndex((args) => args[0] === 'chat' && args[1] === 'react');
    const scopesIndex = yokeCommandCalls.findIndex((args) => args[0] === 'scopes' && args[1] === 'list');
    expect(reactionIndex).toBeGreaterThan(-1);
    expect(scopesIndex).toBeGreaterThan(reactionIndex);
  });

  test('chat context hydration reads and acknowledges through Flight Deck PG when workspace id is present', async () => {
    const hydrate = createDispatchChatContextHydrator(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    const result = await hydrate({ availablePipelines: [] });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgMessageFetchCalls).toHaveLength(1);
    expect(pgMessageFetchCalls[0]).toMatchObject({
      workspaceId: 'workspace-pg-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });
    expect(pgReactionCreateCalls).toHaveLength(1);
    expect(pgReactionCreateCalls[0]).toMatchObject({
      targetType: 'message',
      targetId: 'chat-message-1',
      emoji: 'thumbs_up',
    });
    expect(result).toMatchObject({
      hydrated: true,
      status: 'ok',
      shouldProceed: true,
      fallbackContext: false,
      acknowledgement: {
        acknowledged: true,
        status: 'ok',
        emoji: 'thumbs_up',
      },
      thread: {
        recent_messages: [
          {
            message_id: 'pg-message-1',
            body: 'Hydrated PG thread body.',
            sender_actor_id: 'actor-requester',
          },
        ],
      },
    });
  });

  test('chat context hydration resolves quoted Flight Deck PG document titles', async () => {
    pgHydratedMessageBody = 'Can you review the doc "Adapt - Kindling Feedback" in this scope?';
    const hydrate = createDispatchChatContextHydrator(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    const result = await hydrate({ availablePipelines: [] });

    expect(pgDocumentListCalls).toHaveLength(1);
    expect(pgDocumentListCalls[0]).toMatchObject({
      workspaceId: 'workspace-pg-1',
      channelId: 'channel-1',
    });
    expect(result.referencedRecords).toEqual([
      expect.objectContaining({
        type: 'document',
        family: 'document',
        id: 'pg-doc-adapt-feedback',
        recordId: 'pg-doc-adapt-feedback',
        title: 'Adapt - Kindling Feedback',
        referenceSource: 'pg_channel_doc_title',
      }),
    ]);
    expect(pgDocumentCreateCalls).toHaveLength(0);
  });

  test.skip('legacy Yoke chat context hydration reuses intake acknowledgement without writing a duplicate reaction', async () => {
    const hydrate = createDispatchChatContextHydrator(buildChatPublisherContext());

    const result = await hydrate({
      runtime: {
        acknowledgement: {
          acknowledged: true,
          status: 'ok',
          operation: 'chat.acknowledge-message',
          emoji: 'shaka',
          targetMessageId: 'chat-message-1',
        },
      },
      availablePipelines: [],
    });

    expect(result).toMatchObject({
      hydrated: true,
      shouldProceed: true,
      acknowledgement: {
        acknowledged: true,
        status: 'ok',
        operation: 'chat.acknowledge-message',
        emoji: 'shaka',
        targetMessageId: 'chat-message-1',
      },
    });
    expect(yokeCommandCalls.some((args) => args[0] === 'chat' && args[1] === 'react')).toBe(false);
    expect(yokeCommandCalls.some((args) => args[0] === 'scopes' && args[1] === 'list')).toBe(true);
  });

  test.skip('legacy Yoke chat context hydration does not acknowledge self-authored messages', async () => {
    const hydrate = createDispatchChatContextHydrator(buildChatPublisherContext({
      payload: {
        sender_npub: 'npub1bot',
      },
      updaterNpub: 'npub1bot',
    }));

    const result = await hydrate({ availablePipelines: [] });

    expect(result).toMatchObject({
      status: 'skipped',
      shouldProceed: false,
      selfAuthored: true,
      acknowledgement: {
        acknowledged: false,
        status: 'skipped',
        operation: 'chat.acknowledge-message',
        reason: 'self_authored_dispatch',
      },
    });
    expect(yokeCommandCalls.some((args) => args[0] === 'chat' && args[1] === 'react')).toBe(false);
  });

  test.skip('legacy Yoke chat context hydration keeps proceeding when acknowledgement fails', async () => {
    failReactionCount = 1;
    const hydrate = createDispatchChatContextHydrator(buildChatPublisherContext());

    const result = await hydrate({ availablePipelines: [] });

    expect(result).toMatchObject({
      hydrated: true,
      status: 'ok',
      shouldProceed: true,
      acknowledgement: {
        acknowledged: false,
        status: 'failed',
        operation: 'chat.acknowledge-message',
        reason: 'reaction sync failed',
      },
    });
    expect(yokeCommandCalls.some((args) => args[0] === 'scopes' && args[1] === 'list')).toBe(true);
  });

  test.skip('legacy Yoke chat thread reload uses the reload operation label', async () => {
    const reload = createDispatchChatThreadReloader({
      eventInput: {
        subscription: {
          subscriptionId: 'sub-1',
          workspaceOwnerNpub: 'npub1workspace',
          sourceAppNpub: 'npub1source',
          backendBaseUrl: 'https://tower.example.com',
          botNpub: 'npub1bot',
          wsKeyNpub: 'npub1wskey',
        },
        triggerKind: 'chat',
        capability: 'chat_intercept',
        recordId: 'chat-message-1',
        record: {},
        payload: {
          channel_id: 'channel-1',
          thread_id: 'thread-1',
          sender_npub: 'npub1requester',
        },
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        bindingType: 'thread',
        bindingId: 'thread-1',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      agent: {
        agentId: 'agent-1',
        workingDirectory: '/tmp/agent-work',
      },
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      runtime: {
        yokeStateDir: '/tmp/yoke-state',
        commandPrefix: 'node yoke',
        commands: {},
        error: null,
      },
    } as never);

    const result = await reload({});

    expect(result).toMatchObject({
      hydrated: true,
      status: 'ok',
      operation: 'chat.reload-thread',
    });
  });

  test.skip('legacy Yoke review task completer moves the linked task to done and comments with approval evidence', async () => {
    const complete = createDispatchReviewTaskCompleter({
      eventInput: {
        subscription: {
          subscriptionId: 'sub-1',
          workspaceOwnerNpub: 'npub1workspace',
          sourceAppNpub: 'npub1source',
          backendBaseUrl: 'https://tower.example.com',
          botNpub: 'npub1bot',
          wsKeyNpub: 'npub1wskey',
        },
        triggerKind: 'chat',
        capability: 'chat_intercept',
        recordId: 'chat-message-approval',
        record: {},
        payload: {},
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        bindingType: 'thread',
        bindingId: 'thread-1',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      agent: {
        agentId: 'agent-1',
        workingDirectory: '/tmp/agent-work',
      },
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      runtime: {
        yokeStateDir: '/tmp/yoke-state',
        commandPrefix: 'node yoke',
        commands: {},
        error: null,
      },
    } as never);

    const result = await complete({
      reviewApproval: {
        taskId: 'task-review-1',
        taskTitle: 'Review chat dispatch',
        evidence: 'Looks good.',
      },
    });

    expect(result).toMatchObject({
      completed: true,
      status: 'done',
      operation: 'tasks.complete-review-from-chat',
      taskId: 'task-review-1',
    });
    expect(yokeCommandCalls).toContainEqual(['tasks', 'update', 'task-review-1', '--state', 'done', '--json']);
    expect(yokeCommandCalls.some((args) => args[0] === 'tasks' && args[1] === 'comment' && args.some((arg) => arg.includes('Approval text: Looks good.')))).toBe(true);
  });

  test.skip('legacy Yoke discussion document ensurer reuses a referenced document', async () => {
    const ensureDocument = createDispatchDiscussionDocumentEnsurer(buildChatPublisherContext());

    const result = await ensureDocument({
      documentContext: {
        documentId: 'doc-existing-1',
        documentTitle: 'Discussion pipeline design',
      },
    });

    expect(result).toMatchObject({
      ensured: true,
      status: 'reused',
      operation: 'docs.ensure-discussion-document',
      documentId: 'doc-existing-1',
      documentMention: '@[Discussion pipeline design](mention:document:doc-existing-1)',
    });
    expect(yokeCommandCalls.some((args) => args[0] === 'docs' && args[1] === 'create')).toBe(false);
  });

  test.skip('legacy Yoke discussion document ensurer creates a scaffold document when none is referenced', async () => {
    const ensureDocument = createDispatchDiscussionDocumentEnsurer(buildChatPublisherContext());

    const result = await ensureDocument({
      workPlan: {
        taskSummary: 'Discuss discussion pipeline',
        originalPrompt: 'Can we discuss the discussion pipeline?',
        origin: {
          channelId: 'channel-1',
          threadId: 'thread-1',
          messageId: 'chat-message-1',
        },
        originThread: [
          {
            messageId: 'chat-message-1',
            senderNpub: 'npub1requester',
            body: 'Can we discuss the discussion pipeline?',
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ensured: true,
      status: 'created',
      operation: 'docs.ensure-discussion-document',
      documentId: 'doc-created-1',
      documentMention: '@[Discuss discussion pipeline](mention:document:doc-created-1)',
    });
    const createCall = yokeCommandCalls.find((args) => args[0] === 'docs' && args[1] === 'create');
    expect(createCall?.[createCall.indexOf('--title') + 1]).toBe('Discuss discussion pipeline');
    const body = createCall?.[createCall.indexOf('--body') + 1] ?? '';
    expect(body).toContain('# Discuss discussion pipeline');
    expect(body).toContain('Can we discuss the discussion pipeline?');
    expect(body).toContain('@[discussion thread](mention:message:thread-1)');
  });

  test('discussion document ensurer creates a PG document without Yoke runtime', async () => {
    const ensureDocument = createDispatchDiscussionDocumentEnsurer(buildChatPublisherContext({
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
      },
      subscription: {
        workspaceId: 'workspace-pg-1',
      },
    }));

    const result = await ensureDocument({
      workPlan: {
        taskSummary: 'Discuss PG document helpers',
        originalPrompt: 'Please draft the doc.',
        origin: {
          channelId: 'channel-1',
          threadId: 'thread-1',
          messageId: 'chat-message-1',
        },
      },
    });

    expect(result).toMatchObject({
      ensured: true,
      status: 'created',
      operation: 'docs.ensure-discussion-document',
      documentId: 'pg-doc-created-1',
      documentMention: '@[Discuss PG document helpers](mention:document:pg-doc-created-1)',
    });
    expect(pgDocumentCreateCalls).toHaveLength(1);
    expect(pgDocumentCreateCalls[0]).toMatchObject({
      workspaceId: 'workspace-pg-1',
      channelId: 'channel-1',
      title: 'Discuss PG document helpers',
    });
    expect(yokeCommandCalls.some((args) => args[0] === 'docs' && args[1] === 'create')).toBe(false);
  });

  test('discussion document ensurer reuses PG document by title before creating scaffold', async () => {
    const ensureDocument = createDispatchDiscussionDocumentEnsurer(buildChatPublisherContext({
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
      },
      subscription: {
        workspaceId: 'workspace-pg-1',
      },
    }));

    const result = await ensureDocument({
      documentContext: {
        documentLoaded: false,
        documentId: null,
        documentTitle: 'Adapt - Kindling Feedback',
        discussionGoal: 'Review the Flight Deck document titled "Adapt - Kindling Feedback" in the current scope.',
      },
      workPlan: {
        origin: {
          channelId: 'channel-1',
          threadId: 'thread-1',
          messageId: 'chat-message-1',
        },
      },
    });

    expect(result).toMatchObject({
      ensured: true,
      status: 'reused',
      operation: 'docs.ensure-discussion-document',
      documentId: 'pg-doc-adapt-feedback',
      documentTitle: 'Adapt - Kindling Feedback',
      documentMention: '@[Adapt - Kindling Feedback](mention:document:pg-doc-adapt-feedback)',
      lookup: {
        status: 'matched',
        method: 'channel_doc_title',
        channelId: 'channel-1',
      },
    });
    expect(pgDocumentListCalls).toHaveLength(1);
    expect(pgDocumentCreateCalls).toHaveLength(0);
    expect(yokeCommandCalls.some((args) => args[0] === 'docs' && args[1] === 'create')).toBe(false);
  });

  test.skip('legacy Yoke chat reply publishing preserves Markdown newlines and storage image references', async () => {
    const publish = createDispatchFlightDeckPublisher(buildChatPublisherContext());
    const escapedMarkdown = 'Paragraph one.\\n\\n- Bullet with `code`\\n- Image ![thread-image.png](storage://7f7a304d-690f-43b4-a12c-ea04cba59354)';

    const result = await publish({
      agentResponse: {
        shouldRespond: true,
        responseDraft: escapedMarkdown,
      },
    });

    expect(result).toMatchObject({
      published: true,
      status: 'ok',
      operation: 'chat.reply-current',
    });
    const chatCall = yokeCommandCalls.find((args) => args[0] === 'chat' && args[1] === 'reply-current');
    const body = chatCall?.[chatCall.indexOf('--body') + 1] ?? '';
    expect(body).toBe('Paragraph one.\n\n- Bullet with `code`\n- Image ![thread-image.png](storage://7f7a304d-690f-43b4-a12c-ea04cba59354)');
    expect(body).not.toContain('\\n');
    expect(body).toContain('storage://7f7a304d-690f-43b4-a12c-ea04cba59354');
  });

  test('chat reply publishing sends Flight Deck PG messages without Yoke', async () => {
    const publish = createDispatchFlightDeckPublisher(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    const result = await publish({
      agentResponse: {
        shouldRespond: true,
        responseDraft: 'PG reply body',
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgMessageCreateCalls).toHaveLength(1);
    expect(pgMessageCreateCalls[0]).toMatchObject({
      workspaceId: 'workspace-pg-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      body: 'PG reply body',
    });
    expect(result).toMatchObject({
      published: true,
      status: 'ok',
      operation: 'chat.reply-current',
    });
  });

  test('chat reply publishing enforces the default inclusive window before the Tower write', async () => {
    const candidateAt = '2026-08-01T00:03:00.000Z';
    for (const seconds of [179, 180, 181]) {
      pgMessageCreateCalls.length = 0;
      pgResponseActivityUpsertCalls.length = 0;
      const decisionStore = new DuplicateCallbackPublicationDecisionStore(
        join(tmpdir(), `dispatch-duplicate-${randomUUID()}.sqlite`),
      );
      const publicationFilter = new DuplicateCallbackPublicationFilter(() => ({ marker: 'duplicate callback:', windowSeconds: 180 }),
        decisionStore, { warn: () => {} });
      const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1', channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1bot' });
      const priorAt = new Date(Date.parse(candidateAt) - seconds * 1_000).toISOString();
      decisionStore.recordPublished({ decisionId: `prior-pipeline-response-${seconds}`, routingKey,
        candidateAt: priorAt, publishedAt: priorAt, publishedMessageId: `prior-message-${seconds}` });
      const publish = createDispatchFlightDeckPublisher(buildChatPublisherContext({
        publicationFilter,
        subscription: { workspaceId: 'workspace-pg-1' },
        runtime: { mode: 'flightdeck_pg', yokeStateDir: null, commandPrefix: null, commands: {}, error: null },
      }));

      const result = await publish({ agentResponse: { shouldRespond: true,
        responseDraft: 'DUPLICATE CALLBACK: already handled.', createdAt: candidateAt } });

      expect(pgMessageCreateCalls).toHaveLength(seconds <= 180 ? 0 : 1);
      expect(result).toMatchObject(seconds <= 180
        ? { published: false, status: 'skipped', operation: 'chat.reply-current', reason: 'duplicate_callback_within_window' }
        : { published: true, status: 'ok', operation: 'chat.reply-current' });
      if (seconds <= 180) {
        expect(pgResponseActivityUpsertCalls.at(-1)).toMatchObject({
          status: 'cleared', label: 'Duplicate response suppressed',
        });
      }
    }
  });

  test('chat reply publishing keeps response activity alive for started child pipelines', async () => {
    const publish = createDispatchFlightDeckPublisher(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    await publish({
      agentResponse: {
        shouldRespond: true,
        responseDraft: 'I created a task and started the software loop.',
        childPipeline: {
          started: true,
          status: 'started',
          pipelineRunId: 'child-run-1',
          pipelineDefinitionId: 'software-implementation-review-loop',
        },
      },
    });

    expect(pgResponseActivityUpsertCalls.at(-1)).toMatchObject({
      status: 'thinking',
      label: 'Started software work',
      pipelineRunId: 'child-run-1',
      expiresInSeconds: 900,
      metadata: {
        pipeline_definition_id: 'software-implementation-review-loop',
        step: 'child-pipeline-started',
      },
    });
  });

  test('chat reply publishing attaches generated TTS audio to Flight Deck PG message when configured', async () => {
    const publish = createDispatchFlightDeckPublisher(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
      userSettings: {
        speech_chat_replies_enabled: 'true',
        speech_chat_replies_mode: 'summary',
        speech_provider: 'openrouter',
        speech_api_key: 'test-openrouter-key',
      },
    }));

    const result = await publish({
      agentResponse: {
        shouldRespond: true,
        responseDraft: 'PG reply body',
      },
    });

    expect(pgMessageCreateCalls).toHaveLength(1);
    expect(result).toMatchObject({
      published: true,
      speech: {
        status: 'queued',
        targetType: 'message',
        targetId: 'pg-reply-1',
      },
    });

    await flushBackgroundSpeech();

    expect(pgStorageUploadCalls).toHaveLength(1);
    expect(pgAudioNoteCreateCalls).toHaveLength(1);
    expect(pgAudioNoteCreateCalls[0]).toMatchObject({
      channelId: 'channel-1',
      threadId: 'thread-1',
      storageObjectId: 'storage-tts-1',
      targetType: 'message',
      targetId: 'pg-reply-1',
      transcriptText: 'Short spoken summary.',
      transcriptStatus: 'done',
    });
  });

  test('chat reply full TTS strips Flight Deck reference UUIDs from the audio note transcript', async () => {
    const rawBody = 'I reopened task @[Update Tower reaction schema for green check emoji](mention:task:e9479065-223b-488d-84c3-6b8824c64226) and started software-implementation-review-loop (9818e755-f921-400a-adf9-c934af46f02e).';
    const publish = createDispatchFlightDeckPublisher(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
      userSettings: {
        speech_chat_replies_enabled: 'true',
        speech_chat_replies_mode: 'full',
        speech_provider: 'openrouter',
        speech_api_key: 'test-openrouter-key',
      },
    }));

    await publish({
      agentResponse: {
        shouldRespond: true,
        responseDraft: rawBody,
      },
    });
    await flushBackgroundSpeech();

    expect(pgMessageCreateCalls[0]?.body).toBe(rawBody);
    expect(pgAudioNoteCreateCalls[0]?.transcriptText).toBe(
      'I reopened task Update Tower reaction schema for green check emoji and started software-implementation-review-loop.',
    );
  });

  test('task response publishing uses Flight Deck PG task state and comments without Yoke', async () => {
    const publish = createDispatchFlightDeckPublisher(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      triggerKind: 'task',
      capability: 'task_dispatch',
      recordId: 'pg-task-1',
      recordFamily: 'task',
      bindingType: 'task',
      bindingId: 'pg-task-1',
      payload: {
        task_id: 'pg-task-1',
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    const result = await publish({
      agentResponse: {
        accepted: true,
        taskSummary: 'Started task work.',
        confidence: 0.72,
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgTaskFetchCalls).toHaveLength(1);
    expect(pgLeaseAcquireCalls).toHaveLength(1);
    expect(pgTaskStateUpdateCalls).toHaveLength(1);
    expect(pgTaskStateUpdateCalls[0]).toMatchObject({
      workspaceId: 'workspace-pg-1',
      taskId: 'pg-task-1',
      state: 'in_progress',
      rowVersion: 2,
      leaseToken: 'lease-token-1',
    });
    expect(pgTaskCommentCreateCalls).toHaveLength(1);
    expect(pgTaskCommentCreateCalls[0]).toMatchObject({
      workspaceId: 'workspace-pg-1',
      taskId: 'pg-task-1',
    });
    expect(String(pgTaskCommentCreateCalls[0]?.body ?? '')).toContain('Started task work.');
    expect(result).toMatchObject({
      published: true,
      status: 'ok',
      operation: 'tasks.update',
      taskId: 'pg-task-1',
      state: 'in_progress',
    });
  });

  test('task response publishing attaches generated TTS audio to Flight Deck PG task comment when configured', async () => {
    const publish = createDispatchFlightDeckPublisher(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      triggerKind: 'task',
      capability: 'task_dispatch',
      recordId: 'pg-task-1',
      recordFamily: 'task',
      bindingType: 'task',
      bindingId: 'pg-task-1',
      payload: {
        task_id: 'pg-task-1',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
      userSettings: {
        speech_chat_replies_enabled: 'true',
        speech_chat_replies_mode: 'summary',
        speech_provider: 'openrouter',
        speech_api_key: 'test-openrouter-key',
      },
    }));

    const result = await publish({
      agentResponse: {
        accepted: true,
        taskSummary: 'Started task work.',
        confidence: 0.72,
      },
    });

    expect(pgTaskCommentCreateCalls).toHaveLength(1);
    expect(pgStorageUploadCalls).toHaveLength(1);
    expect(pgAudioNoteCreateCalls).toHaveLength(1);
    expect(pgAudioNoteCreateCalls[0]).toMatchObject({
      channelId: 'channel-1',
      threadId: 'thread-1',
      storageObjectId: 'storage-tts-1',
      targetType: 'task_comment',
      targetId: 'pg-comment-1',
      transcriptText: 'Short spoken summary.',
      transcriptStatus: 'done',
    });
    expect(result).toMatchObject({
      published: true,
      commentResult: {
        speech: {
          status: 'ok',
          storageObjectId: 'storage-tts-1',
          audioNoteId: 'audio-note-tts-1',
        },
      },
    });
  });

  test('task comment response publishing uses Flight Deck PG task comments without Yoke', async () => {
    const publish = createDispatchFlightDeckPublisher(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      recordId: 'pg-comment-1',
      recordFamily: 'comment',
      bindingType: 'task',
      bindingId: 'pg-task-1',
      payload: {
        comment_id: 'pg-comment-1',
        target_record_id: 'pg-task-1',
        target_record_family_hash: 'npub1source:task',
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    const result = await publish({
      agentResponse: {
        replyDraft: 'Reply one.\\n\\nReply two.',
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgTaskCommentCreateCalls).toHaveLength(1);
    expect(pgTaskCommentCreateCalls[0]).toMatchObject({
      workspaceId: 'workspace-pg-1',
      taskId: 'pg-task-1',
      body: 'Reply one.\n\nReply two.',
    });
    expect(pgTaskCommentCreateCalls[0]?.metadata).toMatchObject({
      autopilot_dispatch: true,
      operation: 'tasks.reply',
      parent_comment_id: 'pg-comment-1',
    });
    expect(result).toMatchObject({
      published: true,
      status: 'ok',
      operation: 'tasks.reply',
      commentId: 'pg-comment-1',
      taskId: 'pg-task-1',
    });
  });

  test.skip('legacy Yoke chat task creation failure returns a structured failure instead of throwing', async () => {
    failTaskCreateCount = 1;
    const createTask = createDispatchChatTaskCreator({
      eventInput: {
        subscription: {
          subscriptionId: 'sub-1',
          workspaceOwnerNpub: 'npub1workspace',
          sourceAppNpub: 'npub1source',
          backendBaseUrl: 'https://tower.example.com',
          botNpub: 'npub1bot',
          wsKeyNpub: 'npub1wskey',
        },
        triggerKind: 'chat',
        capability: 'chat_intercept',
        recordId: 'chat-message-2',
        record: {},
        payload: {},
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        bindingType: 'thread',
        bindingId: 'thread-1',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      agent: {
        agentId: 'agent-1',
        workingDirectory: '/tmp/agent-work',
      },
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      runtime: {
        yokeStateDir: '/tmp/yoke-state',
        commandPrefix: 'node yoke',
        commands: {},
        error: null,
      },
    } as never);

    const result = await createTask({
      dispatchTask: true,
      pipelineDefinitionId: 'software-implementation-review-loop',
      taskDraft: {
        title: 'Fix chat dispatch',
        instructions: 'Make dispatch resilient.',
      },
      workPlan: {
        taskSummary: 'Fix chat dispatch',
        instructions: 'Make dispatch resilient.',
        pipelineDefinitionId: 'software-implementation-review-loop',
      },
    });

    expect(result).toMatchObject({
      created: false,
      status: 'failed',
      operation: 'tasks.create-from-chat',
      reason: 'fetch failed',
      pipelineDefinitionId: null,
    });
    expect((result.workPlan as any).pipelineDefinitionId).toBeNull();
  });

  test('chat task creation uses Flight Deck PG task APIs without Yoke', async () => {
    const createTask = createDispatchChatTaskCreator(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    const result = await createTask({
      dispatchTask: true,
      pipelineDefinitionId: 'do-and-review',
      taskDraft: {
        title: 'Write a poem about a sausage',
        instructions: 'Write the poem.',
      },
      workPlan: {
        taskSummary: 'Write a poem about a sausage',
        instructions: 'Write the poem.',
        pipelineDefinitionId: 'do-and-review',
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgTaskCreateCalls).toHaveLength(1);
    expect(pgTaskCreateCalls[0]).toMatchObject({
      workspaceId: 'workspace-pg-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      title: 'Write a poem about a sausage',
      state: 'in_progress',
    });
    expect(pgWorkspaceMemberFetchCalls).toHaveLength(1);
    expect(pgTaskAssignmentCalls).toHaveLength(1);
    expect(pgTaskAssignmentCalls[0]).toMatchObject({
      taskId: 'pg-task-1',
      actorId: 'actor-bot',
    });
    expect(result).toMatchObject({
      created: true,
      status: 'ok',
      operation: 'tasks.create-from-chat',
      taskId: 'pg-task-1',
      assignedToNpub: 'npub1bot',
      assignment: {
        status: 'ok',
        actorId: 'actor-bot',
      },
      workPlan: {
        taskId: 'pg-task-1',
        pipelineDefinitionId: 'do-and-review',
      },
    });
  });

  test('chat task creation creates one Flight Deck PG task per pipeline requirement', async () => {
    const createTask = createDispatchChatTaskCreator(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    const result = await createTask({
      dispatchTask: true,
      pipelinesRequired: true,
      pipelineLaunches: [
        {
          requirementId: 'flight-deck-ui',
          pipelineDefinitionId: 'software-implementation-review-loop',
          workPlan: {
            taskSummary: 'Implement Flight Deck PWA notifications UI',
            workdir: '/Users/example/code/wingmanbefree/wm-fd-2',
            instructions: 'Build the UI half.',
            scopeId: 'scope-flight-deck',
            pipelineDefinitionId: 'software-implementation-review-loop',
          },
        },
        {
          requirementId: 'tower-api',
          pipelineDefinitionId: 'software-implementation-review-loop',
          workPlan: {
            taskSummary: 'Implement Tower push notification backend',
            workdir: '/Users/example/code/wingmanbefree/wingman-tower',
            instructions: 'Build the backend half.',
            scopeId: 'scope-tower',
            pipelineDefinitionId: 'software-implementation-review-loop',
          },
        },
      ],
      taskDraft: {
        title: 'Implement PWA notifications',
        instructions: 'Coordinate both halves.',
      },
      workPlan: {
        taskSummary: 'Implement PWA notifications',
        instructions: 'Coordinate both halves.',
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgTaskCreateCalls).toHaveLength(2);
    expect(pgTaskCreateCalls.map((call) => call.title)).toEqual([
      'Implement Flight Deck PWA notifications UI',
      'Implement Tower push notification backend',
    ]);
    expect(pgTaskCreateCalls.map((call) => (call.metadata as any).scope_id)).toEqual([
      'scope-flight-deck',
      'scope-tower',
    ]);
    expect(pgTaskAssignmentCalls).toHaveLength(2);
    expect(result).toMatchObject({
      created: true,
      status: 'ok',
      operation: 'tasks.create-from-chat.multi',
      items: [
        {
          requirementId: 'flight-deck-ui',
          taskId: 'pg-task-1',
          workPlan: {
            taskId: 'pg-task-1',
            scopeId: 'scope-flight-deck',
            workdir: '/Users/example/code/wingmanbefree/wm-fd-2',
          },
        },
        {
          requirementId: 'tower-api',
          taskId: 'pg-task-2',
          workPlan: {
            taskId: 'pg-task-2',
            scopeId: 'scope-tower',
            workdir: '/Users/example/code/wingmanbefree/wingman-tower',
          },
        },
      ],
    });
  });

  test('chat task creation reuses prior thread task mention for Flight Deck PG follow-up', async () => {
    const createTask = createDispatchChatTaskCreator(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    const result = await createTask({
      dispatchTask: true,
      pipelineDefinitionId: 'software-implementation-review-loop',
      taskDraft: {
        title: 'Fix follow-up bug',
        instructions: 'Handle the feedback.',
      },
      workPlan: {
        taskSummary: 'Fix follow-up bug',
        instructions: 'Handle the feedback.',
        pipelineDefinitionId: 'software-implementation-review-loop',
      },
      chatContext: {
        thread: [
          { body: 'I created task @[Existing bug](mention:task:task-existing-1) and started software-implementation-review-loop.' },
          { body: 'This still is not complete.' },
        ],
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgTaskCreateCalls).toHaveLength(0);
    expect(pgTaskStateUpdateCalls).toHaveLength(1);
    expect(pgTaskStateUpdateCalls[0]).toMatchObject({
      taskId: 'task-existing-1',
      state: 'in_progress',
    });
    expect(pgTaskAssignmentCalls).toHaveLength(1);
    expect(pgTaskAssignmentCalls[0]).toMatchObject({
      taskId: 'task-existing-1',
      actorId: 'actor-bot',
    });
    expect(result).toMatchObject({
      created: false,
      reused: true,
      status: 'ok',
      operation: 'tasks.reuse-from-chat',
      taskId: 'task-existing-1',
      assignedToNpub: 'npub1bot',
      workPlan: {
        taskId: 'task-existing-1',
        pipelineDefinitionId: 'software-implementation-review-loop',
      },
    });
  });

  test.skip('legacy Yoke review handoff comments with the report document and notifies the source chat', async () => {
    const updateTask = createDispatchTaskStateUpdater({
      eventInput: {
        subscription: {
          subscriptionId: 'sub-1',
          workspaceOwnerNpub: 'npub1workspace',
          sourceAppNpub: 'npub1source',
          backendBaseUrl: 'https://tower.example.com',
          botNpub: 'npub1bot',
          wsKeyNpub: 'npub1wskey',
        },
        triggerKind: 'chat',
        capability: 'chat_intercept',
        recordId: 'chat-message-1',
        record: {},
        payload: {},
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        bindingType: 'thread',
        bindingId: 'thread-1',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      agent: {
        agentId: 'agent-1',
        workingDirectory: '/tmp/agent-work',
      },
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      runtime: {
        yokeStateDir: '/tmp/yoke-state',
        commandPrefix: 'node yoke',
        commands: {},
        error: null,
      },
    } as never, 'review');

    const result = await updateTask({
      workPlan: {
        taskId: 'task-1',
        reviewerNpub: 'npub1requester',
      },
      workerResult: {
        reportTitle: 'Report: The Running Centre, Perth',
        reportSummary: 'The report is complete.',
        documentId: 'doc-1',
        taskUpdateComment: 'Report complete. Created Flight Deck doc "Report: The Running Centre, Perth" (doc-1).',
      },
      agentResponse: {
        accepted: true,
        reviewSummary: 'Accepted.',
        requiredChanges: [],
        risks: [],
        confidence: 0.86,
      },
    });

    expect(result).toMatchObject({
      published: true,
      status: 'ok',
      operation: 'tasks.move-to-review',
      taskId: 'task-1',
      chatNotified: true,
      chatError: null,
    });

    const updateCall = yokeCommandCalls.find((args) => args[0] === 'tasks' && args[1] === 'update');
    expect(updateCall).toEqual(['tasks', 'update', 'task-1', '--state', 'review', '--assign', 'npub1requester', '--json']);

    const commentCall = yokeCommandCalls.find((args) => args[0] === 'tasks' && args[1] === 'comment');
    expect(commentCall?.[commentCall.indexOf('--body') + 1]).toContain(
      '@[Report: The Running Centre, Perth](mention:document:doc-1)',
    );

    const chatCall = yokeCommandCalls.find((args) => args[0] === 'chat' && args[1] === 'reply-current');
    const body = chatCall?.[chatCall.indexOf('--body') + 1] ?? '';
    expect(body).not.toContain('Task: @[review task](mention:task:task-1)');
    expect(body).not.toContain('Summary:');
    expect(body).toContain(
      '@[Report: The Running Centre, Perth](mention:document:doc-1)',
    );
    expect(chatCall).toContain('--skip-refresh');
    expect(chatCall).toContain('channel-1');
    expect(chatCall).toContain('thread-1');
  });

  test('review handoff uses Flight Deck PG task state, comments, and chat reply without Yoke', async () => {
    const updateTask = createDispatchTaskStateUpdater(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }), 'review');

    const result = await updateTask({
      workPlan: {
        taskId: 'pg-task-1',
        reviewerNpub: 'npub1requester',
      },
      workerResult: {
        reportTitle: 'Sausage Poem',
        reportSummary: 'The poem is complete.',
      },
      agentResponse: {
        accepted: true,
        reviewSummary: 'Accepted.',
        requiredChanges: [],
        risks: [],
        confidence: 0.86,
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgTaskFetchCalls).toHaveLength(1);
    expect(pgLeaseAcquireCalls).toHaveLength(1);
    expect(pgTaskStateUpdateCalls).toHaveLength(1);
    expect(pgTaskStateUpdateCalls[0]).toMatchObject({
      taskId: 'pg-task-1',
      state: 'review',
      rowVersion: 2,
      leaseToken: 'lease-token-1',
    });
    expect(pgWorkspaceMemberFetchCalls).toHaveLength(1);
    expect(pgTaskAssignmentCalls).toHaveLength(1);
    expect(pgTaskAssignmentCalls[0]).toMatchObject({
      taskId: 'pg-task-1',
      actorId: 'actor-requester',
    });
    expect(pgTaskCommentCreateCalls).toHaveLength(1);
    expect(pgMessageCreateCalls).toHaveLength(1);
    expect(pgMessageCreateCalls[0]).toMatchObject({
      workspaceId: 'workspace-pg-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });
    expect(result).toMatchObject({
      published: true,
      status: 'ok',
      operation: 'tasks.move-to-review',
      taskId: 'pg-task-1',
      assignedToNpub: 'npub1requester',
      assignment: {
        status: 'ok',
        actorId: 'actor-requester',
      },
      chatNotified: true,
      chatError: null,
    });
  });

  test.skip('legacy Yoke ready-for-review chat includes worker result when no document is produced', async () => {
    const updateTask = createDispatchTaskStateUpdater({
      eventInput: {
        subscription: {
          subscriptionId: 'sub-1',
          workspaceOwnerNpub: 'npub1workspace',
          sourceAppNpub: 'npub1source',
          backendBaseUrl: 'https://tower.example.com',
          botNpub: 'npub1bot',
          wsKeyNpub: 'npub1wskey',
        },
        triggerKind: 'chat',
        capability: 'chat_intercept',
        recordId: 'chat-message-1',
        record: {},
        payload: {},
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        receivedAt: '2026-01-01T00:00:00.000Z',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      agent: {
        agentId: 'agent-1',
        workingDirectory: '/tmp/agent-work',
      },
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      runtime: {
        yokeStateDir: '/tmp/yoke-state',
        commandPrefix: 'node yoke',
        commands: {},
        error: null,
      },
    } as never, 'review');

    await updateTask({
      workPlan: {
        taskId: 'task-1',
        reviewerNpub: 'npub1requester',
      },
      workerResult: {
        summary: 'Drafted the pitch.',
        result: 'Core pitch: Other Stuff helps commercial electricians protect margin by tightening quote follow-up, variation capture, job handover, and admin coordination.',
        taskUpdateComment: 'Completed draft pitch for Example Operator.',
      },
      agentResponse: {
        accepted: true,
        reviewSummary: 'Accepted. The worker produced a clear pitch.',
        requiredChanges: [],
        risks: [],
        confidence: 0.86,
      },
    });

    const chatCall = yokeCommandCalls.find((args) => args[0] === 'chat' && args[1] === 'reply-current');
    const body = chatCall?.[chatCall.indexOf('--body') + 1] ?? '';
    expect(body).toContain('Drafted the pitch.');
    expect(body).toContain('Result:');
    expect(body).toContain('Core pitch: Other Stuff helps commercial electricians protect margin');
    expect(body).not.toContain('Summary:');
    expect(body).not.toContain('Accepted. The worker produced a clear pitch.');
    expect(body).not.toContain('Task:');
  });

  test.skip('legacy Yoke ready-for-review chat prefers final conversational thread response', async () => {
    const updateTask = createDispatchTaskStateUpdater({
      eventInput: {
        subscription: {
          subscriptionId: 'sub-1',
          workspaceOwnerNpub: 'npub1workspace',
          sourceAppNpub: 'npub1source',
          backendBaseUrl: 'https://tower.example.com',
          botNpub: 'npub1bot',
          wsKeyNpub: 'npub1wskey',
        },
        triggerKind: 'chat',
        capability: 'chat_intercept',
        recordId: 'chat-message-1',
        record: {},
        payload: {},
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        receivedAt: '2026-01-01T00:00:00.000Z',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      agent: {
        agentId: 'agent-1',
        workingDirectory: '/tmp/agent-work',
      },
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      runtime: {
        yokeStateDir: '/tmp/yoke-state',
        commandPrefix: 'node yoke',
        commands: {},
        error: null,
      },
    } as never, 'review');

    await updateTask({
      workPlan: {
        taskId: 'task-1',
        reviewerNpub: 'npub1requester',
      },
      workerResult: {
        summary: 'Drafted the pitch.',
        result: 'Worker result should not be the chat body when the final agent wrote one.',
      },
      agentResponse: {
        reviewSummary: 'Accepted.',
      },
      finalThreadResponse: {
        body: 'Summary: For an SME commercial electrical company, I would lead with margin protection and fewer missed details.\nTask: @[review task](mention:task:task-1)\nAssigned back to: npub1requester',
        summary: 'Conversational final answer.',
      },
    });

    const chatCall = yokeCommandCalls.find((args) => args[0] === 'chat' && args[1] === 'reply-current');
    const body = chatCall?.[chatCall.indexOf('--body') + 1] ?? '';
    expect(body).toBe('For an SME commercial electrical company, I would lead with margin protection and fewer missed details.');
  });

  test.skip('legacy Yoke chat-created task descriptions include the compact origin thread details', async () => {
    const createTask = createDispatchChatTaskCreator({
      eventInput: {
        subscription: {
          subscriptionId: 'sub-1',
          workspaceOwnerNpub: 'npub1workspace',
          sourceAppNpub: 'npub1source',
          backendBaseUrl: 'https://tower.example.com',
          botNpub: 'npub1bot',
          wsKeyNpub: 'npub1wskey',
        },
        triggerKind: 'chat',
        capability: 'chat_intercept',
        recordId: 'chat-message-2',
        record: {},
        payload: {},
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        bindingType: 'thread',
        bindingId: 'thread-1',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      agent: {
        agentId: 'agent-1',
        workingDirectory: '/tmp/agent-work',
      },
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      runtime: {
        yokeStateDir: '/tmp/yoke-state',
        commandPrefix: 'node yoke',
        commands: {},
        error: null,
      },
    } as never);

    const result = await createTask({
      dispatchTask: true,
      pipelineDefinitionId: 'do-and-review',
      taskDraft: {
        title: 'Create requested image asset',
        instructions: 'Create an image of a red kite over Perth city at sunset.',
      },
      workPlan: {
        taskSummary: 'Create requested image asset',
        instructions: 'Create an image of a red kite over Perth city at sunset.',
        originThread: [
          {
            messageId: 'msg-1',
            senderNpub: 'npub1requester',
            body: 'Can you make an image of a red kite over Perth city at sunset?',
          },
          {
            messageId: 'msg-2',
            senderNpub: 'npub1requester',
            body: 'Use do-and-review for it.',
          },
        ],
      },
    });

    expect(result).toMatchObject({
      created: true,
      taskId: 'task-created-1',
    });
    const createCall = yokeCommandCalls.find((args) => args[0] === 'tasks' && args[1] === 'create');
    const description = createCall?.[createCall.indexOf('--description') + 1] ?? '';
    expect(description).toContain('Originating chat context:');
    expect(description).toContain('red kite over Perth city at sunset');
    expect(description).toContain('Use do-and-review for it.');
  });

  test.skip('legacy Yoke needs-input publisher comments on the task and asks in the source chat', async () => {
    const publishNeedsInput = createDispatchNeedsInputPublisher({
      eventInput: {
        subscription: {
          subscriptionId: 'sub-1',
          workspaceOwnerNpub: 'npub1workspace',
          sourceAppNpub: 'npub1source',
          backendBaseUrl: 'https://tower.example.com',
          botNpub: 'npub1bot',
          wsKeyNpub: 'npub1wskey',
        },
        triggerKind: 'chat',
        capability: 'chat_intercept',
        recordId: 'chat-message-1',
        record: {},
        payload: {},
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        bindingType: 'thread',
        bindingId: 'thread-1',
        channelId: 'channel-1',
        threadId: 'thread-1',
      },
      agent: {
        agentId: 'agent-1',
        workingDirectory: '/tmp/agent-work',
      },
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      runtime: {
        yokeStateDir: '/tmp/yoke-state',
        commandPrefix: 'node yoke',
        commands: {},
        error: null,
      },
    } as never);

    const result = await publishNeedsInput({
      createdTask: {
        taskId: 'task-1',
      },
      workPlan: {
        taskId: 'task-1',
      },
      workerResult: {
        completed: false,
        summary: 'Image requirements are missing.',
        result: 'needs_input: image requirements are missing.',
        blockers: ['Missing image prompt.'],
        taskUpdateComment: 'What should the image show, and are there any required style or size constraints?',
      },
    });

    expect(result).toMatchObject({
      published: true,
      operation: 'tasks.needs-input',
      taskId: 'task-1',
      chatNotified: true,
    });

    const commentCall = yokeCommandCalls.find((args) => args[0] === 'tasks' && args[1] === 'comment');
    expect(commentCall?.[commentCall.indexOf('--body') + 1]).toContain('Question: What should the image show');

    const chatCall = yokeCommandCalls.find((args) => args[0] === 'chat' && args[1] === 'reply-current');
    expect(chatCall?.[chatCall.indexOf('--body') + 1]).toContain('Task: @[needs-input task](mention:task:task-1)');
    expect(chatCall?.[chatCall.indexOf('--body') + 1]).toContain('Question: What should the image show');
  });

  test.skip('legacy Yoke implementation review loop creates a task, comments manager progress, and closes out to chat', async () => {
    const context = {
      eventInput: {
        subscription: {
          subscriptionId: 'sub-1',
          workspaceOwnerNpub: 'npub1workspace',
          sourceAppNpub: 'npub1source',
          backendBaseUrl: 'https://tower.example.com',
          botNpub: 'npub1bot',
          wsKeyNpub: 'npub1wskey',
        },
        triggerKind: 'chat',
        capability: 'chat_intercept',
        recordId: 'chat-message-1',
        record: {},
        payload: { channel_id: 'channel-1' },
        recordFamily: 'chat',
        recordState: null,
        recordVersion: 1,
        updaterNpub: 'npub1requester',
        bindingType: 'thread',
        bindingId: null,
        channelId: 'channel-1',
        threadId: null,
      },
      agent: {
        agentId: 'agent-1',
        workingDirectory: '/tmp/agent-work',
      },
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
      runtime: {
        yokeStateDir: '/tmp/yoke-state',
        commandPrefix: 'node yoke',
        commands: {},
        error: null,
      },
    } as never;
    const ensureTask = createDispatchImplementationReviewTaskEnsurer(context);
    const commentProgress = createDispatchImplementationReviewProgressCommenter(context);
    const closeTask = createDispatchTaskStateUpdater(context, 'review');

    const createdTask = await ensureTask({
      implementationPrompt: 'Implement the editor design.',
      workingDirectory: '/repo/app',
      workPlan: {
        taskSummary: 'Implement editor design',
        reviewerNpub: 'npub1requester',
        origin: {
          channelId: 'channel-1',
        },
      },
      maxReviewIterations: 3,
    });
    await commentProgress({
      createdTask,
      workPlan: (createdTask as any).workPlan,
      reviewLoop: { iteration: 1 },
      managerReview: {
        done: false,
        managerSummary: 'The first pass needs one follow-up.',
        pickups: [
          { title: 'Add regression test', action: 'Cover the closeout path.' },
        ],
      },
    });
    const closeout = await closeTask({
      createdTask,
      workPlan: (createdTask as any).workPlan,
      workerResult: {
        summary: 'Implementation loop finished after manager review.',
        taskUpdateComment: 'Final report: implementation reviewed and ready.',
      },
      agentResponse: {
        accepted: true,
        reviewSummary: 'Manager accepted the final implementation.',
        requiredChanges: [],
        risks: [],
      },
      reportTarget: {
        flightDeckChannelId: 'channel-1',
      },
    });

    expect(createdTask).toMatchObject({
      published: true,
      operation: 'tasks.ensure-implementation-review-loop',
      taskId: 'task-created-1',
      created: true,
      state: 'in_progress',
    });
    expect(closeout).toMatchObject({
      published: true,
      operation: 'tasks.move-to-review',
      taskId: 'task-created-1',
      chatNotified: true,
    });

    const createCall = yokeCommandCalls.find((args) => args[0] === 'tasks' && args[1] === 'create');
    expect(createCall).toContain('--state');
    expect(createCall).toContain('in_progress');

    const progressComment = yokeCommandCalls
      .filter((args) => args[0] === 'tasks' && args[1] === 'comment')
      .find((args) => args[args.indexOf('--body') + 1]?.includes('Manager review iteration 1'));
    expect(progressComment?.[progressComment.indexOf('--body') + 1]).toContain('Add regression test');

    const chatCall = yokeCommandCalls.find((args) => args[0] === 'chat' && args[1] === 'reply-current');
    const body = chatCall?.[chatCall.indexOf('--body') + 1] ?? '';
    expect(body).toContain('Implementation loop finished after manager review.');
    expect(body).toContain('Final report: implementation reviewed and ready.');
    expect(body).not.toContain('Task: @[review task](mention:task:task-created-1)');
    expect(body).not.toContain('Summary:');
    expect(chatCall).toContain('--thread');
    expect(chatCall?.[chatCall.indexOf('--thread') + 1]).toBeTruthy();
  });

  test('implementation review task ensurer assigns Flight Deck PG task to bot actor', async () => {
    const ensureTask = createDispatchImplementationReviewTaskEnsurer(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    const createdTask = await ensureTask({
      implementationPrompt: 'Implement the editor design.',
      workingDirectory: '/repo/app',
      workPlan: {
        taskSummary: 'Implement editor design',
        reviewerNpub: 'npub1requester',
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgTaskCreateCalls).toHaveLength(1);
    expect(pgTaskStateUpdateCalls).toHaveLength(1);
    expect(pgWorkspaceMemberFetchCalls).toHaveLength(1);
    expect(pgTaskAssignmentCalls).toHaveLength(1);
    expect(pgTaskAssignmentCalls[0]).toMatchObject({
      taskId: 'pg-task-1',
      actorId: 'actor-bot',
    });
    expect(createdTask).toMatchObject({
      published: true,
      status: 'ok',
      operation: 'tasks.ensure-implementation-review-loop',
      taskId: 'pg-task-1',
      assignedToNpub: 'npub1bot',
      assignment: {
        status: 'ok',
        actorId: 'actor-bot',
      },
    });
  });

  test('implementation review task ensurer keeps direct chat software runs taskless', async () => {
    const ensureTask = createDispatchImplementationReviewTaskEnsurer(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
      recordId: 'chat-message-99',
      threadId: 'thread-99',
      payload: {
        record_id: 'chat-message-99',
        thread_id: 'thread-99',
      },
    }));

    const createdTask = await ensureTask({
      implementationPrompt: 'Implement the focused fix from this chat thread.',
      workingDirectory: '/repo/app',
      record: {
        recordId: 'chat-message-99',
        payload: {
          record_id: 'chat-message-99',
          thread_id: 'thread-99',
        },
      },
      workPlan: {
        taskSummary: 'Implement focused fix',
        instructions: 'Implement the focused fix from this chat thread.',
        reporting: { mode: 'chat_thread' },
        origin: {
          triggerKind: 'chat',
          channelId: 'channel-1',
          threadId: 'thread-99',
          messageId: 'chat-message-99',
        },
        targetSurface: {
          route: '/docs',
          existingFiles: ['src/app.js'],
        },
        reviewerNpub: 'npub1requester',
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgTaskCreateCalls).toHaveLength(0);
    expect(pgTaskStateUpdateCalls).toHaveLength(0);
    expect(pgTaskCommentCreateCalls).toHaveLength(0);
    expect(pgTaskAssignmentCalls).toHaveLength(0);
    expect(pgDocumentFetchCalls).toHaveLength(0);
    expect(createdTask).toMatchObject({
      published: false,
      status: 'ready',
      operation: 'tasks.ensure-implementation-review-loop',
      taskId: null,
      created: false,
      workPlan: {
        taskId: null,
        designDocumentUrl: 'flightdeck-chat-thread://thread-99#chat-message-99',
        designDocumentSource: 'chat_thread_context',
        origin: {
          kind: 'chat_thread',
          threadId: 'thread-99',
          messageId: 'chat-message-99',
        },
        reporting: { mode: 'chat_thread' },
      },
    });
  });

  test('implementation review task ensurer hydrates Flight Deck PG design doc without Yoke', async () => {
    const workdir = join(tmpdir(), `autopilot-doc-snapshot-${randomUUID()}`);
    const ensureTask = createDispatchImplementationReviewTaskEnsurer(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    const createdTask = await ensureTask({
      implementationPrompt: 'Implement the Autopilot overview design.',
      workingDirectory: workdir,
      designDocumentUrl: '@[Design for Autopilot Overview](mention:doc:76ebf6ac-91ff-47e2-af36-b99d47a10d57)',
      workPlan: {
        taskSummary: 'Implement Autopilot overview design',
        reviewerNpub: 'npub1requester',
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgDocumentFetchCalls).toHaveLength(1);
    expect(pgDocumentFetchCalls[0]).toMatchObject({
      workspaceId: 'workspace-pg-1',
      documentId: '76ebf6ac-91ff-47e2-af36-b99d47a10d57',
      includeBody: true,
    });
    const localPath = String((createdTask as any).workPlan.designDocument.localPath);
    expect(localPath).toContain(join(workdir, 'tmp', 'flightdeck-docs'));
    expect(createdTask).toMatchObject({
      workPlan: {
        designDocumentUrl: '@[Design for Autopilot Overview](mention:doc:76ebf6ac-91ff-47e2-af36-b99d47a10d57)',
        reporting: { mode: 'flightdeck_task' },
        designDocument: {
          status: 'loaded',
          id: '76ebf6ac-91ff-47e2-af36-b99d47a10d57',
          title: 'Design for Autopilot Overview',
          localPath: expect.stringContaining('76ebf6ac-91ff-47e2-af36-b99d47a10d57'),
          bodyExcerpt: expect.stringContaining('Build the Autopilot overview screen.'),
        },
      },
    });
    const snapshot = await readFile(localPath, 'utf8');
    expect(snapshot).toContain('Build the Autopilot overview screen.');
    expect(String((createdTask as any).workPlan.designDocumentLocalPath)).toBe(localPath);
    expect(String((createdTask as any).workPlan.designDocumentAccessInstructions)).toContain('localPath');
  });

  test('implementation review task ensurer refuses archived agent workdir fallback', async () => {
    const context = buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }) as any;
    context.agent.workingDirectory = '/srv/autopilot/data/agent-chat-workspaces/fd-private';
    const ensureTask = createDispatchImplementationReviewTaskEnsurer(context);

    await expect(ensureTask({
      implementationPrompt: 'Implement the Tiptap docs editor.',
      designDocumentUrl: '@[Tiptap Design Spec](mention:doc:79b6684f-b5c6-4bb7-8deb-0d6b6c905d05)',
      workPlan: {
        taskSummary: 'Implement Tiptap docs editor',
        reviewerNpub: 'npub1requester',
      },
    })).rejects.toThrow(/private agent workspace/);
    expect(pgDocumentFetchCalls).toHaveLength(0);
  });

  test('implementation review task ensurer extracts design doc mention from instructions before snapshotting', async () => {
    const workdir = join(tmpdir(), `autopilot-doc-snapshot-${randomUUID()}`);
    const ensureTask = createDispatchImplementationReviewTaskEnsurer(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }));

    const createdTask = await ensureTask({
      implementationPrompt: 'Implement it.',
      workingDirectory: workdir,
      workPlan: {
        taskSummary: 'Implement Autopilot overview design',
        instructions: 'Implement the Flight Deck Autopilot Overview design from @[Design for Autopilot Overview](mention:document:76ebf6ac-91ff-47e2-af36-b99d47a10d57) in main.',
        reviewerNpub: 'npub1requester',
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgDocumentFetchCalls).toHaveLength(1);
    expect(pgDocumentFetchCalls[0]).toMatchObject({
      documentId: '76ebf6ac-91ff-47e2-af36-b99d47a10d57',
      includeBody: true,
    });
    expect(createdTask).toMatchObject({
      workPlan: {
        designDocumentUrl: '@[Design for Autopilot Overview](mention:document:76ebf6ac-91ff-47e2-af36-b99d47a10d57)',
        designDocument: {
          status: 'loaded',
          localPath: expect.stringContaining(join(workdir, 'tmp', 'flightdeck-docs')),
        },
      },
    });
  });

  test('implementation review closeout leaves task in progress when manager review is not done', async () => {
    const closeTask = createDispatchTaskStateUpdater(buildChatPublisherContext({
      subscription: {
        subscriptionId: 'sub-pg-1',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        botNpub: 'npub1bot',
        wsKeyNpub: null,
      },
      runtime: {
        mode: 'flightdeck_pg',
        yokeStateDir: null,
        commandPrefix: null,
        commands: {},
        error: null,
      },
    }), 'review');

    const closeout = await closeTask({
      workPlan: {
        taskId: 'pg-task-1',
        reviewerNpub: 'npub1requester',
      },
      workerResult: {
        status: 'max_iterations_reached',
        summary: 'Implementation pass ran but did not clear review.',
        remainingPickups: ['Apply Scope + Channel filters to files and document stats.'],
      },
      agentResponse: {
        done: false,
        managerSummary: 'Scope + Channel filters are still incomplete.',
        pickups: [
          {
            title: 'Complete filters',
            action: 'Apply filters to files, document stats, and unresolved comments.',
          },
        ],
      },
    });

    expect(yokeCommandCalls).toHaveLength(0);
    expect(pgTaskStateUpdateCalls).toHaveLength(0);
    expect(pgTaskAssignmentCalls).toHaveLength(0);
    expect(pgTaskCommentCreateCalls).toHaveLength(1);
    expect(String(pgTaskCommentCreateCalls[0]?.body ?? '')).toContain('task remains in progress');
    expect(pgMessageCreateCalls).toHaveLength(1);
    expect(String(pgMessageCreateCalls[0]?.body ?? '')).toContain('did not clear manager review');
    expect(closeout).toMatchObject({
      published: true,
      status: 'ok',
      operation: 'tasks.implementation-review-incomplete',
      taskId: 'pg-task-1',
      state: 'in_progress',
      updateSkipped: true,
      skippedReviewReason: 'manager_review_not_done',
      chatNotified: true,
    });
  });

  test.skip('legacy Yoke stored dispatch child runs resume with Flight Deck publishing functions', async () => {
    const pipelineStore = new PipelineStore(join(tmpdir(), `pipeline-resume-${randomUUID()}.sqlite`));
    const runtime = new DispatchPipelineRuntime({
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      getBotIdentityForSubscription: () => ({
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      }),
      callbackOrigin: 'http://localhost',
      loadFunctions: async () => ({ records: [], registry: {} }),
    });

    const registry = await runtime.loadRegistryForStoredRun({
      sessionApiContext: {} as never,
      definition: {
        id: 'research-and-report',
        slug: 'research-and-report',
        name: 'research-and-report',
        scope: 'shared',
        ownerAlias: null,
        path: '/tmp/research-and-report.json',
        spec: {
          name: 'research-and-report',
          input: {},
          steps: [
            {
              name: 'ensure-review-loop-task',
              type: 'code',
              function: 'dispatch.ensureImplementationReviewTask',
            },
            {
              name: 'move-task-to-review',
              type: 'code',
              function: 'dispatch.markTaskReadyForReview',
            },
          ],
        },
      },
      run: {
        id: 'run-1',
        definitionId: 'research-and-report',
        definitionPath: '/tmp/research-and-report.json',
        name: 'research-and-report',
        status: 'running',
        ownerNpub: 'npub1manager',
        ownerAlias: 'manager',
        scope: 'shared',
        input: {
          dispatch: {
            routeId: 'route-1',
            triggerKind: 'chat',
          },
          workspace: {
            subscriptionId: 'sub-1',
            workspaceOwnerNpub: 'npub1workspace',
            sourceAppNpub: 'npub1source',
            backendBaseUrl: 'https://tower.example.com',
          },
          agent: {
            agentId: 'agent-1',
            botNpub: 'npub1bot',
            workingDirectory: '/tmp/agent-work',
          },
          record: {
            recordId: 'message-1',
            recordFamily: 'chat',
            payload: {},
          },
          routing: {
            bindingType: 'thread',
            bindingId: 'thread-1',
            channelId: 'channel-1',
            threadId: 'thread-1',
          },
          runtime: {
            yokeStateDir: '/tmp/yoke-state',
            commandPrefix: 'node yoke',
            commands: {},
          },
        },
        current: {},
        cursorIndex: 0,
        activeStepId: null,
        result: null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      },
    });

    expect(registry?.['dispatch.markTaskReadyForReview']).toBeFunction();
    expect(registry?.['dispatch.ensureImplementationReviewTask']).toBeFunction();
    expect(registry?.['dispatch.commentImplementationReviewProgress']).toBeFunction();
    expect(registry?.['dispatch.publishNeedsInput']).toBeFunction();
    const result = await registry!['dispatch.markTaskReadyForReview']!({
      workPlan: {
        taskId: 'task-1',
        reviewerNpub: 'npub1requester',
      },
      workerResult: {
        reportTitle: 'Report',
        documentId: 'doc-1',
      },
    });

    expect(result).toMatchObject({
      published: true,
      operation: 'tasks.move-to-review',
      chatNotified: true,
    });
  });
});

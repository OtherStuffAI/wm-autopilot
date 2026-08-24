import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import type { AgentAdapter } from '../agents/agent-adapter';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { resolveAuthoritativeSessionMessages } from '../agents/authoritative-session-messages';
import { awaitAcceptedFinalResponse, PromptBoundaryNotObservedError, sendPromptAndAwaitAssistantReply, sendPromptAndAwaitFinalResponse } from './session-runtime-session-ops';

class FakeAdapter implements AgentAdapter {
  private sent = false;
  private readonly assistantContent: string;

  constructor(content: string, private readonly replyRole = 'assistant') {
    this.assistantContent = content;
  }

  async fetchStatus() {
    return 'running' as const;
  }

  async sendMessage() {
    this.sent = true;
  }

  async fetchMessages() {
    if (!this.sent) {
      return [];
    }
    return [
      {
        role: this.replyRole,
        content: this.assistantContent,
        createdAt: new Date().toISOString(),
      },
    ];
  }

  async interruptCurrentTurn() {
    return false;
  }

  getEventsUrl() {
    return null;
  }

  async waitForReady() {}

  async dispose() {}
}

function buildManager(session: SessionSnapshot, adapter: AgentAdapter): ProcessManager {
  return {
    getSession: () => session,
    getAdapter: () => adapter,
  } as unknown as ProcessManager;
}

describe('sendPromptAndAwaitAssistantReply', () => {
  test('accepts the canonical agent role returned by the sessions API', async () => {
    const session: SessionSnapshot = {
      id: 'session-agent-role', agent: 'codex', port: 0, name: 'Agent Chat', status: 'running',
      agentRuntimeStatus: 'stable', startedAt: new Date().toISOString(), command: [], workingDirectory: '/tmp', logs: [],
    };
    const reply = await sendPromptAndAwaitAssistantReply(
      buildManager(session, new FakeAdapter('Done', 'agent')),
      session.id,
      'prompt',
      { timeoutMs: 250, pollIntervalMs: 10, stablePolls: 1 },
    );
    expect(reply.content).toBe('Done');
  });

  test('settles a stable parseable decision even when runtime status stays running', async () => {
    const session: SessionSnapshot = {
      id: 'session-1',
      agent: 'codex',
      port: 0,
      name: 'Agent Chat',
      status: 'running',
      agentRuntimeStatus: 'running',
      startedAt: new Date().toISOString(),
      command: [],
      workingDirectory: '/tmp',
      logs: [],
    };
    const manager = buildManager(session, new FakeAdapter('AGENT_CHAT_DECISION: ignore'));

    const reply = await sendPromptAndAwaitAssistantReply(manager, session.id, 'prompt', {
      timeoutMs: 250,
      pollIntervalMs: 10,
      stablePolls: 2,
      decisionFallbackStablePolls: 3,
    });

    expect(reply.content).toBe('AGENT_CHAT_DECISION: ignore');
    expect(reply.settledWithoutStableRuntime).toBe(true);
  });

  test('returns the settled decision even if the session stops after the assistant reply lands', async () => {
    let pollCount = 0;
    let sent = false;
    const session: SessionSnapshot = {
      id: 'session-2',
      agent: 'codex',
      port: 0,
      name: 'Agent Chat',
      status: 'running',
      agentRuntimeStatus: 'running',
      startedAt: new Date().toISOString(),
      command: [],
      workingDirectory: '/tmp',
      logs: [],
    };
    const adapter: AgentAdapter = {
      async fetchStatus() {
        return 'running';
      },
      async sendMessage() {
        sent = true;
      },
      async fetchMessages() {
        if (!sent) {
          return [];
        }
        pollCount += 1;
        if (pollCount >= 4) {
          session.status = 'stopped';
        }
        return [
          {
            role: 'assistant',
            content: 'AGENT_CHAT_DECISION: ignore',
            createdAt: new Date().toISOString(),
          },
        ];
      },
      async interruptCurrentTurn() {
        return false;
      },
      getEventsUrl() {
        return null;
      },
      async waitForReady() {},
      async dispose() {},
    };

    const reply = await sendPromptAndAwaitAssistantReply(buildManager(session, adapter), session.id, 'prompt', {
      timeoutMs: 250,
      pollIntervalMs: 10,
      stablePolls: 2,
      decisionFallbackStablePolls: 3,
    });

    expect(reply.content).toBe('AGENT_CHAT_DECISION: ignore');
  });

  test('treats a trailing decision line inside Codex transcript output as parseable', async () => {
    const session: SessionSnapshot = {
      id: 'session-3',
      agent: 'codex',
      port: 0,
      name: 'Agent Chat',
      status: 'running',
      agentRuntimeStatus: 'running',
      startedAt: new Date().toISOString(),
      command: [],
      workingDirectory: '/tmp',
      logs: [],
    };
    const transcriptReply = [
      'Ran bun mycode/yoke.js chat reply-current --body "done"',
      '{"status":"sent"}',
      '',
      '• AGENT_CHAT_DECISION: respond',
    ].join('\n');
    const manager = buildManager(session, new FakeAdapter(transcriptReply));

    const reply = await sendPromptAndAwaitAssistantReply(manager, session.id, 'prompt', {
      timeoutMs: 250,
      pollIntervalMs: 10,
      stablePolls: 2,
      decisionFallbackStablePolls: 3,
    });

    expect(reply.content).toBe(transcriptReply);
    expect(reply.settledWithoutStableRuntime).toBe(true);
  });
});

describe('sendPromptAndAwaitFinalResponse', () => {
  function finalManager(messages: Array<{ role: string; content: string; createdAt: string }>, status: 'running' | 'stable' = 'stable') {
    const session = { id: 'direct-session', agent: 'codex', port: 0, name: 'Direct', status: 'running',
      agentRuntimeStatus: status, startedAt: new Date().toISOString(), command: [], workingDirectory: '/tmp', logs: [] } as SessionSnapshot;
    let sent = false;
    const adapter = {
      waitForReady: async () => {}, sendMessage: async () => { sent = true; },
      fetchMessages: async () => sent ? [{ role: 'user', content: 'prompt', createdAt: '2026-01-01T00:00:00Z' }, ...messages] : [],
      fetchStatus: async () => status, deliversPromptsDirectly: () => true,
      interruptCurrentTurn: async () => false, getEventsUrl: () => null, dispose: async () => {},
    } as AgentAdapter;
    return { session, manager: buildManager(session, adapter) };
  }

  test('publishes the final markdown card verbatim and excludes working progress', async () => {
    const markdown = '## Result\n\n- one\n- **two**\n';
    const { session, manager } = finalManager([
      { role: 'agent-working', content: 'Thinking and running tools', createdAt: '2026-01-01T00:00:01Z' },
      { role: 'agent', content: markdown, createdAt: '2026-01-01T00:00:02Z' },
    ]);
    const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, 'prompt', { timeoutMs: 100, pollIntervalMs: 10 });
    expect(reply.content).toBe(markdown);
  });

  test('uses the same stable startup readiness gate as manual prompt dispatch', async () => {
    const prompt = 'AGENT DIRECT CHAT\nNEXT MESSAGE\nmessage: wait until stable';
    const session = { id: 'direct-startup-readiness', agent: 'codex', port: 1, name: 'Direct', status: 'running',
      startedAt: new Date(), command: [], workingDirectory: '/repo', logs: [], metadata: { nativeAgentSession: {
        agent: 'codex', sessionId: 'native-ready', workingDirectory: '/repo', capturedAt: new Date().toISOString(), source: 'manual',
      } } } as unknown as SessionSnapshot;
    let statusPolls = 0;
    let sentAfterStatusPolls = 0;
    let sent = false;
    const adapter = {
      waitForReady: async () => {},
      getPromptReadiness: async () => {
        statusPolls += 1;
        return statusPolls === 1
          ? { state: 'starting', reason: 'codex-starting', retryAfterMs: 10, observedAt: Date.now() }
          : { state: 'ready', reason: 'agentapi-status-stable', retryAfterMs: 10, observedAt: Date.now() };
      },
      sendMessage: async () => { sent = true; sentAfterStatusPolls = statusPolls; },
      fetchStatus: async () => 'stable',
      fetchMessages: async () => sent ? [
        { role: 'user', content: prompt, createdAt: new Date().toISOString() },
        { role: 'agent', content: 'Ready response.', createdAt: new Date().toISOString() },
      ] : [],
      deliversPromptsDirectly: () => true,
      interruptCurrentTurn: async () => false, getEventsUrl: () => null, dispose: async () => {},
    } as AgentAdapter;
    const manager = buildManager(session, adapter);

    const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, prompt, {
      timeoutMs: 100,
      pollIntervalMs: 10,
    });

    expect(sentAfterStatusPolls).toBe(4);
    expect(reply.content).toBe('Ready response.');
  });

  test('accepts assistant as the other canonical final role', async () => {
    const { session, manager } = finalManager([{ role: 'assistant', content: 'Done', createdAt: '2026-01-01T00:00:01Z' }]);
    expect((await sendPromptAndAwaitFinalResponse(manager, session.id, 'prompt', { timeoutMs: 100, pollIntervalMs: 10 })).content).toBe('Done');
  });

  test('times out when a completed turn exposes progress but no final card', async () => {
    const { session, manager } = finalManager([{ role: 'agent-working', content: 'Only progress', createdAt: '2026-01-01T00:00:01Z' }]);
    await expect(sendPromptAndAwaitFinalResponse(manager, session.id, 'prompt', { timeoutMs: 30, pollIntervalMs: 10 })).rejects.toThrow('final response');
  });

  test('does not reuse a callback final that remains visible when the new direct prompt has no output', async () => {
    const prompt = 'AGENT DIRECT CHAT\nNEXT MESSAGE\nmessage_id: human-new';
    const stale = { role: 'assistant', content: 'Previous queued callback response.',
      createdAt: '2026-07-26T07:00:00.000Z', messageId: 'callback-final-old' };
    const session = { id: 'direct-stale-callback', agent: 'opencode', port: 0, name: 'Direct', status: 'running',
      startedAt: new Date().toISOString(), command: [], workingDirectory: '/tmp', logs: [] } as SessionSnapshot;
    let sent = false;
    const adapter = {
      waitForReady: async () => {}, sendMessage: async () => { sent = true; }, fetchStatus: async () => 'stable',
      fetchMessages: async () => sent ? [stale] : [], deliversPromptsDirectly: () => true,
      interruptCurrentTurn: async () => false, getEventsUrl: () => null, dispose: async () => {},
    } as AgentAdapter;

    await expect(sendPromptAndAwaitFinalResponse(buildManager(session, adapter), session.id, prompt,
      { timeoutMs: 60, pollIntervalMs: 10, promptBoundaryTimeoutMs: 20 })).rejects.toBeInstanceOf(PromptBoundaryNotObservedError);
  });

  test('does not use a later manager prompt final for the current human turn', async () => {
    const prompt = 'AGENT DIRECT CHAT\nNEXT MESSAGE\nmessage_id: human-new';
    const { session, manager } = finalManager([
      { role: 'user', content: 'Queued callback manager prompt', createdAt: '2026-01-01T00:00:01Z' },
      { role: 'assistant', content: 'Callback final', createdAt: '2026-01-01T00:00:02Z' },
    ]);
    await expect(sendPromptAndAwaitFinalResponse(manager, session.id, prompt,
      { timeoutMs: 30, pollIntervalMs: 10 })).rejects.toThrow('final response');
  });

  test('captures AgentAPI Codex native history and rejects the combined terminal transcript as final', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'direct-native-final-'));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const prompt = 'Explain the result';
    const nativeId = 'native-direct-1';
    try {
      const sessionDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, `rollout-2026-07-23T08-00-00-${nativeId}.jsonl`), [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-07-23T08:00:00.000Z', payload: { id: nativeId, cwd: '/repo' } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-07-23T08:00:01.000Z', payload: { type: 'user_message', message: prompt } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-07-23T08:00:02.000Z', payload: { type: 'agent_message', phase: 'commentary', message: 'Inspecting the implementation.' } }),
        JSON.stringify({ type: 'response_item', timestamp: '2026-07-23T08:00:03.000Z', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: JSON.stringify({ cmd: 'bun test' }) } }),
        JSON.stringify({ type: 'response_item', timestamp: '2026-07-23T08:00:04.000Z', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Process exited with code 0\nOutput:\npass' } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-07-23T08:00:05.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: '## Clean final\n\nEverything passed.' } }),
      ].join('\n'));

      let sent = false;
      let captureCalls = 0;
      const rawMessages = [
        { role: 'user', content: prompt, createdAt: '2026-07-23T08:00:01.000Z' },
        { role: 'agent', content: 'terminal startup\nthinking\ntool output\n## Clean final\nEverything passed.', createdAt: '2026-07-23T08:00:05.000Z' },
      ];
      const session = { id: 'agentapi-direct', agent: 'codex', port: 1, name: 'Direct', status: 'running',
        startedAt: new Date(), command: [], workingDirectory: '/repo', logs: [], metadata: {} } as unknown as SessionSnapshot;
      const adapter = {
        waitForReady: async () => {}, sendMessage: async () => { sent = true; }, fetchStatus: async () => 'stable',
        fetchMessages: async () => sent ? rawMessages : [], deliversPromptsDirectly: () => false,
        interruptCurrentTurn: async () => false, getEventsUrl: () => null, dispose: async () => {},
      } as AgentAdapter;
      const manager = {
        getSession: () => session, getAdapter: () => adapter,
        captureAgentapiCodexSessionIdFromPrompt: async (_id: string, capturedPrompt: string) => {
          captureCalls += 1;
          expect(capturedPrompt).toBe(prompt);
          session.metadata = { nativeAgentSession: { agent: 'codex', sessionId: nativeId, workingDirectory: '/repo', capturedAt: new Date().toISOString(), source: 'agentapi' } };
          return true;
        },
      } as unknown as ProcessManager;

      const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, prompt, { timeoutMs: 200, pollIntervalMs: 10 });
      expect(captureCalls).toBe(1);
      expect(reply.content).toBe('## Clean final\n\nEverything passed.');
      expect(reply.content).not.toContain('terminal startup');
      const authoritative = await resolveAuthoritativeSessionMessages(session, rawMessages, { requireNative: true });
      expect(authoritative.map((message) => message.role)).toEqual([
        'user', 'agent-thinking', 'agent-tools', 'agent',
      ]);
      expect(authoritative[1]?.content).toContain('Inspecting the implementation.');
      expect(authoritative[2]?.content).toContain('Tool call: exec_command `bun test`');
      expect(authoritative[3]?.content).toBe('## Clean final\n\nEverything passed.');
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test('finds the turn boundary when AgentAPI records the submitted prompt twice', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'direct-doubled-prompt-'));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const prompt = 'AGENT DIRECT CHAT\nNEXT MESSAGE\nmessage: doubled by AgentAPI';
    const nativeId = 'native-doubled-prompt';
    try {
      const sessionDir = join(codexHome, 'sessions', '2026', '07', '27');
      await mkdir(sessionDir, { recursive: true });
      const transcriptPath = join(sessionDir, `rollout-${nativeId}.jsonl`);
      await writeFile(transcriptPath, [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-07-27T08:52:02.000Z', payload: { id: nativeId, cwd: '/repo' } }),
      ].join('\n') + '\n');

      const session = { id: 'agentapi-doubled-prompt', agent: 'codex', port: 1, name: 'Direct', status: 'running',
        startedAt: new Date(), command: [], workingDirectory: '/repo', logs: [], metadata: { nativeAgentSession: {
          agent: 'codex', sessionId: nativeId, workingDirectory: '/repo', capturedAt: new Date().toISOString(), source: 'agentapi',
        } } } as unknown as SessionSnapshot;
      const adapter = {
        waitForReady: async () => {},
        sendMessage: async () => {
          await appendFile(transcriptPath, [
            JSON.stringify({ type: 'event_msg', timestamp: '2026-07-27T08:52:02.100Z', payload: { type: 'user_message', message: `${prompt}${prompt}` } }),
            JSON.stringify({ type: 'event_msg', timestamp: '2026-07-27T08:52:44.290Z', payload: { type: 'agent_message', phase: 'final_answer', message: 'The doubled prompt answer was recovered.' } }),
          ].join('\n') + '\n');
        },
        fetchStatus: async () => 'stable', fetchMessages: async () => [], deliversPromptsDirectly: () => false,
        interruptCurrentTurn: async () => false, getEventsUrl: () => null, dispose: async () => {},
      } as AgentAdapter;
      const manager = { getSession: () => session, getAdapter: () => adapter,
        captureAgentapiCodexSessionIdFromPrompt: async () => true } as unknown as ProcessManager;

      const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, prompt, { timeoutMs: 100, pollIntervalMs: 10 });
      expect(reply.content).toBe('The doubled prompt answer was recovered.');
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test('returns an authoritative native Codex final when AgentAPI status times out', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'direct-status-timeout-'));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const prompt = 'AGENT DIRECT CHAT\nNEXT MESSAGE\nmessage: publish this answer';
    const nativeId = 'native-status-timeout';
    try {
      const sessionDir = join(codexHome, 'sessions', '2026', '07', '27');
      await mkdir(sessionDir, { recursive: true });
      const transcriptPath = join(sessionDir, `rollout-${nativeId}.jsonl`);
      await writeFile(transcriptPath, [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-07-27T08:52:02.000Z', payload: { id: nativeId, cwd: '/repo' } }),
      ].join('\n') + '\n');

      const session = { id: 'agentapi-status-timeout', agent: 'codex', port: 1, name: 'Direct', status: 'running',
        startedAt: new Date(), command: [], workingDirectory: '/repo', logs: [], metadata: { nativeAgentSession: {
          agent: 'codex', sessionId: nativeId, workingDirectory: '/repo', capturedAt: new Date().toISOString(), source: 'agentapi',
        } } } as unknown as SessionSnapshot;
      let statusCalls = 0;
      let sent = false;
      const adapter = {
        waitForReady: async () => {},
        sendMessage: async () => {
          await appendFile(transcriptPath, [
            JSON.stringify({ type: 'event_msg', timestamp: '2026-07-27T08:52:02.100Z', payload: { type: 'user_message', message: prompt } }),
            JSON.stringify({ type: 'event_msg', timestamp: '2026-07-27T08:52:44.290Z', payload: { type: 'agent_message', phase: 'final_answer', message: 'This answer must reach Flight Deck.' } }),
          ].join('\n') + '\n');
          sent = true;
        },
        fetchStatus: async () => {
          statusCalls += 1;
          if (!sent) return 'stable';
          throw new Error('status request timed out');
        },
        fetchMessages: async () => { throw new Error('messages request timed out'); },
        deliversPromptsDirectly: () => false,
        interruptCurrentTurn: async () => false, getEventsUrl: () => null, dispose: async () => {},
      } as AgentAdapter;
      const manager = { getSession: () => session, getAdapter: () => adapter,
        captureAgentapiCodexSessionIdFromPrompt: async () => true } as unknown as ProcessManager;

      const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, prompt, { timeoutMs: 100, pollIntervalMs: 10 });
      expect(statusCalls).toBeGreaterThan(0);
      expect(reply.content).toBe('This answer must reach Flight Deck.');
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test('keeps retrying AgentAPI Codex discovery until a delayed native session appears', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'direct-delayed-native-'));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const prompt = 'AGENT DIRECT CHAT\nNEXT MESSAGE\nmessage: delayed capture';
    const nativeId = 'native-direct-delayed';
    try {
      const sessionDir = join(codexHome, 'sessions', '2026', '07', '27');
      await mkdir(sessionDir, { recursive: true });
      const transcriptPath = join(sessionDir, `rollout-${nativeId}.jsonl`);
      const session = { id: 'agentapi-delayed-direct', agent: 'codex', port: 1, name: 'Direct', status: 'running',
        startedAt: new Date(), command: [], workingDirectory: '/repo', logs: [], metadata: {} } as unknown as SessionSnapshot;
      const rawMessages = [
        { role: 'agent', content: `terminal screen\n${prompt}\nClean delayed final.`, createdAt: new Date().toISOString() },
      ];
      const adapter = {
        waitForReady: async () => {}, sendMessage: async () => {}, fetchStatus: async () => 'stable',
        fetchMessages: async () => rawMessages, deliversPromptsDirectly: () => false,
        interruptCurrentTurn: async () => false, getEventsUrl: () => null, dispose: async () => {},
      } as AgentAdapter;
      let captureCalls = 0;
      const manager = {
        getSession: () => session,
        getAdapter: () => adapter,
        captureAgentapiCodexSessionIdFromPrompt: async () => {
          captureCalls += 1;
          if (captureCalls < 2) return false;
          await writeFile(transcriptPath, [
            JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: nativeId, cwd: '/repo' } }),
            JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message: prompt } }),
            JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'agent_message', phase: 'final_answer', message: 'Clean delayed final.' } }),
          ].join('\n'));
          session.metadata = { nativeAgentSession: { agent: 'codex', sessionId: nativeId, workingDirectory: '/repo',
            capturedAt: new Date().toISOString(), source: 'agentapi' } };
          return true;
        },
      } as unknown as ProcessManager;

      const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, prompt, {
        timeoutMs: 1_500,
        pollIntervalMs: 10,
      });
      expect(captureCalls).toBeGreaterThanOrEqual(2);
      expect(reply.content).toBe('Clean delayed final.');
      expect(reply.content).not.toContain('terminal screen');
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test('rejects AgentAPI terminal output when native Codex discovery never succeeds', async () => {
    const prompt = 'AGENT DIRECT CHAT\nNEXT MESSAGE\nmessage: never captured';
    const session = { id: 'agentapi-uncaptured-direct', agent: 'codex', port: 1, name: 'Direct', status: 'running',
      startedAt: new Date(), command: [], workingDirectory: '/repo', logs: [], metadata: {} } as unknown as SessionSnapshot;
    const adapter = {
      waitForReady: async () => {}, sendMessage: async () => {}, fetchStatus: async () => 'stable',
      fetchMessages: async () => [
        { role: 'agent', content: `terminal screen\n${prompt}\nMalformed combined final.`, createdAt: new Date().toISOString() },
      ],
      deliversPromptsDirectly: () => false,
      interruptCurrentTurn: async () => false, getEventsUrl: () => null, dispose: async () => {},
    } as AgentAdapter;
    const manager = {
      getSession: () => session,
      getAdapter: () => adapter,
      captureAgentapiCodexSessionIdFromPrompt: async () => false,
    } as unknown as ProcessManager;

    await expect(sendPromptAndAwaitFinalResponse(manager, session.id, prompt, {
      timeoutMs: 40,
      pollIntervalMs: 10,
    })).rejects.toThrow('native Codex session was not captured; terminal output was rejected');
  });

  test('waits for the new native prompt boundary instead of returning a stale callback final', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'direct-native-boundary-'));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const prompt = 'AGENT DIRECT CHAT\nNEXT MESSAGE\nmessage: update please?';
    const nativeId = 'native-direct-boundary-1';
    try {
      const sessionDir = join(codexHome, 'sessions', '2026', '07', '26');
      await mkdir(sessionDir, { recursive: true });
      const transcriptPath = join(sessionDir, `rollout-${nativeId}.jsonl`);
      await writeFile(transcriptPath, [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-07-26T05:55:00.000Z', payload: { id: nativeId, cwd: '/repo' } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-07-26T05:57:02.000Z', payload: { type: 'user_message', message: 'Dispatched session completion callback.' } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-07-26T05:57:05.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: 'This callback was already reviewed and closed.' } }),
      ].join('\n') + '\n');

      let fetchCount = 0;
      let appendPromise: Promise<void> | null = null;
      const session = { id: 'agentapi-native-boundary', agent: 'codex', port: 1, name: 'Direct', status: 'running',
        startedAt: new Date(), command: [], workingDirectory: '/repo', logs: [], metadata: { nativeAgentSession: {
          agent: 'codex', sessionId: nativeId, workingDirectory: '/repo', capturedAt: new Date().toISOString(), source: 'agentapi',
        } } } as unknown as SessionSnapshot;
      const rawMessages = [
        { role: 'agent', content: 'combined terminal\nThis callback was already reviewed and closed.', createdAt: '2026-07-26T05:57:05.000Z' },
      ];
      const adapter = {
        waitForReady: async () => {},
        sendMessage: async () => {
          appendPromise = new Promise<void>((resolve, reject) => setTimeout(() => {
            void appendFile(transcriptPath, [
              JSON.stringify({ type: 'event_msg', timestamp: '2026-07-26T06:41:32.000Z', payload: { type: 'user_message', message: prompt } }),
              JSON.stringify({ type: 'event_msg', timestamp: '2026-07-26T06:41:34.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: 'The implementation is ready for review.' } }),
            ].join('\n') + '\n').then(() => resolve(), reject);
          }, 25));
        },
        fetchStatus: async () => 'stable',
        fetchMessages: async () => { fetchCount += 1; return rawMessages; },
        deliversPromptsDirectly: () => false,
        interruptCurrentTurn: async () => false, getEventsUrl: () => null, dispose: async () => {},
      } as AgentAdapter;
      const manager = { getSession: () => session, getAdapter: () => adapter,
        captureAgentapiCodexSessionIdFromPrompt: async () => true } as unknown as ProcessManager;

      const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, prompt, { timeoutMs: 250, pollIntervalMs: 10 });
      await appendPromise;
      expect(reply.content).toBe('The implementation is ready for review.');
      expect(reply.content).not.toContain('callback');
      expect(fetchCount).toBeGreaterThan(2);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test('recovers an accepted PM2-surviving turn from its later native final without resending', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'accepted-native-final-'));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const nativeId = 'native-accepted-1';
    try {
      const sessionDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, `rollout-${nativeId}.jsonl`), [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-07-23T09:00:00.000Z', payload: { id: nativeId, cwd: '/repo' } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-07-23T09:00:01.000Z', payload: { type: 'user_message', message: 'AGENT DIRECT CHAT\ntrigger_message_id: source-m1' } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-07-23T09:00:02.000Z', payload: { type: 'agent_message', phase: 'commentary', message: 'Still working.' } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-07-23T09:00:05.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: '## Survived restart\n\nClean final.' } }),
      ].join('\n'));
      const session = { id: 'pm2-survivor', agent: 'codex', port: 1, name: 'Direct', status: 'running', startedAt: new Date(),
        command: [], workingDirectory: '/repo', logs: [], metadata: { nativeAgentSession: { agent: 'codex', sessionId: nativeId,
          workingDirectory: '/repo', capturedAt: new Date().toISOString(), source: 'agentapi' } } } as unknown as SessionSnapshot;
      let sendCalls = 0;
      const adapter = { fetchStatus: async () => 'stable', fetchMessages: async () => [
        { role: 'agent', content: 'combined terminal\nStill working.\n## Survived restart', createdAt: '2026-07-23T09:00:05.000Z' },
      ], sendMessage: async () => { sendCalls += 1; }, waitForReady: async () => {}, interruptCurrentTurn: async () => false,
        getEventsUrl: () => null, dispose: async () => {} } as AgentAdapter;
      const manager = { getSession: () => session, getAdapter: () => adapter,
        captureAgentapiCodexSessionIdFromPrompt: async () => false } as unknown as ProcessManager;
      const reply = await awaitAcceptedFinalResponse(manager, session.id, 'reconstructed prompt', ['source-m1'], { timeoutMs: 100, pollIntervalMs: 10 });
      expect(reply.content).toBe('## Survived restart\n\nClean final.');
      expect(reply.content).not.toContain('combined terminal'); expect(sendCalls).toBe(0);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

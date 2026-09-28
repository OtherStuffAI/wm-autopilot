import { describe, expect, test } from 'bun:test';
import type { AgentAdapter } from '../agents/agent-adapter';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { sendPromptAndAwaitFinalResponse } from './direct-chat-response';

describe('Direct Chat prompt receipt', () => {
  test('waits for the completed SDK answer after native session capture and streaming commentary', async () => {
    const prompt = 'new Flight Deck question';
    const session = { id: 'sdk-captured', agent: 'codex', status: 'running', metadata: {
      agentTransport: 'codex-sdk', nativeAgentSession: { agent: 'codex', sessionId: 'native-sdk' },
    } } as SessionSnapshot;
    let sent = false;
    let completed = false;
    let content = '';
    const adapter = {
      getPromptReadiness: async () => ({ state: 'ready', reason: 'ready', retryAfterMs: 1, observedAt: Date.now() }),
      deliversPromptsDirectly: () => true,
      sendMessage: async () => {
        sent = true;
        content = 'I’ll check the latest thread.';
        await new Promise(resolve => setTimeout(resolve, 40));
        content = 'The complete answer for Flight Deck.';
        completed = true;
      },
      fetchStatus: async () => completed ? 'stable' : 'running',
      fetchMessages: async () => sent ? [
        { role: 'user', content: prompt, createdAt: new Date().toISOString() },
        { role: 'assistant', content, createdAt: new Date().toISOString() },
      ] : [],
    } as unknown as AgentAdapter;
    const manager = { getSession: () => session, getAdapter: () => adapter } as unknown as ProcessManager;
    const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, prompt, { timeoutMs: 200, pollIntervalMs: 5 });
    expect(completed).toBe(true);
    expect(reply.content).toBe('The complete answer for Flight Deck.');
  });

  test('publishes SDK commentary while sendMessage is still running', async () => {
    const prompt = 'new Flight Deck question';
    const session = { id: 'sdk-session', agent: 'codex', status: 'running',
      metadata: { agentTransport: 'codex-sdk' } } as SessionSnapshot;
    let progress = '';
    let final = '';
    let sent = false;
    let sawLiveProgress = false;
    const adapter = {
      getPromptReadiness: async () => ({ state: 'ready', reason: 'ready', retryAfterMs: 1, observedAt: Date.now() }),
      deliversPromptsDirectly: () => true,
      sendMessage: async () => {
        sent = true;
        setTimeout(() => { progress = 'Checking the thread.'; }, 10);
        await new Promise((resolve) => setTimeout(resolve, 50));
        final = 'Here is the answer.';
      },
      fetchStatus: async () => final ? 'stable' : 'running',
      fetchMessages: async () => sent ? [
        { role: 'user', content: prompt, createdAt: new Date().toISOString() },
        ...(final ? [{ role: 'assistant', content: final, createdAt: new Date().toISOString() }] : []),
      ] : [],
    } as unknown as AgentAdapter;
    const manager = { getSession: () => session, getAdapter: () => adapter } as unknown as ProcessManager;
    const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, prompt, {
      timeoutMs: 200, pollIntervalMs: 5,
      onPoll: () => { if (progress && !final) sawLiveProgress = true; },
    });
    expect(sawLiveProgress).toBe(true);
    expect(reply.content).toBe('Here is the answer.');
  });

  test('surfaces an SDK send failure during the live poll', async () => {
    const prompt = 'new Flight Deck question';
    const session = { id: 'sdk-failed', agent: 'codex', status: 'running',
      metadata: { agentTransport: 'codex-sdk' } } as SessionSnapshot;
    let sent = false;
    const adapter = {
      getPromptReadiness: async () => ({ state: 'ready', reason: 'ready', retryAfterMs: 1, observedAt: Date.now() }),
      deliversPromptsDirectly: () => true,
      sendMessage: async () => { sent = true; await new Promise((resolve) => setTimeout(resolve, 15)); throw new Error('SDK turn failed'); },
      fetchStatus: async () => 'running',
      fetchMessages: async () => sent ? [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }] : [],
    } as unknown as AgentAdapter;
    const manager = { getSession: () => session, getAdapter: () => adapter } as unknown as ProcessManager;
    await expect(sendPromptAndAwaitFinalResponse(manager, session.id, prompt,
      { timeoutMs: 200, pollIntervalMs: 5 })).rejects.toThrow('SDK turn failed');
  });

  test('an unrelated active goal does not acknowledge a successful transport write', async () => {
    let sent = false;
    let accepted = 0;
    const session = { id: 'resumed', agent: 'codex', status: 'running', metadata: {} } as SessionSnapshot;
    const adapter = {
      getPromptReadiness: async () => ({ state: 'ready', reason: 'ready', retryAfterMs: 1, observedAt: Date.now() }),
      deliversPromptsDirectly: () => true,
      sendMessage: async () => { sent = true; },
      fetchStatus: async () => sent ? 'running' : 'stable',
      fetchMessages: async () => [{ role: 'user', content: 'Continue the previous goal', createdAt: new Date().toISOString() }],
    } as unknown as AgentAdapter;
    const manager = { getSession: () => session, getAdapter: () => adapter } as unknown as ProcessManager;
    await expect(sendPromptAndAwaitFinalResponse(manager, session.id, 'new Flight Deck question', {
      timeoutMs: 60, pollIntervalMs: 10, promptBoundaryTimeoutMs: 20,
      onAccepted: () => { accepted += 1; },
    })).rejects.toThrow('final response');
    expect(sent).toBe(true);
    expect(accepted).toBe(0);
  });

  test('acknowledges once after receipt, before waiting for a delayed answer', async () => {
    let sent = false;
    let polls = 0;
    let accepted = 0;
    const prompt = 'new Flight Deck question';
    const session = { id: 'resumed', agent: 'codex', status: 'running', metadata: {} } as SessionSnapshot;
    const adapter = {
      getPromptReadiness: async () => ({ state: 'ready', reason: 'ready', retryAfterMs: 1, observedAt: Date.now() }),
      deliversPromptsDirectly: () => true,
      sendMessage: async () => { sent = true; expect(accepted).toBe(0); },
      fetchStatus: async () => 'stable',
      fetchMessages: async () => {
        if (!sent) return [];
        polls += 1;
        if (polls === 1) { expect(accepted).toBe(0); return []; }
        const messages = [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }];
        if (polls > 2) {
          expect(accepted).toBe(1);
          messages.push({ role: 'assistant', content: 'Answer', createdAt: new Date().toISOString() });
        }
        return messages;
      },
    } as unknown as AgentAdapter;
    const manager = { getSession: () => session, getAdapter: () => adapter } as unknown as ProcessManager;
    const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, prompt, {
      timeoutMs: 150, pollIntervalMs: 10,
      onAccepted: () => { accepted += 1; },
    });
    expect(reply.content).toBe('Answer');
    expect(accepted).toBe(1);
  });
});

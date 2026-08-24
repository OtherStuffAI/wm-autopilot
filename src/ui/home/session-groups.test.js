import { describe, expect, test } from 'bun:test';

import {
  countSessionsByHomeGroup,
  filterSessionsForHomeGroup,
  getHomeSessionGroup,
} from './session-groups.js';

describe('home session groups', () => {
  const sessions = [
    {
      id: 'my-1',
      metadata: { AGENT: false, billingMode: 'subscription' },
      origin: null,
    },
    {
      id: 'task-1',
      metadata: { AGENT: true, billingMode: 'subscription', role: 'agent-work', bindingType: 'task' },
      origin: { type: 'agent-work', id: 'task-1' },
    },
    {
      id: 'chat-1',
      metadata: { AGENT: true, billingMode: 'subscription', role: 'agent-chat' },
      origin: { type: 'agent-chat', id: 'thread-1' },
    },
    {
      id: 'agent-1',
      metadata: { AGENT: true, billingMode: 'subscription' },
      origin: { type: 'cli', id: 'npub1example' },
    },
    {
      id: 'fork-1',
      metadata: { AGENT: false, billingMode: 'subscription' },
      origin: { type: 'fork', id: 'base-1' },
    },
    {
      id: 'api-created-1',
      npub: 'npub1owner',
      metadata: { AGENT: false, billingMode: 'subscription', createdByNpub: 'npub1agent' },
      origin: null,
    },
  ];

  test('classifies home session groups by origin and metadata', () => {
    expect(getHomeSessionGroup(sessions[0])).toBe('my');
    expect(getHomeSessionGroup(sessions[1])).toBe('auto');
    expect(getHomeSessionGroup(sessions[2])).toBe('auto');
    expect(getHomeSessionGroup(sessions[3])).toBe('auto');
    expect(getHomeSessionGroup(sessions[4])).toBe('my');
    expect(getHomeSessionGroup(sessions[5])).toBe('auto');
  });

  test('classifies session-dispatch workers from either stable provenance marker', () => {
    const dispatchSessions = [
      {
        id: 'dispatch-both',
        metadata: { AGENT: false, role: 'dispatched-worker' },
        origin: { type: 'session-dispatch', id: 'supervisor-1' },
      },
      {
        id: 'dispatch-origin-only',
        metadata: { AGENT: false },
        origin: { type: 'session-dispatch', id: 'unmonitored' },
      },
      {
        id: 'dispatch-role-only',
        metadata: { AGENT: false, role: 'dispatched-worker' },
        origin: null,
      },
    ];

    expect(dispatchSessions.map(getHomeSessionGroup)).toEqual(['auto', 'auto', 'auto']);
  });

  test('filters sessions for the selected home group', () => {
    expect(filterSessionsForHomeGroup(sessions, 'my').map((session) => session.id)).toEqual(['my-1', 'fork-1']);
    expect(filterSessionsForHomeGroup(sessions, 'auto').map((session) => session.id)).toEqual([
      'task-1',
      'chat-1',
      'agent-1',
      'api-created-1',
    ]);
  });

  test('counts sessions for each home group', () => {
    expect(countSessionsByHomeGroup(sessions)).toEqual({
      my: 2,
      auto: 4,
    });
  });
});

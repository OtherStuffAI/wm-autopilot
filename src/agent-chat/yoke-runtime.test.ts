import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import type { AgentChatYokeContext } from './yoke-runtime';
import {
  appendReplyToCachedChatContext,
  reconcileCachedWorkspaceKey,
  shouldReuseCachedChatContext,
} from './yoke-runtime';

function makeContext(): AgentChatYokeContext {
  return {
    channel_id: 'channel-1',
    thread_id: 'thread-1',
    participants: ['npub1user', 'npub1bot'],
    recent_messages: [],
  };
}

describe('shouldReuseCachedChatContext', () => {
  test('reuses a fresh cached context for the same thread and token', () => {
    const now = Date.now();
    const reusable = shouldReuseCachedChatContext({
      state: {
        token: 'token-1',
        lastSyncedAt: new Date(now).toISOString(),
        cachedChatContext: {
          channelId: 'channel-1',
          threadId: 'thread-1',
          fetchedAt: new Date(now - 1_000).toISOString(),
          context: makeContext(),
        },
      },
      token: 'token-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      minSyncIntervalMs: 5_000,
    });

    expect(reusable).toBe(true);
  });

  test('does not reuse cached context when the cache is stale or mismatched', () => {
    const now = Date.now();
    expect(shouldReuseCachedChatContext({
      state: {
        token: 'token-1',
        lastSyncedAt: new Date(now).toISOString(),
        cachedChatContext: {
          channelId: 'channel-1',
          threadId: 'thread-1',
          fetchedAt: new Date(now - 10_000).toISOString(),
          context: makeContext(),
        },
      },
      token: 'token-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      minSyncIntervalMs: 5_000,
    })).toBe(false);

    expect(shouldReuseCachedChatContext({
      state: {
        token: 'token-1',
        lastSyncedAt: new Date(now).toISOString(),
        cachedChatContext: {
          channelId: 'channel-1',
          threadId: 'thread-2',
          fetchedAt: new Date(now - 1_000).toISOString(),
          context: makeContext(),
        },
      },
      token: 'token-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      minSyncIntervalMs: 5_000,
    })).toBe(false);
  });
});

describe('appendReplyToCachedChatContext', () => {
  test('appends the bot reply to a matching cached thread context', () => {
    const next = appendReplyToCachedChatContext({
      state: {
        token: 'token-1',
        lastSyncedAt: '2026-04-23T10:00:00.000Z',
        cachedChatContext: {
          channelId: 'channel-1',
          threadId: 'thread-1',
          fetchedAt: '2026-04-23T10:00:00.000Z',
          context: makeContext(),
        },
      },
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'bot-reply-1',
      body: 'On it.',
      senderNpub: 'npub1bot',
      at: '2026-04-23T10:00:01.000Z',
    });

    expect(next.cachedChatContext?.fetchedAt).toBe('2026-04-23T10:00:01.000Z');
    expect(next.cachedChatContext?.context?.participants).toContain('npub1bot');
    expect(next.cachedChatContext?.context?.recent_messages.at(-1)).toEqual({
      message_id: 'bot-reply-1',
      parent_message_id: 'thread-1',
      sender_npub: 'npub1bot',
      body: 'On it.',
      attachments: [],
      updated_at: '2026-04-23T10:00:01.000Z',
    });
  });
});

describe('reconcileCachedWorkspaceKey', () => {
  test('replaces stale cached workspace key material with the subscription key', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agent-chat-yoke-state-'));
    try {
      const db = new Database(join(stateDir, 'flightdeck-cli.db'));
      db.exec(`
        CREATE TABLE workspace_keys (
          workspace_owner_npub TEXT PRIMARY KEY,
          user_npub TEXT NOT NULL,
          ws_key_npub TEXT NOT NULL,
          ws_key_epoch INTEGER NOT NULL DEFAULT 1,
          encrypted_blob TEXT NOT NULL,
          cached_at TEXT NOT NULL
        );
        CREATE TABLE workspace_key_mappings (
          ws_key_npub TEXT PRIMARY KEY,
          user_npub TEXT NOT NULL,
          cached_at TEXT NOT NULL
        );
      `);
      db.query(`
        INSERT INTO workspace_keys (workspace_owner_npub, user_npub, ws_key_npub, ws_key_epoch, encrypted_blob, cached_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        'npub1owner',
        'npub1bot',
        'npub1oldws',
        1,
        JSON.stringify({ workspace_owner_npub: 'npub1owner', ws_key_npub: 'npub1oldws' }),
        '2026-05-17T00:00:00.000Z',
      );
      db.close();

      const changed = reconcileCachedWorkspaceKey(stateDir, {
        workspaceOwnerNpub: 'npub1owner',
        botNpub: 'npub1bot',
        wsKeyNpub: 'npub1newws',
        wsKeyBlobJson: JSON.stringify({
          workspace_owner_npub: 'npub1owner',
          ws_key_npub: 'npub1newws',
          ws_key_epoch: 2,
          encrypted_blob: 'ciphertext',
        }),
      } as never);

      const verifyDb = new Database(join(stateDir, 'flightdeck-cli.db'));
      try {
        expect(changed).toBe(true);
        expect(verifyDb.query('SELECT ws_key_npub, user_npub, ws_key_epoch FROM workspace_keys WHERE workspace_owner_npub = ?')
          .get('npub1owner')).toMatchObject({
            ws_key_npub: 'npub1newws',
            user_npub: 'npub1bot',
            ws_key_epoch: 2,
          });
        expect(verifyDb.query('SELECT user_npub FROM workspace_key_mappings WHERE ws_key_npub = ?')
          .get('npub1newws')).toMatchObject({ user_npub: 'npub1bot' });
      } finally {
        verifyDb.close();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

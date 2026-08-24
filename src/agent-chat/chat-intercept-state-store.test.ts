import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { ChatInterceptStateStore } from './chat-intercept-state-store';

describe('ChatInterceptStateStore durable migration', () => {
  test('migrates a legacy binding and preserves it across reopen', () => {
    const path = join(tmpdir(), `agent-direct-migration-${randomUUID()}.sqlite`);
    const db = new Database(path);
    db.exec(`CREATE TABLE chat_intercept_state (routing_key TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', session_id TEXT, session_class TEXT NOT NULL, workspace_owner_npub TEXT NOT NULL, source_app_npub TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT NOT NULL, target_bot_npub TEXT NOT NULL, last_message_id_seen TEXT, pending_message_count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, last_decision TEXT NOT NULL DEFAULT 'pending', last_activity_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    db.query(`INSERT INTO chat_intercept_state VALUES (?1,?2,?3,?4,'chat',?5,?6,?7,?8,?9,?10,1,'idle','respond',?11,?11,?11)`).run('route','sub','exampleAgent','session-1','owner','app','channel','thread','npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg','m1',new Date().toISOString());
    db.close();
    const store = new ChatInterceptStateStore(path); const migrated = store.getByRoutingKey('route')!;
    expect(migrated.sessionId).toBe('session-1'); expect(migrated.sessionGeneration).toBe(1); expect(migrated.previousSessionIds).toEqual([]);
    expect(migrated.lastHumanMessageIdDelivered).toBeNull();
    store.save({ ...migrated, lastEventCursorSeen: 'cursor-1', lastHumanMessageIdDelivered: 'm1', updatedAt: new Date().toISOString() });
    const reopened = new ChatInterceptStateStore(path).getByRoutingKey('route')!;
    expect(reopened.lastEventCursorSeen).toBe('cursor-1'); expect(reopened.lastHumanMessageIdDelivered).toBe('m1');
    const duplicate = store.upsertMessage({ routingKey: 'route', subscriptionId: 'sub', agentId: 'exampleAgent',
      workspaceOwnerNpub: 'owner', sourceAppNpub: 'app', channelId: 'channel', threadId: 'thread',
      botNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', messageId: 'm1', eventCursor: 'cursor-2' });
    expect(duplicate.wasDuplicate).toBe(true); expect(duplicate.record.lastEventCursorSeen).toBe('cursor-2');
  });
});

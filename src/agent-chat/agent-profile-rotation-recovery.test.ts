import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { AgentDefinitionStore } from './agent-definition-store';

function makeTempDb(): string {
  return join(tmpdir(), `agent-profile-rotation-recovery-${randomUUID()}.sqlite`);
}

describe('completed Agent Profile rotation recovery', () => {
  test('restores a profile that was rebound to its retired identity', () => {
    const dbPath = makeTempDb();
    const store = new AgentDefinitionStore(dbPath);
    const now = new Date().toISOString();
    store.save({
      agentId: 'rotated-profile',
      label: 'Rotated profile',
      botNpub: 'npub1new',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: [],
      workingDirectory: '/tmp/rotated-profile',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE agent_profile_key_rotations (
        rotation_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        managed_by_npub TEXT NOT NULL,
        old_npub TEXT NOT NULL,
        new_npub TEXT,
        state TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tower_request_json TEXT
      )
    `);
    db.query(`
      INSERT INTO agent_profile_key_rotations (
        rotation_id, request_id, profile_id, managed_by_npub, old_npub,
        new_npub, state, result_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'completed', '{}', ?7, ?7)
    `).run('rotation-1', 'request-1', 'rotated-profile', 'npub1manager', 'npub1old', 'npub1new', now);
    db.query("UPDATE agent_definitions SET bot_npub = 'npub1old' WHERE agent_id = 'rotated-profile'").run();
    db.close();

    const recovered = new AgentDefinitionStore(dbPath);
    expect(recovered.getByAgentId('rotated-profile')?.botNpub).toBe('npub1new');
  });

  test('does not infer a replacement from an incomplete rotation', () => {
    const dbPath = makeTempDb();
    const store = new AgentDefinitionStore(dbPath);
    const now = new Date().toISOString();
    store.save({
      agentId: 'unchanged-profile',
      label: 'Unchanged profile',
      botNpub: 'npub1old',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: [],
      workingDirectory: '/tmp/unchanged-profile',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE agent_profile_key_rotations (
        rotation_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        managed_by_npub TEXT NOT NULL,
        old_npub TEXT NOT NULL,
        new_npub TEXT,
        state TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tower_request_json TEXT
      )
    `);
    db.query(`
      INSERT INTO agent_profile_key_rotations (
        rotation_id, request_id, profile_id, managed_by_npub, old_npub,
        new_npub, state, result_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'failed_before_cutover', '{}', ?7, ?7)
    `).run('rotation-1', 'request-1', 'unchanged-profile', 'npub1manager', 'npub1old', 'npub1new', now);
    db.close();

    const recovered = new AgentDefinitionStore(dbPath);
    expect(recovered.getByAgentId('unchanged-profile')?.botNpub).toBe('npub1old');
  });
});

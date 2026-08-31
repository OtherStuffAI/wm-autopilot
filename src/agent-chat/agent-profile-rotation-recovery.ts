import type { Database } from 'bun:sqlite';

interface TableRow {
  name: string;
}

/**
 * Restore profiles that were rebound to a retired identity after a completed
 * key rotation. The completed rotation row is the durable cutover authority.
 */
export function recoverCompletedAgentProfileRotations(db: Database): number {
  const rotationTable = db.query<TableRow, [string]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
  ).get('agent_profile_key_rotations');
  if (!rotationTable) return 0;

  const now = new Date().toISOString();
  const result = db.query(`
    UPDATE agent_definitions
    SET bot_npub = (
      SELECT rotation.new_npub
      FROM agent_profile_key_rotations AS rotation
      WHERE rotation.profile_id = agent_definitions.agent_id
        AND rotation.managed_by_npub = agent_definitions.managed_by_npub
        AND rotation.old_npub = agent_definitions.bot_npub
        AND rotation.state = 'completed'
        AND rotation.new_npub IS NOT NULL
      ORDER BY rotation.updated_at DESC
      LIMIT 1
    ),
    updated_at = ?1
    WHERE EXISTS (
      SELECT 1
      FROM agent_profile_key_rotations AS rotation
      WHERE rotation.profile_id = agent_definitions.agent_id
        AND rotation.managed_by_npub = agent_definitions.managed_by_npub
        AND rotation.old_npub = agent_definitions.bot_npub
        AND rotation.state = 'completed'
        AND rotation.new_npub IS NOT NULL
    )
  `).run(now);
  return result.changes;
}

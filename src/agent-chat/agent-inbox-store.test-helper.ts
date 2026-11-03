import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentInboxStore } from './agent-inbox-store';

/** A strict-inbox store in its own temp directory, so manager fixtures never fall back to the shared default database. */
export function isolatedAgentInboxStore(): AgentInboxStore {
  return new AgentInboxStore(join(mkdtempSync(join(tmpdir(), 'wm-agent-inbox-')), 'agent-inbox.db'));
}

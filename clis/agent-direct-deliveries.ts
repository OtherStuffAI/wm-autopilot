#!/usr/bin/env bun
import { DirectChatTurnStore } from '../src/agent-chat/direct-chat-turn-store';
import { databaseFile } from '../src/storage/message-store';

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log('Usage: bun clis/agent-direct-deliveries.ts audit --database <backup-path> [--json]');
  console.log('Simulates the deterministic local migration on the supplied backup. It never writes to Tower.');
  process.exit(0);
}

const command = process.argv.slice(2).find((arg) => !arg.startsWith('-')) ?? 'audit';
if (command !== 'audit') {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

const databaseIndex = process.argv.indexOf('--database');
const selectedDatabase = databaseIndex >= 0 ? process.argv[databaseIndex + 1] : null;
if (!selectedDatabase) throw new Error('Audit requires --database <backup-path>; it will not mutate the live database implicitly.');
const store = new DirectChatTurnStore(selectedDatabase);
const rows = store.audit();
if (args.has('--json')) {
  console.log(JSON.stringify({ database: selectedDatabase, liveDatabase: databaseFile, towerWrites: false, count: rows.length, rows }, null, 2));
} else {
  console.log(`Agent Direct durable delivery audit (dry run): ${rows.length} recoverable row(s)`);
  for (const row of rows) console.log(`${row.turnId}  ${row.state}  ${row.classification}  ${row.detail}`);
}

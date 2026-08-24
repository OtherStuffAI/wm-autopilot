import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('retries helper resolution after a failed dynamic import', async () => {
  const child = Bun.spawn([
    process.execPath,
    '-e',
    `process.env.AGENT_CHAT_YOKE_HELPERS_PATH='/missing/flightdeck-cli/bot-helpers.js';
     const {loadYokeBotHelpers}=await import('./src/agent-chat/yoke-bot-helpers.ts');
     try { await loadYokeBotHelpers(); } catch {}
     process.env.AGENT_CHAT_YOKE_HELPERS_PATH=import.meta.dir+'/node_modules/@runwingman/flightdeck-cli/src/bot-helpers.js';
     const helpers=await loadYokeBotHelpers();
     if (typeof helpers.signBotRequest !== 'function') process.exit(1);`,
  ], {
    cwd: join(import.meta.dir, '../..'),
    stderr: 'pipe',
  });

  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
});

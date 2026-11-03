import { expect, test } from 'bun:test';
import { enabledBotProfiles } from './bot-profile-select.js';

test('offers only enabled, unarchived bot profiles by stable id', () => {
  expect(enabledBotProfiles([
    { agentId: 'piper', label: 'Piper', enabled: true },
    { agentId: 'off', label: 'Off', enabled: false },
    { agentId: 'gone', label: 'Gone', enabled: true, archived: true },
    { agentId: 'rick', enabled: true },
    { label: 'No id', enabled: true },
  ])).toEqual([{ agentId: 'piper', label: 'Piper' }, { agentId: 'rick', label: 'rick' }]);
  expect(enabledBotProfiles(undefined)).toEqual([]);
});

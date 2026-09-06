import { expect, test } from 'bun:test';
import { settingGroup, settingValueState } from './settings-purpose.js';

test('distinguishes optional unset values from environment, defaults and saved overrides', () => {
  expect(settingValueState({})).toBe('No override');
  expect(settingValueState({ defaultValue: 'false' })).toBe('Using default');
  expect(settingValueState({ maskedValue: 'false' })).toBe('From environment');
  expect(settingValueState({ configured: true })).toBe('Saved in Autopilot');
  expect(settingValueState({ bootstrapOnly: true })).toBe('Set in deployment');
});
test('keeps startup-only controls in a distinct group', () => {
  expect(settingGroup({ category: 'identity', bootstrapOnly: true })).toBe('bootstrap');
  expect(settingGroup({ category: 'pipelines' })).toBe('pipelines');
});

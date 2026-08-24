import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import {
  loadRepoBoardConfig,
  resolveBoardConfigPath,
  saveRepoBoardConfig,
} from './yoke-board';

describe('yoke board config', () => {
  test('saves and reloads repo board config with derived state dir', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wm-board-config-'));
    const saved = saveRepoBoardConfig(repoRoot, {
      backendBaseUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1source',
    });

    expect(resolveBoardConfigPath(repoRoot)).toBe(saved.configPath);
    const loaded = loadRepoBoardConfig(repoRoot);
    expect(loaded.backendBaseUrl).toBe('https://tower.example.com');
    expect(loaded.workspaceOwnerNpub).toBe('npub1workspace');
    expect(loaded.sourceAppNpub).toBe('npub1source');
    expect(loaded.stateDir.endsWith('/.wingmen/board-state')).toBe(true);
  });

  test('finds board config from nested working directories', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'wm-board-nested-'));
    const nested = join(repoRoot, 'src', 'feature');
    mkdirSync(nested, { recursive: true });
    saveRepoBoardConfig(repoRoot, {
      backendBaseUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1source',
      stateDir: '.wm-state',
    });

    const configPath = resolveBoardConfigPath(nested);
    expect(configPath?.endsWith('/.wingmen/board.json')).toBe(true);
    const loaded = loadRepoBoardConfig(nested);
    expect(loaded.stateDir.endsWith('/.wm-state')).toBe(true);
  });
});

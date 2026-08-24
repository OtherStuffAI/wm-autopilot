import { describe, expect, test } from 'bun:test';

import { deriveGitHubWebUrl, parseGitRemoteList } from './git-command-api.js';

describe('parseGitRemoteList', () => {
  test('groups fetch and push URLs by remote name', () => {
    const remotes = parseGitRemoteList([
      'origin https://github.com/openai/wingmen.git (fetch)',
      'origin https://github.com/openai/wingmen.git (push)',
      'upstream https://github.com/openai/platform.git (fetch)',
      'upstream git@github.com:openai/platform.git (push)',
    ].join('\n'));

    expect(remotes).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://github.com/openai/wingmen.git',
        pushUrl: 'https://github.com/openai/wingmen.git',
      },
      {
        name: 'upstream',
        fetchUrl: 'https://github.com/openai/platform.git',
        pushUrl: 'git@github.com:openai/platform.git',
      },
    ]);
  });

  test('ignores lines that do not match git remote -v output', () => {
    expect(parseGitRemoteList('warning: nothing configured')).toEqual([]);
  });
});

describe('deriveGitHubWebUrl', () => {
  test('converts an HTTPS GitHub remote to the repo page URL', () => {
    expect(deriveGitHubWebUrl('https://github.com/openai/wingmen.git')).toBe('https://github.com/openai/wingmen');
  });

  test('converts an SSH GitHub remote to the repo page URL', () => {
    expect(deriveGitHubWebUrl('git@github.com:openai/wingmen.git')).toBe('https://github.com/openai/wingmen');
  });

  test('returns null for non-GitHub remotes', () => {
    expect(deriveGitHubWebUrl('https://git.example.com/openai/wingmen.git')).toBeNull();
  });
});

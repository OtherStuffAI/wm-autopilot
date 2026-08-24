import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { executeGitCommand } from './git-operations';

function runGit(directory: string, args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: directory });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr) || `git ${args.join(' ')} failed`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function createRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), 'wingmen-git-operations-'));
  runGit(repoDir, ['init', '-b', 'main']);
  writeFileSync(join(repoDir, 'README.md'), '# Wingmen\n');
  runGit(repoDir, ['add', 'README.md']);
  runGit(repoDir, ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', 'Initial commit']);
  return repoDir;
}

describe('executeGitCommand', () => {
  test('status reports the current branch and worktree changes', async () => {
    const repoDir = createRepo();
    try {
      writeFileSync(join(repoDir, 'notes.txt'), 'pending change\n');

      const result = await executeGitCommand({
        directory: repoDir,
        action: 'status',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('## main');
      expect(result.stdout).toContain('?? notes.txt');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('switchBranch changes the checked out branch', async () => {
    const repoDir = createRepo();
    try {
      runGit(repoDir, ['branch', 'feature/menu']);

      const result = await executeGitCommand({
        directory: repoDir,
        action: 'switchBranch',
        branch: 'feature/menu',
      });

      expect(result.exitCode).toBe(0);
      expect(runGit(repoDir, ['branch', '--show-current'])).toBe('feature/menu');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('setRemote adds and updates remotes that listRemotes can inspect', async () => {
    const repoDir = createRepo();
    try {
      const addResult = await executeGitCommand({
        directory: repoDir,
        action: 'setRemote',
        remote: 'origin',
        remoteUrl: 'https://github.com/openai/wingmen.git',
      });
      expect(addResult.exitCode).toBe(0);

      const listAfterAdd = await executeGitCommand({
        directory: repoDir,
        action: 'listRemotes',
      });
      expect(listAfterAdd.exitCode).toBe(0);
      expect(listAfterAdd.stdout).toContain('origin\thttps://github.com/openai/wingmen.git (fetch)');

      const updateResult = await executeGitCommand({
        directory: repoDir,
        action: 'setRemote',
        remote: 'origin',
        remoteUrl: 'https://github.com/openai/wingmen-v2.git',
      });
      expect(updateResult.exitCode).toBe(0);

      const listAfterUpdate = await executeGitCommand({
        directory: repoDir,
        action: 'listRemotes',
      });
      expect(listAfterUpdate.stdout).toContain('origin\thttps://github.com/openai/wingmen-v2.git (fetch)');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('commit uses the provided git author environment', async () => {
    const repoDir = createRepo();
    try {
      writeFileSync(join(repoDir, 'notes.txt'), 'attributed change\n');
      runGit(repoDir, ['add', 'notes.txt']);

      const result = await executeGitCommand({
        directory: repoDir,
        action: 'commit',
        message: 'Add attributed notes',
        gitEnv: {
          GIT_AUTHOR_NAME: 'GitHub User',
          GIT_AUTHOR_EMAIL: 'github-user@users.noreply.github.com',
          GIT_COMMITTER_NAME: 'GitHub User',
          GIT_COMMITTER_EMAIL: 'github-user@users.noreply.github.com',
        },
      });

      expect(result.exitCode).toBe(0);
      expect(runGit(repoDir, ['log', '-1', '--format=%an <%ae>|%cn <%ce>'])).toBe(
        'GitHub User <github-user@users.noreply.github.com>|GitHub User <github-user@users.noreply.github.com>',
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

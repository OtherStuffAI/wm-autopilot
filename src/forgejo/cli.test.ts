import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, test } from 'bun:test';

import { runForgejoCli } from './cli';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Tower-backed Forgejo CLI', () => {
  test('lists issues with an agent-brokered NIP-98 request to Tower', async () => {
    const observed: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
    const result = await runForgejoCli([
      'issues', 'list', '--workspace', 'workspace-1', '--repo', 'repository-1',
      '--state', 'all', '--page', '2', '--limit', '20', '--tower-url', 'https://tower.test',
    ], testIo(observed, (request) => {
      if (request.url.startsWith('https://tower.test/')) {
        return Response.json({ issues: [{ issue_number: 7, title: 'Test issue' }] });
      }
      return null;
    }));

    expect(result.exitCode).toBe(0);
    const broker = observed.find((request) => request.url.endsWith('/api/mcp/capabilities/nip98'));
    expect(broker?.body).toMatchObject({
      url: 'https://tower.test/api/v4/git/workspaces/workspace-1/repositories/repository-1/issues?state=all&page=2&limit=20',
      method: 'GET',
      sessionId: 'session-1',
    });
    expect((broker?.body as Record<string, unknown>)?.bodyHash).toBeUndefined();
    const tower = observed.find((request) => request.url.startsWith('https://tower.test/'));
    expect(tower?.authorization).toBe('Nostr broker-signed-token');
    expect(JSON.parse(result.stdout ?? '{}').issues[0].issue_number).toBe(7);
  });

  test('creates an issue using the exact serialized body hash', async () => {
    const observed: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
    const result = await runForgejoCli([
      'issues', 'create', '--workspace', 'workspace-1', '--repo', 'repository-1',
      '--title', 'Fix the signing flow', '--body', 'Expected behavior', '--correlation-id', 'task-1',
      '--tower-url', 'https://tower.test',
    ], testIo(observed, (request) => {
      if (request.url.startsWith('https://tower.test/')) {
        return Response.json({ issue: { issue_number: 8, title: 'Fix the signing flow', author: { username: 'rick' } } }, { status: 201 });
      }
      return null;
    }));

    expect(result.exitCode).toBe(0);
    const tower = observed.find((request) => request.url.startsWith('https://tower.test/'));
    const expectedBody = JSON.stringify({
      title: 'Fix the signing flow',
      body: 'Expected behavior',
      correlation_id: 'task-1',
    });
    expect(tower?.body).toEqual(JSON.parse(expectedBody));
    const broker = observed.find((request) => request.url.endsWith('/api/mcp/capabilities/nip98'));
    expect(broker?.body).toMatchObject({
      method: 'POST',
      bodyHash: createHash('sha256').update(expectedBody).digest('hex'),
    });
    expect(JSON.parse(result.stdout ?? '{}').issue.author.username).toBe('rick');
  });

  test('reads a comment body from a file and sends it through Tower', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wingman-forgejo-cli-'));
    temporaryDirectories.push(directory);
    const bodyFile = join(directory, 'comment.md');
    writeFileSync(bodyFile, 'Validated on the rebuilt runtime.\n');
    const observed: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
    const result = await runForgejoCli([
      'issues', 'comment', '8', '--workspace', 'workspace-1', '--repo', 'repository-1',
      '--body-file', bodyFile, '--tower-url', 'https://tower.test',
    ], testIo(observed, (request) => {
      if (request.url.startsWith('https://tower.test/')) {
        return Response.json({ comment: { comment_id: 3, issue_number: 8 } }, { status: 201 });
      }
      return null;
    }));

    expect(result.exitCode).toBe(0);
    const tower = observed.find((request) => request.url.startsWith('https://tower.test/'));
    expect(tower?.url).toEndWith('/issues/8/comments');
    expect(tower?.body).toEqual({ body: 'Validated on the rebuilt runtime.\n' });
  });

  test('returns Tower error codes without exposing signing material', async () => {
    const observed: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
    const result = await runForgejoCli([
      'issues', 'read', '9', '--workspace', 'workspace-1', '--repo', 'repository-1',
      '--tower-url', 'https://tower.test',
    ], testIo(observed, (request) => {
      if (request.url.startsWith('https://tower.test/')) {
        return Response.json({ error: 'Issue not found', code: 'git_issue_not_found' }, { status: 404 });
      }
      return null;
    }));

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr ?? '{}')).toEqual({
      ok: false,
      error: 'Issue not found',
      status: 404,
      code: 'git_issue_not_found',
    });
    expect(result.stderr).not.toContain('broker-signed-token');
  });

  test('requires an agent capability and never accepts a private-key flag', async () => {
    const result = await runForgejoCli([
      'issues', 'list', '--workspace', 'workspace-1', '--repo', 'repository-1',
      '--tower-url', 'https://tower.test', '--key', 'not-supported',
    ], { env: {} });

    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr ?? '{}').error as string;
    expect(error).toContain('Private signing keys');
    expect(error).toContain('provider tokens are not accepted');
    expect(error).toContain('--key is not supported');
  });
});

function testIo(
  observed: Array<{ url: string; method: string; authorization: string | null; body: unknown }>,
  towerResponse: (request: Request) => Response | null,
) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const rawBody = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
    observed.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get('authorization'),
      body: rawBody ? JSON.parse(rawBody) : null,
    });
    if (request.url === 'https://wingman.test/api/mcp/capabilities/nip98') {
      return Response.json({ token: 'Nostr broker-signed-token', signedBy: 'npub1agent' });
    }
    return towerResponse(request) ?? Response.json({ error: 'Unexpected request' }, { status: 500 });
  };
  return {
    fetchImpl,
    capabilityContext: {
      wingmanUrl: 'https://wingman.test',
      sessionId: 'session-1',
      capabilityToken: 'session-capability',
      fetch: fetchImpl,
    },
  };
}

test('bootstrap and username commands use the scoped broker without inherited Tower configuration', async () => {
  const calls: any[] = [];
  const context = {
    wingmanUrl: 'http://127.0.0.1:3600', sessionId: 'headless', capabilityToken: 'scoped',
    fetch: (async (url: any, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return Response.json({ bootstrap: { state: 'pending' } });
    }) as typeof fetch,
  };
  for (const args of [['bootstrap', 'request'], ['bootstrap', 'status'], ['username', 'set', '--username', 'new-agent']]) {
    expect((await runForgejoCli(args, { env: {}, capabilityContext: context })).exitCode).toBe(0);
  }
  expect(calls.map(c => c.body.action)).toEqual(['request', 'status', 'username']);
  expect(calls[2].body).toMatchObject({ username: 'new-agent', sessionId: 'headless' });
  expect(calls.every(c => c.url.endsWith('/api/mcp/capabilities/git-bootstrap'))).toBeTrue();
});

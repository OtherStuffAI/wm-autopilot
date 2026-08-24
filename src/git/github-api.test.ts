import { afterEach, describe, expect, test } from "bun:test";

import { GitHubApiClient, GitHubApiError } from "./github-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GitHubApiClient", () => {
  test("creates a user repository with the authenticated owner", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify({
        clone_url: "https://github.com/exampleUser/example.git",
        html_url: "https://github.com/exampleUser/example",
        private: true,
      }), { status: 201 });
    }) as typeof fetch;

    const client = new GitHubApiClient("ghp_secret");
    const repo = await client.createRepository({
      owner: "exampleUser",
      name: "example",
      private: true,
      authenticatedLogin: "exampleUser",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/user/repos");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "example",
      private: true,
      auto_init: false,
    });
    expect(repo.cloneUrl).toBe("https://github.com/exampleUser/example.git");
    expect(repo.htmlUrl).toBe("https://github.com/exampleUser/example");
  });

  test("creates an organization repository when owner differs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify({
        clone_url: "https://github.com/example-org/starter.git",
        html_url: "https://github.com/example-org/starter",
        private: true,
      }), { status: 201 });
    }) as typeof fetch;

    const client = new GitHubApiClient("ghp_secret");
    await client.createRepository({
      owner: "example-org",
      name: "starter",
      private: true,
      authenticatedLogin: "exampleUser",
    });

    expect(calls[0]?.url).toBe("https://api.github.com/orgs/example-org/repos");
  });

  test("applies main branch protection with PR review restrictions", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const client = new GitHubApiClient("ghp_secret");
    await client.protectBranch({
      owner: "exampleUser",
      repo: "example",
      branch: "main",
      actorLogin: "exampleUser",
      mode: "main",
    });

    expect(body?.required_pull_request_reviews).toEqual({
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 1,
    });
    expect(body?.required_conversation_resolution).toBe(true);
    expect(body?.restrictions).toEqual({ users: ["exampleUser"], teams: [], apps: [] });
    expect(body?.allow_force_pushes).toBe(false);
    expect(body?.allow_deletions).toBe(false);
  });

  test("throws GitHubApiError with GitHub validation details", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        message: "Validation Failed",
        errors: [{ resource: "Repository", field: "name", code: "already_exists" }],
      }), { status: 422 })) as typeof fetch;

    const client = new GitHubApiClient("ghp_secret");
    await expect(client.createRepository({
      owner: "exampleUser",
      name: "example",
      private: true,
      authenticatedLogin: "exampleUser",
    })).rejects.toThrow("Validation Failed: Repository name already_exists");
    await expect(client.createRepository({
      owner: "exampleUser",
      name: "example",
      private: true,
      authenticatedLogin: "exampleUser",
    })).rejects.toBeInstanceOf(GitHubApiError);
  });

  test("reads repository, branch, pull request, checks, status, and compare state", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      if (url.endsWith("/repos/exampleUser/example")) {
        return Response.json({
          name: "example",
          owner: { login: "exampleUser" },
          clone_url: "https://github.com/exampleUser/example.git",
          html_url: "https://github.com/exampleUser/example",
          private: false,
          default_branch: "main",
        });
      }
      if (url.endsWith("/repos/exampleUser/example/branches/main")) {
        return Response.json({ name: "main", protected: true, commit: { sha: "base123" } });
      }
      if (url.includes("/pulls?")) {
        expect(url).toContain("state=open");
        expect(url).toContain("base=main");
        return Response.json([
          {
            number: 42,
            title: "Add importer",
            state: "open",
            html_url: "https://github.com/exampleUser/example/pull/42",
            draft: false,
            mergeable: true,
            mergeable_state: "clean",
            base: { ref: "main" },
            head: { ref: "agent/importer", sha: "head123", repo: { full_name: "exampleUser/example" } },
            user: { login: "exampleAgent" },
          },
        ]);
      }
      if (url.endsWith("/pulls/42")) {
        return Response.json({
          number: 42,
          title: "Add importer",
          state: "open",
          html_url: "https://github.com/exampleUser/example/pull/42",
          base: { ref: "main" },
          head: { ref: "agent/importer", sha: "head123", repo: { full_name: "exampleUser/example" } },
        });
      }
      if (url.includes("/check-runs")) {
        return Response.json({
          total_count: 1,
          check_runs: [{ name: "test", status: "completed", conclusion: "success", html_url: "https://checks.example" }],
        });
      }
      if (url.endsWith("/commits/head123/status")) {
        return Response.json({
          state: "success",
          total_count: 1,
          statuses: [{ context: "ci", state: "success", target_url: "https://ci.example", description: "passed" }],
        });
      }
      if (url.endsWith("/compare/main...agent%2Fimporter")) {
        return Response.json({ status: "ahead", ahead_by: 2, behind_by: 0, total_commits: 2, html_url: "https://compare.example" });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    }) as typeof fetch;

    const client = new GitHubApiClient("ghp_secret");
    await expect(client.getRepository({ owner: "exampleUser", repo: "example" })).resolves.toMatchObject({
      owner: "exampleUser",
      name: "example",
      defaultBranch: "main",
    });
    await expect(client.getBranch({ owner: "exampleUser", repo: "example", branch: "main" })).resolves.toEqual({
      name: "main",
      protected: true,
      sha: "base123",
    });
    await expect(client.listPullRequests({ owner: "exampleUser", repo: "example", base: "main" })).resolves.toEqual([
      expect.objectContaining({
        number: 42,
        baseBranch: "main",
        headBranch: "agent/importer",
        headSha: "head123",
        mergeable: true,
      }),
    ]);
    await expect(client.getPullRequest({ owner: "exampleUser", repo: "example", number: 42 })).resolves.toMatchObject({ number: 42, headSha: "head123" });
    await expect(client.getPullRequestChecks({ owner: "exampleUser", repo: "example", ref: "head123" })).resolves.toEqual({
      totalCount: 1,
      checkRuns: [{ name: "test", status: "completed", conclusion: "success", htmlUrl: "https://checks.example" }],
    });
    await expect(client.getCombinedStatus({ owner: "exampleUser", repo: "example", ref: "head123" })).resolves.toMatchObject({
      state: "success",
      totalCount: 1,
    });
    await expect(client.getCompare({ owner: "exampleUser", repo: "example", base: "main", head: "agent/importer" })).resolves.toEqual({
      status: "ahead",
      aheadBy: 2,
      behindBy: 0,
      totalCommits: 2,
      htmlUrl: "https://compare.example",
    });

    expect(calls.map((call) => call.init?.method)).toEqual(["GET", "GET", "GET", "GET", "GET", "GET", "GET"]);
  });

  test("merges pull requests and updates branch refs with explicit payloads", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      if (url.endsWith("/pulls/42/merge")) {
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({
          sha: "head123",
          merge_method: "squash",
          commit_title: "Merge PR 42",
        });
        return Response.json({ merged: true, sha: "merge123", message: "Pull Request successfully merged" });
      }
      if (url.endsWith("/git/refs/heads/deployed")) {
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({ sha: "merge123", force: false });
        return Response.json({ ref: "refs/heads/deployed", object: { sha: "merge123" } });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    }) as typeof fetch;

    const client = new GitHubApiClient("ghp_secret");
    await expect(client.mergePullRequest({
      owner: "exampleUser",
      repo: "example",
      number: 42,
      sha: "head123",
      mergeMethod: "squash",
      commitTitle: "Merge PR 42",
    })).resolves.toEqual({
      merged: true,
      sha: "merge123",
      message: "Pull Request successfully merged",
    });
    await expect(client.updateBranchRef({
      owner: "exampleUser",
      repo: "example",
      branch: "deployed",
      sha: "merge123",
    })).resolves.toEqual({ ref: "refs/heads/deployed", sha: "merge123" });

    expect(calls).toHaveLength(2);
  });
});

import { describe, expect, test } from "bun:test";

import {
  checksArePassing,
  parseGitHubPullRequestUrl,
  resolveWorkroomAppTarget,
  runWorkroomIntegrationLoop,
} from "./integration-loop";

describe("workroom integration loop", () => {
  test("parses GitHub pull request URLs", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/exampleUser/example/pull/42")).toEqual({
      owner: "exampleUser",
      repo: "example",
      number: 42,
      url: "https://github.com/exampleUser/example/pull/42",
    });
    expect(parseGitHubPullRequestUrl("https://example.com/exampleUser/example/pull/42")).toBeNull();
  });

  test("resolves simple and rich workroom app targets", () => {
    expect(resolveWorkroomAppTarget({
      app_targets: {
        preview: "preview-app",
        production: {
          app_id: "prod-app",
          url: "https://prod.example",
          caprover_name: "prod-captain",
        },
      },
    }, "preview")).toMatchObject({ targetName: "preview", appId: "preview-app" });
    expect(resolveWorkroomAppTarget({
      app_targets: {
        production: {
          app_id: "prod-app",
          url: "https://prod.example",
          caprover_name: "prod-captain",
        },
      },
    }, "production")).toMatchObject({
      targetName: "production",
      appId: "prod-app",
      url: "https://prod.example",
      caproverName: "prod-captain",
    });
    expect(resolveWorkroomAppTarget({ app_targets: { preview: "https://preview.example" } }, "preview")).toMatchObject({
      appId: null,
      url: "https://preview.example",
    });
  });

  test("summarizes pr_ready events in dry-run mode without writing", async () => {
    const writes: unknown[] = [];
    const flightDeck = makeFlightDeck({
      appendWorkroomEvent: async (...args: unknown[]) => {
        writes.push(args);
        return {};
      },
    });
    const github = makeGithub();

    const result = await runWorkroomIntegrationLoop({
      flightDeck,
      github,
      options: {
        workspaceId: "workspace-1",
        workroomId: "room-1",
        dryRun: true,
        now: () => "2026-07-16T12:00:00.000Z",
      },
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        type: "pr_status",
        status: "planned",
        target: "https://github.com/exampleUser/example/pull/42",
      }),
    ]);
    expect(result.actions[0]?.detail).toMatchObject({
      source: "autopilot_github_integration",
      head_sha: "head123",
      combined_status: { state: "success" },
    });
    expect(writes).toEqual([]);
  });

  test("writes PR freshness events and links in live mode", async () => {
    const events: unknown[] = [];
    const links: unknown[] = [];
    const flightDeck = makeFlightDeck({
      appendWorkroomEvent: async (_workspaceId: string, _workroomId: string, input: unknown) => {
        events.push(input);
        return { event: { id: `event-${events.length}` } };
      },
      appendWorkroomLink: async (_workspaceId: string, _workroomId: string, input: unknown) => {
        links.push(input);
        return { link: { id: `link-${links.length}` } };
      },
    });

    const result = await runWorkroomIntegrationLoop({
      flightDeck,
      github: makeGithub(),
      options: {
        workspaceId: "workspace-1",
        workroomId: "room-1",
        dryRun: false,
        now: () => "2026-07-16T12:00:00.000Z",
      },
    });

    expect(result.actions[0]?.status).toBe("done");
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "pr_ready",
        targetType: "pull_request",
        targetRef: "https://github.com/exampleUser/example/pull/42",
      }),
    ]);
    expect(links).toEqual([
      expect.objectContaining({
        linkType: "pull_request",
        status: "ready",
      }),
    ]);
  });

  test("blocks merge when checks are failing", async () => {
    const result = await runWorkroomIntegrationLoop({
      flightDeck: makeFlightDeck(),
      github: makeGithub({
        getCombinedStatus: async () => ({ state: "failure", totalCount: 1, statuses: [] }),
      }),
      options: {
        workspaceId: "workspace-1",
        workroomId: "room-1",
        dryRun: false,
        merge: true,
      },
    });

    expect(result.actions).toContainEqual(expect.objectContaining({
      type: "merge_pr",
      status: "blocked",
      target: "https://github.com/exampleUser/example/pull/42",
    }));
  });

  test("checks production approval before updating the production branch", async () => {
    const checks: unknown[] = [];
    const updates: unknown[] = [];
    const events: unknown[] = [];
    const result = await runWorkroomIntegrationLoop({
      flightDeck: makeFlightDeck({
        checkProductionMergeApproval: async (_workspaceId: string, _workroomId: string, input: unknown) => {
          checks.push(input);
          return { approved: true };
        },
        appendWorkroomEvent: async (_workspaceId: string, _workroomId: string, input: unknown) => {
          events.push(input);
          return {};
        },
      }),
      github: makeGithub({
        updateBranchRef: async (input: unknown) => {
          updates.push(input);
          return { ref: "refs/heads/deployed", sha: "merge123" };
        },
      }),
      options: {
        workspaceId: "workspace-1",
        workroomId: "room-1",
        dryRun: false,
        updateProduction: true,
        productionCommit: "merge123",
      },
    });

    expect(checks).toEqual([{ repo: "exampleUser/example", toBranch: "deployed", commit: "merge123" }]);
    expect(updates).toEqual([expect.objectContaining({ branch: "deployed", sha: "merge123", force: false })]);
    expect(events).toContainEqual(expect.objectContaining({ eventType: "deploy_complete" }));
    expect(result.actions).toContainEqual(expect.objectContaining({ type: "update_production_branch", status: "done" }));
  });

  test("runs requested app target actions and records deploy events", async () => {
    const appActions: unknown[] = [];
    const caproverDeploys: unknown[] = [];
    const events: unknown[] = [];

    const result = await runWorkroomIntegrationLoop({
      flightDeck: makeFlightDeck({
        appendWorkroomEvent: async (_workspaceId: string, _workroomId: string, input: unknown) => {
          events.push(input);
          return {};
        },
      }),
      appControl: {
        runAppAction: async (appId, action) => {
          appActions.push({ appId, action });
          return { app: { id: appId, running: true } };
        },
        deployToCaprover: async (appId, input) => {
          caproverDeploys.push({ appId, input });
          return { liveUrl: "https://prod.example", deployedVersion: 7 };
        },
      },
      github: makeGithub(),
      options: {
        workspaceId: "workspace-1",
        workroomId: "room-1",
        dryRun: false,
        appTarget: "production",
        appAction: "restart",
        deployCaprover: true,
      },
    });

    expect(appActions).toEqual([{ appId: "prod-app", action: "restart" }]);
    expect(caproverDeploys).toEqual([{ appId: "prod-app", input: { caproverName: "prod-captain" } }]);
    expect(events).toContainEqual(expect.objectContaining({ eventType: "deploy_started", targetRef: "prod-app" }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: "deploy_complete", targetRef: "prod-app" }));
    expect(result.actions).toContainEqual(expect.objectContaining({ type: "app_target", status: "done", target: "prod-app" }));
  });

  test("blocks app target actions when only a URL is configured", async () => {
    const result = await runWorkroomIntegrationLoop({
      flightDeck: makeFlightDeck({
        showWorkroom: async () => ({
          workroom: {
            id: "room-1",
            repo: { owner: "exampleUser", name: "example" },
            branches: { integration: "main", production: "deployed" },
            app_targets: { preview: "https://preview.example" },
          },
          events: [],
        }),
      }),
      github: makeGithub(),
      options: {
        workspaceId: "workspace-1",
        workroomId: "room-1",
        dryRun: false,
        appTarget: "preview",
        appAction: "restart",
      },
    });

    expect(result.actions).toContainEqual(expect.objectContaining({
      type: "app_target",
      status: "blocked",
      target: "preview",
    }));
  });

  test("treats non-success checks as not passing", () => {
    expect(checksArePassing({
      totalCount: 1,
      checkRuns: [{ name: "test", status: "completed", conclusion: "success", htmlUrl: null }],
    }, {
      state: "success",
      totalCount: 1,
      statuses: [],
    })).toBe(true);
    expect(checksArePassing({
      totalCount: 1,
      checkRuns: [{ name: "test", status: "completed", conclusion: "failure", htmlUrl: null }],
    }, {
      state: "success",
      totalCount: 1,
      statuses: [],
    })).toBe(false);
  });
});

function makeFlightDeck(overrides: Partial<{
  showWorkroom: (...args: any[]) => Promise<Record<string, unknown>>;
  appendWorkroomEvent: (...args: any[]) => Promise<Record<string, unknown>>;
  appendWorkroomLink: (...args: any[]) => Promise<Record<string, unknown>>;
  checkProductionMergeApproval: (...args: any[]) => Promise<Record<string, unknown>>;
}> = {}) {
  return {
    showWorkroom: async () => ({
      workroom: {
        id: "room-1",
        repo: { owner: "exampleUser", name: "example" },
        branches: { integration: "main", production: "deployed" },
        app_targets: {
          preview: "preview-app",
          production: {
            app_id: "prod-app",
            url: "https://prod.example",
            caprover_name: "prod-captain",
          },
        },
      },
      events: [{
        id: "event-1",
        event_type: "pr_ready",
        target_ref: "https://github.com/exampleUser/example/pull/42",
        payload: {
          task_id: "task-1",
          preview_url: "https://preview.example",
        },
      }],
    }),
    appendWorkroomEvent: async () => ({}),
    appendWorkroomLink: async () => ({}),
    checkProductionMergeApproval: async () => ({ approved: true }),
    ...overrides,
  };
}

function makeGithub(overrides: Partial<Record<string, (...args: any[]) => Promise<any>>> = {}) {
  return {
    getPullRequest: async () => ({
      number: 42,
      title: "Add importer",
      state: "open",
      htmlUrl: "https://github.com/exampleUser/example/pull/42",
      draft: false,
      mergeable: true,
      mergeableState: "clean",
      baseBranch: "main",
      headBranch: "agent/importer",
      headSha: "head123",
      headRepoFullName: "exampleUser/example",
      userLogin: "exampleAgent",
    }),
    getPullRequestChecks: async () => ({
      totalCount: 1,
      checkRuns: [{ name: "test", status: "completed", conclusion: "success", htmlUrl: "https://checks.example" }],
    }),
    getCombinedStatus: async () => ({
      state: "success",
      totalCount: 1,
      statuses: [{ context: "ci", state: "success", targetUrl: "https://ci.example", description: "passed" }],
    }),
    getCompare: async () => ({
      status: "ahead",
      aheadBy: 1,
      behindBy: 0,
      totalCommits: 1,
      htmlUrl: "https://compare.example",
    }),
    mergePullRequest: async () => ({ merged: true, sha: "merge123", message: "merged" }),
    updateBranchRef: async () => ({ ref: "refs/heads/deployed", sha: "merge123" }),
    ...overrides,
  };
}

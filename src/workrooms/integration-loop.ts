import type {
  GitHubApiClient,
  GitHubCombinedStatus,
  GitHubPullRequestChecks,
} from "../git/github-api";

type JsonRecord = Record<string, unknown>;

export type WorkroomIntegrationActionStatus = "planned" | "done" | "blocked" | "skipped";
export type WorkroomAppAction = "start" | "restart" | "build" | "setup";

export interface WorkroomIntegrationAction {
  type: string;
  status: WorkroomIntegrationActionStatus;
  target?: string;
  detail?: JsonRecord;
}

export interface WorkroomAppTarget {
  targetName: string;
  appId: string | null;
  url: string | null;
  caproverName: string | null;
  raw: unknown;
}

export interface WorkroomAppControlClient {
  runAppAction(appId: string, action: WorkroomAppAction): Promise<JsonRecord>;
  deployToCaprover(appId: string, input?: { caproverName?: string | null }): Promise<JsonRecord>;
}

export interface WorkroomFlightDeckClient {
  showWorkroom(workspaceId: string, workroomId: string, limit?: number): Promise<JsonRecord>;
  appendWorkroomEvent(workspaceId: string, workroomId: string, input: {
    eventType: string;
    title?: string | null;
    body?: string | null;
    targetType?: string | null;
    targetRef?: string | null;
    visibility?: string | null;
    payload?: JsonRecord | null;
  }): Promise<JsonRecord>;
  appendWorkroomLink(workspaceId: string, workroomId: string, input: {
    linkType: string;
    targetType: string;
    targetId?: string | null;
    externalUrl?: string | null;
    label?: string | null;
    status?: string | null;
    metadata?: JsonRecord | null;
  }): Promise<JsonRecord>;
  checkProductionMergeApproval(workspaceId: string, workroomId: string, input: {
    repo?: string | null;
    toBranch: string;
    commit: string;
  }): Promise<JsonRecord>;
}

export interface WorkroomIntegrationLoopOptions {
  workspaceId: string;
  workroomId: string;
  dryRun?: boolean;
  merge?: boolean;
  updateProduction?: boolean;
  productionCommit?: string | null;
  productionBranch?: string | null;
  mergeMethod?: "merge" | "squash" | "rebase";
  appTarget?: string | null;
  appAction?: WorkroomAppAction | null;
  deployCaprover?: boolean;
  caproverName?: string | null;
  now?: () => string;
}

export interface WorkroomIntegrationLoopResult {
  dryRun: boolean;
  workspaceId: string;
  workroomId: string;
  repo: { owner: string; name: string; fullName: string } | null;
  integrationBranch: string | null;
  productionBranch: string | null;
  actions: WorkroomIntegrationAction[];
}

export function parseGitHubPullRequestUrl(value: string | null | undefined): {
  owner: string;
  repo: string;
  number: number;
  url: string;
} | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull") return null;
  const number = Number(parts[3]);
  if (!Number.isInteger(number) || number < 1) return null;
  return { owner: parts[0]!, repo: parts[1]!, number, url: `https://github.com/${parts[0]}/${parts[1]}/pull/${number}` };
}

export function resolveWorkroomRepo(workroom: JsonRecord): { owner: string; name: string; fullName: string } | null {
  const repo = objectValue(workroom.repo);
  const owner = stringValue(repo.owner);
  const name = stringValue(repo.name);
  if (owner && name) return { owner, name, fullName: `${owner}/${name}` };
  const url = stringValue(repo.url) || stringValue(repo.htmlUrl) || stringValue(repo.html_url);
  if (url) {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
      if (parsed.hostname === "github.com" && parts[0] && parts[1]) {
        return { owner: parts[0], name: parts[1], fullName: `${parts[0]}/${parts[1]}` };
      }
    } catch {
      // Fall through to compact owner/name parsing.
    }
    const compact = url.replace(/^github\.com\//, "").replace(/\.git$/i, "");
    const [compactOwner, compactName] = compact.split("/");
    if (compactOwner && compactName) return { owner: compactOwner, name: compactName, fullName: `${compactOwner}/${compactName}` };
  }
  return null;
}

export function resolveWorkroomAppTarget(workroom: JsonRecord, targetName: string | null | undefined): WorkroomAppTarget | null {
  const name = stringValue(targetName) || "preview";
  const appTargets = objectValue(workroom.app_targets);
  const value = appTargets[name] ?? appTargets[`${name}_app_id`] ?? appTargets[`${name}AppId`];
  if (value === undefined || value === null) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) {
      return { targetName: name, appId: null, url: trimmed, caproverName: null, raw: value };
    }
    return { targetName: name, appId: trimmed, url: null, caproverName: null, raw: value };
  }

  const record = objectValue(value);
  const appId =
    stringValue(record.app_id)
    || stringValue(record.appId)
    || stringValue(record.id)
    || stringValue(record.app);
  const url =
    stringValue(record.url)
    || stringValue(record.live_url)
    || stringValue(record.liveUrl)
    || stringValue(record.subdomain_url)
    || stringValue(record.subdomainUrl);
  const caproverName = stringValue(record.caprover_name) || stringValue(record.caproverName);
  if (!appId && !url && !caproverName) return null;
  return { targetName: name, appId, url, caproverName, raw: value };
}

export function extractPrReadyRecords(events: unknown[]): Array<{ prUrl: string; taskId: string | null; previewUrl: string | null }> {
  return events
    .filter((event): event is JsonRecord => Boolean(event && typeof event === "object" && !Array.isArray(event)))
    .filter((event) => stringValue(event.event_type) === "pr_ready")
    .map((event) => {
      const payload = objectValue(event.payload);
      return {
        prUrl: stringValue(payload.pr_url) || stringValue(payload.prUrl) || stringValue(event.target_ref) || "",
        taskId: stringValue(payload.task_id) || stringValue(payload.taskId),
        previewUrl: stringValue(payload.preview_url) || stringValue(payload.previewUrl),
      };
    })
    .filter((record) => Boolean(record.prUrl));
}

export function checksArePassing(checks: GitHubPullRequestChecks, status: GitHubCombinedStatus): boolean {
  const failingCheck = checks.checkRuns.some((run) => (
    run.status !== "completed"
    || (run.conclusion !== null && !["success", "neutral", "skipped"].includes(run.conclusion))
  ));
  if (failingCheck) return false;
  if (status.totalCount > 0 && status.state !== "success") return false;
  return true;
}

export async function runWorkroomIntegrationLoop(input: {
  flightDeck: WorkroomFlightDeckClient;
  appControl?: WorkroomAppControlClient | null;
  github: Pick<GitHubApiClient, "getPullRequest" | "getPullRequestChecks" | "getCombinedStatus" | "getCompare" | "mergePullRequest" | "updateBranchRef">;
  options: WorkroomIntegrationLoopOptions;
}): Promise<WorkroomIntegrationLoopResult> {
  const dryRun = input.options.dryRun !== false;
  const observedAt = input.options.now?.() || new Date().toISOString();
  const roomResult = await input.flightDeck.showWorkroom(input.options.workspaceId, input.options.workroomId, 500);
  const workroom = objectValue(roomResult.workroom);
  const events = Array.isArray(roomResult.events) ? roomResult.events : [];
  const repo = resolveWorkroomRepo(workroom);
  const branches = objectValue(workroom.branches);
  const integrationBranch = stringValue(branches.integration) || "staging";
  const productionBranch = input.options.productionBranch || stringValue(branches.production) || "deployed";
  const actions: WorkroomIntegrationAction[] = [];

  if (!repo) {
    actions.push({ type: "room_config", status: "blocked", detail: { reason: "workroom repo is missing or not GitHub-compatible" } });
    return { dryRun, workspaceId: input.options.workspaceId, workroomId: input.options.workroomId, repo: null, integrationBranch, productionBranch, actions };
  }

  const prRecords = extractPrReadyRecords(events);
  if (prRecords.length === 0) {
    actions.push({ type: "pr_queue", status: "skipped", detail: { reason: "no pr_ready events found" } });
  }

  for (const record of prRecords) {
    const parsed = parseGitHubPullRequestUrl(record.prUrl);
    if (!parsed) {
      actions.push({ type: "pr_status", status: "blocked", target: record.prUrl, detail: { reason: "invalid GitHub PR URL" } });
      continue;
    }
    const pr = await input.github.getPullRequest({ owner: parsed.owner, repo: parsed.repo, number: parsed.number });
    const checks = await input.github.getPullRequestChecks({ owner: parsed.owner, repo: parsed.repo, ref: pr.headSha });
    const combinedStatus = await input.github.getCombinedStatus({ owner: parsed.owner, repo: parsed.repo, ref: pr.headSha });
    const compare = await input.github.getCompare({ owner: parsed.owner, repo: parsed.repo, base: pr.baseBranch || integrationBranch, head: pr.headBranch });
    const passing = checksArePassing(checks, combinedStatus);
    const payload = {
      source: "autopilot_github_integration",
      observed_at: observedAt,
      repo: `${parsed.owner}/${parsed.repo}`,
      pr_url: parsed.url,
      pr_number: parsed.number,
      base_branch: pr.baseBranch,
      head_branch: pr.headBranch,
      head_sha: pr.headSha,
      mergeable: pr.mergeable,
      mergeable_state: pr.mergeableState,
      checks,
      combined_status: combinedStatus,
      compare,
      task_id: record.taskId,
      preview_url: record.previewUrl,
    };
    actions.push({ type: "pr_status", status: dryRun ? "planned" : "done", target: parsed.url, detail: payload });
    if (!dryRun) {
      await input.flightDeck.appendWorkroomEvent(input.options.workspaceId, input.options.workroomId, {
        eventType: "pr_ready",
        title: `PR ${parsed.number} status refreshed`,
        targetType: "pull_request",
        targetRef: parsed.url,
        payload,
      });
      await input.flightDeck.appendWorkroomLink(input.options.workspaceId, input.options.workroomId, {
        linkType: "pull_request",
        targetType: "pull_request",
        externalUrl: parsed.url,
        label: `PR ${parsed.number}`,
        status: passing ? "ready" : "blocked",
        metadata: payload,
      });
    }

    if (!input.options.merge) continue;
    if (!passing || pr.mergeable === false || pr.draft) {
      actions.push({ type: "merge_pr", status: "blocked", target: parsed.url, detail: { passing, mergeable: pr.mergeable, draft: pr.draft } });
      continue;
    }
    actions.push({ type: "merge_pr", status: dryRun ? "planned" : "done", target: parsed.url, detail: { sha: pr.headSha, method: input.options.mergeMethod || "squash" } });
    if (!dryRun) {
      await input.flightDeck.appendWorkroomEvent(input.options.workspaceId, input.options.workroomId, {
        eventType: "merge_started",
        title: `Merging PR ${parsed.number}`,
        targetType: "pull_request",
        targetRef: parsed.url,
        payload,
      });
      const merged = await input.github.mergePullRequest({
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        sha: pr.headSha,
        mergeMethod: input.options.mergeMethod || "squash",
        commitTitle: `Merge PR ${parsed.number}: ${pr.title}`,
      });
      await input.flightDeck.appendWorkroomEvent(input.options.workspaceId, input.options.workroomId, {
        eventType: "merge_complete",
        title: `Merged PR ${parsed.number}`,
        targetType: "pull_request",
        targetRef: parsed.url,
        payload: { ...payload, merge_result: merged },
      });
    }
  }

  if (input.options.updateProduction) {
    const commit = stringValue(input.options.productionCommit);
    if (!commit) {
      actions.push({ type: "update_production_branch", status: "blocked", detail: { reason: "production commit is required" } });
    } else {
      const check = dryRun
        ? { approved: "not_checked_in_dry_run" }
        : await input.flightDeck.checkProductionMergeApproval(input.options.workspaceId, input.options.workroomId, {
          repo: repo.fullName,
          toBranch: productionBranch,
          commit,
        });
      actions.push({ type: "update_production_branch", status: dryRun ? "planned" : "done", target: productionBranch, detail: { commit, approval: check } });
      if (!dryRun) {
        const updated = await input.github.updateBranchRef({
          owner: repo.owner,
          repo: repo.name,
          branch: productionBranch,
          sha: commit,
          force: false,
        });
        await input.flightDeck.appendWorkroomEvent(input.options.workspaceId, input.options.workroomId, {
          eventType: "deploy_complete",
          title: `Production branch ${productionBranch} updated`,
          targetType: "deployment",
          targetRef: productionBranch,
          payload: {
            source: "autopilot_github_integration",
            observed_at: observedAt,
            target: "production",
            repo: repo.fullName,
            branch: productionBranch,
            commit,
            ref: updated.ref,
          },
        });
      }
    }
  }

  if (input.options.appAction || input.options.deployCaprover) {
    const targetName = input.options.appTarget || (input.options.updateProduction ? "production" : "preview");
    const target = resolveWorkroomAppTarget(workroom, targetName);
    if (!target) {
      actions.push({ type: "app_target", status: "blocked", target: targetName, detail: { reason: "workroom app target is missing" } });
    } else if (!target.appId) {
      actions.push({ type: "app_target", status: "blocked", target: targetName, detail: { reason: "app target does not include an Autopilot app id", target } });
    } else if (!input.appControl) {
      actions.push({ type: "app_target", status: "blocked", target: target.appId, detail: { reason: "app control client was not provided", target } });
    } else {
      const requested = {
        source: "autopilot_app_control",
        observed_at: observedAt,
        target_name: target.targetName,
        app_id: target.appId,
        app_action: input.options.appAction || null,
        deploy_caprover: Boolean(input.options.deployCaprover),
        caprover_name: input.options.caproverName || target.caproverName || null,
        url: target.url,
      };
      actions.push({ type: "app_target", status: dryRun ? "planned" : "done", target: target.appId, detail: requested });
      if (!dryRun) {
        await input.flightDeck.appendWorkroomEvent(input.options.workspaceId, input.options.workroomId, {
          eventType: "deploy_started",
          title: `Updating ${target.targetName} app target`,
          targetType: "app_target",
          targetRef: target.appId,
          payload: requested,
        });
        const actionResult = input.options.appAction
          ? await input.appControl.runAppAction(target.appId, input.options.appAction)
          : null;
        const deployResult = input.options.deployCaprover
          ? await input.appControl.deployToCaprover(target.appId, { caproverName: input.options.caproverName || target.caproverName })
          : null;
        await input.flightDeck.appendWorkroomEvent(input.options.workspaceId, input.options.workroomId, {
          eventType: "deploy_complete",
          title: `Updated ${target.targetName} app target`,
          targetType: "app_target",
          targetRef: target.appId,
          payload: {
            ...requested,
            action_result: actionResult,
            caprover_deploy_result: deployResult,
          },
        });
      }
    }
  }

  return {
    dryRun,
    workspaceId: input.options.workspaceId,
    workroomId: input.options.workroomId,
    repo,
    integrationBranch,
    productionBranch,
    actions,
  };
}

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

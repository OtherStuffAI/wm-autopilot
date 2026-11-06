/**
 * Scheduler API Handler
 *
 * HTTP handler for /api/scheduler/* routes.
 * Manages scheduled job CRUD, manual triggering, and run history.
 */

import { describeSchedulerRun } from "./run-outcome";
import type { ScheduledSessionContext } from "./session-context";
import { RELAY_TRIGGER_UNSUPPORTED_REASON, type SchedulerStore } from "./scheduler-store";
import type { SchedulerEngine } from "./scheduler-engine";
import { handleCreateJob, handleUpdateJob } from "./scheduler-job-routes";
import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";

// ============================================================
// Types
// ============================================================

export interface SchedulerApiDependencies {
  validateSessionContext?: (job: { userNpub: string; botNpub: string; flightdeckContext?: ScheduledSessionContext | null }) => void;
  listRunIdentities?: (ownerNpub: string) => Array<{ botNpub: string; name: string }>;
  isAdmin?: () => boolean;
  listAllJobs?: () => boolean;
  store: SchedulerStore;
  engine: SchedulerEngine;
  getNpub: (request: Request) => string | null;
  getInstanceIdentity?: () => WingmanInstanceIdentity | null;
  getActiveBotOwnerNpub?: (botNpub: string) => string | null;
  getAgentIdForBotNpub?: (botNpub: string, ownerNpub: string) => string | null;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ============================================================
// Helpers
// ============================================================

/** GET /api/scheduler/jobs */
function handleListJobs(
  deps: SchedulerApiDependencies,
  userNpub: string,
): Response {
  const jobs = deps.store.listJobs(deps.isAdmin?.() && (deps.listAllJobs?.() ?? true) ? undefined : userNpub);
  return Response.json({ jobs });
}

/** DELETE /api/scheduler/jobs/:id */
function handleDeleteJob(
  deps: SchedulerApiDependencies,
  userNpub: string,
  jobId: string,
): Response {
  const existing = deps.store.getJob(jobId);
  if (!existing || (existing.userNpub !== userNpub && !deps.isAdmin?.())) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }
  deps.engine.unscheduleJob(jobId);
  deps.store.deleteJob(jobId);

  return new Response(null, { status: 204 });
}

/** POST /api/scheduler/jobs/:id/trigger */
async function handleTriggerJob(
  deps: SchedulerApiDependencies,
  userNpub: string,
  jobId: string,
): Promise<Response> {
  const existing = deps.store.getJob(jobId);
  if (!existing || (existing.userNpub !== userNpub && !deps.isAdmin?.())) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }
  if (existing.triggerType === "unsupported") {
    return Response.json(
      { error: existing.unsupportedReason ?? "This scheduler trigger type is unsupported." },
      { status: 409 },
    );
  }

  try {
    const result = await deps.engine.executeJob(jobId);
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

/** GET /api/scheduler/jobs/:id/runs */
function handleListRuns(
  deps: SchedulerApiDependencies,
  userNpub: string,
  jobId: string,
): Response {
  const existing = deps.store.getJob(jobId);
  if (!existing || (existing.userNpub !== userNpub && !deps.isAdmin?.())) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  const runs = deps.store.getJobRuns(jobId);
  return Response.json({ runs: runs.map(run => ({ ...run, ...describeSchedulerRun(run) })) });
}

// ============================================================
// Main Handler Factory
// ============================================================

export function createSchedulerApiHandler(deps: SchedulerApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response> => {
    // Auth: resolve user npub
    const userNpub = deps.getNpub(request);
    if (!userNpub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments[0] = "api", segments[1] = "scheduler"

    if (url.pathname === "/api/scheduler/identities" && method === "GET") {
      if (!deps.listRunIdentities) return Response.json({ error: "Run as identity listing is unavailable" }, { status: 503 });
      return Response.json({ identities: deps.listRunIdentities(userNpub) });
    }

    // /api/scheduler/jobs
    if (segments.length === 3 && segments[2] === "jobs") {
      if (method === "GET") return handleListJobs(deps, userNpub);
      if (method === "POST") return handleCreateJob(deps, userNpub, request);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/scheduler/jobs/:id
    if (segments.length === 4 && segments[2] === "jobs") {
      const jobId = segments[3]!;
      if (method === "PATCH") return handleUpdateJob(deps, userNpub, jobId, request);
      if (method === "DELETE") return handleDeleteJob(deps, userNpub, jobId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/scheduler/jobs/:id/trigger
    if (segments.length === 5 && segments[2] === "jobs" && segments[4] === "trigger") {
      if (method === "POST") return handleTriggerJob(deps, userNpub, segments[3]!);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/scheduler/jobs/:id/runs
    if (segments.length === 5 && segments[2] === "jobs" && segments[4] === "runs") {
      if (method === "GET") return handleListRuns(deps, userNpub, segments[3]!);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  };
}

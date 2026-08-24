/**
 * Night Watch API Handler
 *
 * HTTP handler for /api/nightwatch/* routes.
 * Manages Night Watchman configuration, per-session toggles, and report cards.
 */

import type { NightWatchStore } from "./nightwatch-store";
import {
  NIGHTWATCH_CHECK_IN_PROMPT,
  NIGHTWATCH_DEFAULT_INTERVAL_MINUTES,
  NIGHTWATCH_MODELS,
  NIGHTWATCH_MAX_CYCLE_OPTIONS,
  NIGHTWATCH_DEFAULT_MODEL,
  NIGHTWATCH_DEFAULT_PROMPT,
  NIGHTWATCH_MAX_INTERVAL_MINUTES,
  NIGHTWATCH_MIN_INTERVAL_MINUTES,
} from "./nightwatch-engine";

// ============================================================
// Types
// ============================================================

export interface NightWatchApiDependencies {
  store: NightWatchStore;
  featureFlagStore: {
    getFlag(key: string): { state: string } | null;
  };
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ============================================================
// Helpers
// ============================================================

function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  return request.json().catch(() => {
    throw new Error("Invalid JSON payload");
  }) as Promise<Record<string, unknown>>;
}

// ============================================================
// Route Handlers
// ============================================================

/** GET /api/nightwatch/config */
function handleGetConfig(deps: NightWatchApiDependencies): Response {
  const allConfig = deps.store.getAllConfig();
  return Response.json({
    intervalMinutes: NIGHTWATCH_DEFAULT_INTERVAL_MINUTES,
    minIntervalMinutes: NIGHTWATCH_MIN_INTERVAL_MINUTES,
    maxIntervalMinutes: NIGHTWATCH_MAX_INTERVAL_MINUTES,
    prompt: NIGHTWATCH_CHECK_IN_PROMPT,
    maxCycles: Number(allConfig.default_max_cycles ?? "21"),
    maxCycleOptions: [...NIGHTWATCH_MAX_CYCLE_OPTIONS],
    // Legacy fields kept for compatibility with any stale clients.
    models: [...NIGHTWATCH_MODELS],
    model: allConfig.default_model ?? NIGHTWATCH_DEFAULT_MODEL,
    defaultPrompt: NIGHTWATCH_DEFAULT_PROMPT,
  });
}

/** PATCH /api/nightwatch/config */
async function handleUpdateConfig(
  deps: NightWatchApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseJsonBody(request);

  if (typeof body.model === "string" && body.model.trim()) {
    deps.store.setConfig("default_model", body.model.trim());
  }
  if (body.maxCycles !== undefined) {
    const maxCycles = Number(body.maxCycles);
    if (Number.isFinite(maxCycles) && maxCycles > 0) {
      deps.store.setConfig("default_max_cycles", String(Math.trunc(maxCycles)));
    }
  }

  return handleGetConfig(deps);
}

/** GET /api/nightwatch/sessions/:id */
function handleGetSession(
  deps: NightWatchApiDependencies,
  sessionId: string,
): Response {
  const sessionState = deps.store.getSessionState(sessionId);
  if (!sessionState) {
    return Response.json({
      sessionId,
      enabled: false,
      cycleCount: 0,
      maxCycles: 21,
      model: NIGHTWATCH_DEFAULT_MODEL,
      prompt: NIGHTWATCH_CHECK_IN_PROMPT,
      intervalMinutes: NIGHTWATCH_DEFAULT_INTERVAL_MINUTES,
      promptAt: null,
    });
  }
  return Response.json(sessionState);
}

/** POST /api/nightwatch/sessions/:id/enable */
async function handleEnableSession(
  deps: NightWatchApiDependencies,
  sessionId: string,
  request: Request,
): Promise<Response> {
  let opts: { model?: string; maxCycles?: number; prompt?: string; intervalMinutes?: number } | undefined;

  try {
    const body = await parseJsonBody(request);
    opts = {};
    if (typeof body.model === "string" && body.model.trim()) {
      opts.model = body.model.trim();
    }
    if (body.maxCycles !== undefined) {
      const maxCycles = Number(body.maxCycles);
      if (Number.isFinite(maxCycles) && maxCycles > 0) {
        opts.maxCycles = Math.trunc(maxCycles);
      }
    }
    if (typeof body.prompt === "string" && body.prompt.trim()) {
      opts.prompt = body.prompt.trim();
    }
    if (body.intervalMinutes !== undefined) {
      const intervalMinutes = Number(body.intervalMinutes);
      if (Number.isFinite(intervalMinutes)) {
        opts.intervalMinutes = Math.trunc(intervalMinutes);
      }
    }
  } catch {
    // No body or invalid JSON — use defaults
  }

  const result = deps.store.enableSession(sessionId, opts);
  return Response.json(result);
}

/** POST /api/nightwatch/sessions/:id/disable */
function handleDisableSession(
  deps: NightWatchApiDependencies,
  sessionId: string,
): Response {
  deps.store.disableSession(sessionId);
  return Response.json({ sessionId, enabled: false });
}

/** GET /api/nightwatch/reports */
function handleListReports(deps: NightWatchApiDependencies): Response {
  const reports = deps.store.listReports();
  return Response.json({ reports });
}

/** DELETE /api/nightwatch/reports/:id */
function handleDeleteReport(
  deps: NightWatchApiDependencies,
  reportId: string,
): Response {
  const deleted = deps.store.deleteReport(reportId);
  if (!deleted) {
    return Response.json({ error: "Report not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}

// ============================================================
// Main Handler Factory
// ============================================================

export function createNightWatchApiHandler(deps: NightWatchApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response> => {
    const segments = url.pathname.split("/").filter(Boolean);
    // segments[0] = "api", segments[1] = "nightwatch"

    // /api/nightwatch/config
    if (segments.length === 3 && segments[2] === "config") {
      if (method === "GET") return handleGetConfig(deps);
      if (method === "PATCH") return handleUpdateConfig(deps, request);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/nightwatch/sessions/:id
    if (segments.length === 4 && segments[2] === "sessions") {
      const sessionId = segments[3]!;
      if (method === "GET") return handleGetSession(deps, sessionId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/nightwatch/sessions/:id/enable
    if (segments.length === 5 && segments[2] === "sessions" && segments[4] === "enable") {
      if (method === "POST") return handleEnableSession(deps, segments[3]!, request);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/nightwatch/sessions/:id/disable
    if (segments.length === 5 && segments[2] === "sessions" && segments[4] === "disable") {
      if (method === "POST") return handleDisableSession(deps, segments[3]!);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/nightwatch/reports
    if (segments.length === 3 && segments[2] === "reports") {
      if (method === "GET") return handleListReports(deps);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/nightwatch/reports/:id
    if (segments.length === 4 && segments[2] === "reports") {
      const reportId = segments[3]!;
      if (method === "DELETE") return handleDeleteReport(deps, reportId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  };
}

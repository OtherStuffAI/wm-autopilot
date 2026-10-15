import { unfinishedFamilies } from "./record-family-compatibility.ts";
import { join } from "node:path";
import {
  capabilityClientContextFromEnv,
  readCapabilityIdentity,
  type CapabilityClientContext,
} from "../mcp/capability-client.ts";
import {
  RecordSyncClient,
  RecordSyncHttpError,
  RecordSyncBudgetError,
} from "./record-sync-client.ts";
import { RecordSyncCache, cachePath, type Fence } from "./record-sync-cache.ts";
import {
  PAGE_MS,
  page,
  record,
  registration,
  type JsonRecord,
} from "./record-sync-protocol.ts";
export { record } from "./record-sync-protocol.ts";

export interface HeartbeatWakeOptions {
  hours: number;
  reviewCursor?: string;
  reviewOnly?: boolean;
  syncOnly?: boolean;
  workspaceId?: string;
  towerUrl?: string;
  appNpub?: string;
  maxPages?: number;
  maxTimeMs?: number;
  requestTimeoutMs?: number;
  context?: CapabilityClientContext;
  fetchImpl?: typeof fetch;
  cacheRoot?: string;
  signal?: AbortSignal;
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive finite integer`);
  return value;
}
function fence(cache: RecordSyncCache): Fence {
  const s = cache.state();
  return { cursor: s.cursor, clientId: s.clientId, generation: s.generation };
}
const REPAIR_ERRORS = new Set([
  "reset_required",
  "history_pruned",
  "client_expired",
  "client_not_registered",
  "page_token_invalid",
]);

export async function runHeartbeatWake(options: HeartbeatWakeOptions) {
  if (options.reviewOnly && options.syncOnly)
    throw new Error("reviewOnly and syncOnly are mutually exclusive");
  if (options.reviewCursor && !options.reviewOnly)
    throw new Error(
      "Review continuation requires reviewOnly to pin the checkpoint",
    );
  const start = Date.now();
  const maxPages = positive(options.maxPages ?? 100, "maxPages");
  const wakeMs = Math.min(
    positive(options.maxTimeMs ?? 120_000, "maxTimeMs"),
    120_000,
  );
  const timeoutMs = Math.min(
    positive(options.requestTimeoutMs ?? PAGE_MS, "requestTimeoutMs"),
    PAGE_MS,
  );
  if (
    !Number.isFinite(options.hours) ||
    options.hours <= 0 ||
    options.hours > 168
  )
    throw new Error("hours must be between 0 and 168");
  const baseContext = options.context ?? capabilityClientContextFromEnv();
  const context = {
    ...baseContext,
    fetch: options.fetchImpl ?? baseContext.fetch ?? fetch,
  };
  const bootstrap = new RecordSyncClient(
    context,
    start + wakeMs,
    false,
    "",
    timeoutMs,
    options.signal,
  );
  const active = record(
    await bootstrap.broker<JsonRecord>("/api/mcp/wingman/flightdeck", {
      action: "context",
    }),
  );
  const workspace = record(active.workspace);
  const bound = Boolean(workspace.workspaceId);
  const workspaceId =
    options.workspaceId?.trim() || String(workspace.workspaceId ?? "");
  const towerUrl = String(
    bound ? (workspace.backendBaseUrl ?? "") : (options.towerUrl ?? ""),
  )
    .trim()
    .replace(/\/$/, "");
  const appNpub = String(
    bound ? (workspace.sourceAppNpub ?? "") : (options.appNpub ?? ""),
  ).trim();
  if (!workspaceId || !towerUrl || !appNpub)
    throw new Error(
      "Explicit --workspace, --tower-url and --app-npub or complete broker workspace context required",
    );
  if (
    (bound && workspaceId !== workspace.workspaceId) ||
    (options.towerUrl && options.towerUrl.replace(/\/$/, "") !== towerUrl) ||
    (options.appNpub && options.appNpub !== appNpub)
  )
    throw new Error(
      "Workspace/Tower/app override differs from authoritative broker context",
    );
  const identity = await readCapabilityIdentity(bootstrap.context);
  if (!identity.botNpub || identity.identityType !== "agent")
    throw new Error("Missing broker agent identity");
  const client = new RecordSyncClient(
    context,
    start + wakeMs,
    bound,
    appNpub,
    timeoutMs,
    options.signal,
  );
  const root =
    options.cacheRoot ??
    process.env.WINGMAN_HEARTBEAT_CACHE_DIR ??
    join(import.meta.dir, "../../data/heartbeat-record-sync");
  const partition = [towerUrl, workspaceId, appNpub, identity.botNpub];
  const path = cachePath(root, partition);
  const cache = new RecordSyncCache(path, partition, wakeMs + PAGE_MS);
  const errors: string[] = [];
  let budgetDeferred = false;
  let pages = 0;
  let terminal = false;
  let negotiated = false;
  let bounded = false;
  const pageTimings: { totalMs: number; commitMs: number; ackMs: number }[] =
    [];
  const base = `${towerUrl}/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/record-sync`;
  const clientUrl = () =>
    `${base}/clients/${cache.state().clientId}?protocol_version=2`;
  const acknowledge = async () => {
    const intent = cache.pending();
    if (!intent) return;
    try {
      const value = await client.request(
        `${base}/clients/${intent.clientId}/ack?protocol_version=2`,
        "POST",
        JSON.stringify({
          cursor: intent.cursor,
          expected_revision: intent.expected_revision,
        }),
        "ack",
      );
      cache.ack(registration(value, intent.clientId), intent);
    } catch (error) {
      if (
        error instanceof RecordSyncHttpError &&
        ["checkpoint_conflict", "checkpoint_regression"].includes(error.code)
      ) {
        const r = registration(
          await client.request(clientUrl(), "GET", undefined, "checkpoint"),
          intent.clientId,
        );
        if (r.checkpoint_cursor === intent.cursor) cache.ack(r, intent);
        else cache.replayConflict(r, intent);
      } else throw error;
    }
  };
  try {
    if (!options.reviewOnly) {
      // A failed wake cannot reuse previously certified observations as current authority.
      cache.unavailable();
      const service = await client.request(
        `${towerUrl}/api/v4/flightdeck-pg/service`,
        "GET",
        undefined,
        "discovery",
      );
      const capability = record(service.record_sync);
      if (
        !Array.isArray(capability.protocol_versions) ||
        !capability.protocol_versions.includes(2) ||
        capability.device_checkpoints !== true ||
        capability.additive_access !== true ||
        capability.retention_policy !== "retain_downloaded"
      )
        throw new Error(
          "Tower does not advertise required record-sync v2/access capabilities; no legacy downgrade",
        );
      negotiated = true;
      bounded =
        Array.isArray(capability.extensions) &&
        capability.extensions.includes("bounded_snapshot_v1");
      const f = fence(cache);
      const r = registration(
        await client.request(clientUrl(), "POST", "", "register"),
        f.clientId,
      );
      cache.register(r, f);
      await acknowledge();
      for (; pages < maxPages; ) {
        if (client.remaining() < PAGE_MS)
          throw new RecordSyncBudgetError(
            "Wake time budget exhausted; durable progress retained",
          );
        const started = performance.now();
        const expected = fence(cache);
        const url = new URL(base);
        url.searchParams.set("protocol_version", "2");
        url.searchParams.set("client_id", expected.clientId);
        url.searchParams.set("cursor", expected.cursor!);
        url.searchParams.set("limit", "200");
        if (bounded) url.searchParams.set("extension", "bounded_snapshot_v1");
        const payload = page(
          await client.request(url.toString(), "GET", undefined, "page"),
          expected.clientId,
          workspaceId,
        );
        const received = performance.now();
        cache.commit(payload, expected, bounded);
        pages++;
        const committed = performance.now();
        await acknowledge();
        pageTimings.push({
          totalMs: performance.now() - started,
          commitMs: committed - received,
          ackMs: performance.now() - committed,
        });
        if (cache.state().handoverDone && !cache.pending()) {
          terminal = true;
          break;
        }
      }
      if (!terminal) {
        budgetDeferred = true;
        errors.push("Page budget exhausted; durable progress retained");
      }
      // Unextended v2 remains convergent polling; only Tower's negotiated certificate closes a finite review.
      if (terminal && !bounded)
        errors.push(
          "Fixed handover boundary is not negotiated; convergence certification unavailable",
        );
    }
  } catch (error) {
    budgetDeferred = error instanceof RecordSyncBudgetError;
    if (error instanceof RecordSyncHttpError && REPAIR_ERRORS.has(error.code)) {
      cache.repair();
      errors.push(
        `${error.message}; retained downloads/pending intent; fresh cache ID will bootstrap next wake`,
      );
    } else {
      if (
        error instanceof RecordSyncHttpError &&
        (error.status === 401 || error.status === 403)
      )
        cache.unavailable();
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const state = cache.state();
    const since = new Date(start - options.hours * 3_600_000).toISOString();
    const unfinished = unfinishedFamilies(state);
    if (state.handoverDone && unfinished.length)
      errors.push(`Snapshot coverage unavailable for advertised families: ${unfinished.join(", ")}`);
    const syncComplete =
      state.certified &&
      state.available &&
      state.handoverDone &&
      !cache.pending() &&
      !errors.length;
    const review = options.syncOnly
      ? {
          rows: [],
          truncated: false,
          ...cache.authority(),
          nextCursor: null,
          total: 0,
          delivered: 0,
          since,
        }
      : cache.review(since, 262_144, 200, options.reviewCursor);
    if (review.unavailable)
      errors.push("Current evidence includes unavailable authority partitions");
    return {
      generatedAt: new Date().toISOString(),
      since: review.since,
      recentTriageHours: options.reviewCursor ? null : options.hours,
      botNpub: identity.botNpub,
      brokerRequests: bootstrap.brokerRequests + client.brokerRequests + 1,
      syncComplete,
      syncOutcome: syncComplete
        ? ("certified" as const)
        : budgetDeferred
          ? ("budget" as const)
          : ("blocked" as const),
      complete:
        syncComplete &&
        !options.syncOnly &&
        !review.truncated &&
        !review.unavailable,
      review: {
        started: !options.syncOnly,
        complete:
          syncComplete &&
          !options.syncOnly &&
          !review.truncated &&
          !review.unavailable,
        nextCursor: review.nextCursor,
        since: review.since,
        total: review.total,
        delivered: review.delivered,
        syncCertified: syncComplete,
        semantics:
          "Delivered summaries require inspection; excerpts are not full histories",
      },
      errors,
      coverage: {
        protocolVersion:
          negotiated || (options.reviewOnly && state.cursor) ? 2 : null,
        observation: options.reviewOnly ? "pinned-cache-review" : "live-sync",
        pages,
        snapshotComplete: state.snapshotDone,
        deltaHandoverObserved: state.handoverDone,
        certifiedBoundary: syncComplete,
        handoverTarget: state.target,
        handoverThrough: state.through,
        advertisedFamilies: state.families,
        completedFamilies: state.partitions,
        unfinishedFamilies: unfinished,
        outsideCoverage: ["directory", "approvals", "graph", "wapp_activity"],
        unavailablePartitions: review.unavailable,
        deletedPartitions: review.deletedPartitions,
        downloadedCounts: cache.counts(),
        reviewTruncated: review.truncated,
      },
      cache: {
        path,
        clientId: state.clientId,
        generation: state.generation,
        pendingAck: Boolean(cache.pending()),
        resumable: Boolean(state.cursor),
      },
      timings: {
        transfers: client.timings,
        pages: pageTimings,
        wakeMs: Date.now() - start,
      },
      workspaces: [
        {
          id: workspaceId,
          label: workspace.label ?? null,
          review: review.rows,
        },
      ],
    };
  } finally {
    cache.close();
  }
}

import {
  runHeartbeatWake,
  type HeartbeatWakeOptions,
} from "./heartbeat-wake.ts";
import { CapabilityRateLimitError } from "../mcp/capability-client.ts";
import { waitForRecordSyncRetry } from "./record-sync-retry.ts";

export type HeartbeatWakeResult = Awaited<ReturnType<typeof runHeartbeatWake>>;

/** Dedicated bootstrap work; summaries and their truncation never drive sync retries. */
export async function runHeartbeatCatchUp(
  options: HeartbeatWakeOptions,
  maxWakes = 100,
  onWake: (
    result: HeartbeatWakeResult,
    wake: number,
  ) => void | Promise<void> = () => {},
  wake: typeof runHeartbeatWake = runHeartbeatWake,
  wait: typeof waitForRecordSyncRetry = waitForRecordSyncRetry,
) {
  if (!Number.isSafeInteger(maxWakes) || maxWakes < 1)
    throw new Error("maxWakes must be a positive integer");
  if (options.reviewCursor || options.reviewOnly)
    throw new Error("Catch-up cannot consume review continuation");
  for (let n = 1; n <= maxWakes; n++) {
    options.signal?.throwIfAborted();
    let result: HeartbeatWakeResult;
    try { result = await wake({ ...options, syncOnly: true }); }
    catch (error) {
      if (!(error instanceof CapabilityRateLimitError) || n === maxWakes) throw error;
      await wait(Math.max(1, error.retryAfterMs), options.signal);
      continue;
    }
    await onWake(result, n);
    if (result.syncComplete)
      return { outcome: "certified" as const, wakes: n, result };
    if (result.syncOutcome === "retry") {
      if (n === maxWakes) return { outcome: "wake_limit" as const, wakes: n, result };
      await wait(result.retryAfterMs, options.signal);
      continue;
    }
    if (result.syncOutcome !== "budget")
      return { outcome: "blocked" as const, wakes: n, result };
    if (!result.coverage.pages && !result.coverage.downloadedChunks)
      return {
        outcome: "blocked" as const,
        wakes: n,
        result,
        blocker:
          "No page progress within the wake budget; inspect deadline/Retry-After before retrying",
      };
    if (n === maxWakes)
      return { outcome: "wake_limit" as const, wakes: n, result };
  }
  throw new Error("Unreachable catch-up state");
}

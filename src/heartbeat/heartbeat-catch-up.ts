import {
  runHeartbeatWake,
  type HeartbeatWakeOptions,
} from "./heartbeat-wake.ts";

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
) {
  if (!Number.isSafeInteger(maxWakes) || maxWakes < 1)
    throw new Error("maxWakes must be a positive integer");
  if (options.reviewCursor || options.reviewOnly)
    throw new Error("Catch-up cannot consume review continuation");
  for (let n = 1; n <= maxWakes; n++) {
    options.signal?.throwIfAborted();
    const result = await wake({ ...options, syncOnly: true });
    await onWake(result, n);
    if (result.syncComplete)
      return { outcome: "certified" as const, wakes: n, result };
    if (result.syncOutcome !== "budget")
      return { outcome: "blocked" as const, wakes: n, result };
    if (!result.coverage.pages)
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

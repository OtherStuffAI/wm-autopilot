export function waitForRecordSyncRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid record-sync retry delay");
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Retry cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.max(1, ms));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

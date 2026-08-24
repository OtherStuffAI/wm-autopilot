export interface ManagedSubprocessLike {
  kill(signal?: NodeJS.Signals | number): void;
  exited: Promise<number | null>;
}

export interface StopManagedSubprocessOptions {
  gracePeriodMs?: number;
}

export interface StopManagedSubprocessResult {
  forced: boolean;
}

const DEFAULT_GRACE_PERIOD_MS = 5_000;

function getGracePeriodMs(options?: StopManagedSubprocessOptions): number {
  const candidate = options?.gracePeriodMs;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return candidate;
  }
  return DEFAULT_GRACE_PERIOD_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function awaitExit(process: ManagedSubprocessLike): Promise<void> {
  return process.exited.then(() => undefined).catch(() => undefined);
}

export async function stopManagedSubprocess(
  process: ManagedSubprocessLike,
  options?: StopManagedSubprocessOptions,
): Promise<StopManagedSubprocessResult> {
  const gracePeriodMs = getGracePeriodMs(options);
  const exitPromise = awaitExit(process);

  try {
    process.kill("SIGTERM");
  } catch {
    await exitPromise;
    return { forced: false };
  }

  const gracefulExit = await Promise.race([
    exitPromise.then(() => true),
    delay(gracePeriodMs).then(() => false),
  ]);

  if (gracefulExit) {
    await exitPromise;
    return { forced: false };
  }

  try {
    process.kill("SIGKILL");
  } catch {
    // Ignore races where the child exits between the timeout and the forced kill.
  }

  await exitPromise;
  return { forced: true };
}

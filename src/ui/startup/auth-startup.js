const DEFAULT_AUTH_STARTUP_TIMEOUT_MS = 2500;

function createTimeoutResult(label, timeoutMs) {
  return {
    status: "timed-out",
    label,
    error: new Error(`${label} timed out after ${timeoutMs}ms`),
  };
}

export async function runStartupStepWithTimeout(label, work, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, options.timeoutMs)
    : DEFAULT_AUTH_STARTUP_TIMEOUT_MS;

  let timeoutId = null;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .then(
          (value) => ({ status: "fulfilled", label, value }),
          (error) => ({ status: "rejected", label, error }),
        ),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(createTimeoutResult(label, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

export async function restoreStartupIdentity(options = {}) {
  const {
    identityApi,
    getIdentityWiringContext,
    isAuthenticated,
    timeoutMs = DEFAULT_AUTH_STARTUP_TIMEOUT_MS,
    logger = console,
  } = options;

  const results = [];
  const getContext = typeof getIdentityWiringContext === "function"
    ? getIdentityWiringContext
    : () => ({});
  const isAuthed = typeof isAuthenticated === "function"
    ? isAuthenticated
    : () => false;

  if (typeof identityApi?.restoreFromDeviceKeystore === "function") {
    const result = await runStartupStepWithTimeout(
      "Device keystore restore",
      () => identityApi.restoreFromDeviceKeystore(getContext()),
      { timeoutMs },
    );
    results.push(result);
    if (result.status === "fulfilled" && result.value) {
      logger?.log?.("[app] Session restored from device keystore");
    } else if (result.status === "rejected") {
      logger?.warn?.("[app] Device keystore restore failed:", result.error);
    } else if (result.status === "timed-out") {
      logger?.warn?.("[app] Device keystore restore timed out; continuing startup");
    }
  }

  if (!isAuthed() && typeof identityApi?.checkKeyTeleportParam === "function") {
    const result = await runStartupStepWithTimeout(
      "Key Teleport check",
      () => identityApi.checkKeyTeleportParam(getContext()),
      { timeoutMs },
    );
    results.push(result);
    if (result.status === "fulfilled" && result.value) {
      logger?.log?.("[app] Key Teleport login completed");
    } else if (result.status === "rejected") {
      logger?.warn?.("[app] Key Teleport check failed:", result.error);
    } else if (result.status === "timed-out") {
      logger?.warn?.("[app] Key Teleport check timed out; continuing startup");
    }
  }

  return results;
}

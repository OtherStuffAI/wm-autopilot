import type { AppRegistry } from "../../apps/app-registry";
import type { AppProcessManager } from "../../apps/app-process-manager";
import { autostartApps, type AppAutostartLogger } from "./app-autostart";
import { reconcileAppsWithPM2 } from "./pm2-reconcile";

interface HostedAppBootstrapSteps {
  reconcile: typeof reconcileAppsWithPM2;
  autostart: typeof autostartApps;
}

/** Run after HTTP starts; a slow hosted app must not block the control plane. */
export async function bootstrapHostedApps(
  registry: AppRegistry,
  processManager: AppProcessManager,
  logger: AppAutostartLogger = console,
  steps: HostedAppBootstrapSteps = { reconcile: reconcileAppsWithPM2, autostart: autostartApps },
): Promise<void> {
  logger.log("[apps-bootstrap] recovering hosted apps after HTTP startup");
  try {
    const result = await steps.reconcile(registry);
    if (result.appsReconciled > 0 || result.appsCleared > 0) {
      logger.log(`[pm2] reconciled apps: ${result.appsReconciled} running, ${result.appsCleared} cleared`);
    }
    await steps.autostart(registry, processManager, logger);
    await processManager.reconcileFipsIngresses();
    logger.log("[apps-bootstrap] hosted app recovery complete");
  } catch (error) {
    logger.warn(`[apps-bootstrap] app reconciliation or autostart failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

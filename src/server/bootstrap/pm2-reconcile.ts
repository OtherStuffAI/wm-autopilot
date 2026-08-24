/**
 * PM2 Reconciliation Module
 *
 * On server startup, reconciles PM2 running processes with app registry records.
 * PM2 is the source of truth for runtime state (running/stopped).
 * Registry is the source of truth for app metadata.
 */

import { listProcesses, type PM2ProcessDescription } from "../../agents/pm2-wrapper";
import type { AppRegistry } from "../../apps/app-registry";
import { runtimePortRegistry } from "../../apps/runtime-port-registry";
import { getListeningPortForPid } from "../../utils/port-utils";

function logRouting(message: string, data?: unknown): void {
  if (Bun.env.WINGMAN_ROUTING_DEBUG !== "1") {
    return;
  }
  console.debug(data ? `[pm2-reconcile] ${message}` : `[pm2-reconcile] ${message}`, data ?? "");
}

/**
 * Extract app ID from PM2 process environment.
 * User apps have APP_ID set in their env.
 */
function getAppIdFromPM2(proc: PM2ProcessDescription): string | null {
  const pm2Env = proc.pm2_env as Record<string, unknown> | undefined;
  const appId = pm2Env?.APP_ID;
  return typeof appId === "string" ? appId : null;
}

/**
 * Extract PORT from PM2 process environment.
 * Returns the port number if set, null otherwise.
 */
function getPortFromPM2(proc: PM2ProcessDescription): number | null {
  const pm2Env = proc.pm2_env as Record<string, unknown> | undefined;
  const portValue = pm2Env?.PORT;
  if (typeof portValue === "string") {
    const parsed = parseInt(portValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (typeof portValue === "number" && Number.isFinite(portValue)) {
    return portValue > 0 ? portValue : null;
  }
  return null;
}

/**
 * Reconcile PM2 processes with app registry records.
 *
 * Algorithm:
 * 1. Get all PM2 processes with APP_ID env var
 * 2. Get all apps from registry
 * 3. For each PM2 process with APP_ID:
 *    - Find matching app in registry
 *    - Update app's pm2Name if PM2 is online
 * 4. For each app in registry with pm2Name but not in PM2:
 *    - Clear the pm2Name (process no longer exists)
 */
export async function reconcileAppsWithPM2(
  registry: AppRegistry,
): Promise<{ appsReconciled: number; appsCleared: number }> {
  logRouting(`=== PM2 RECONCILIATION STARTED ===`);
  let appsReconciled = 0;
  let appsCleared = 0;

  // Get current PM2 state
  let pm2Processes: PM2ProcessDescription[] = [];
  try {
    pm2Processes = await listProcesses();
    logRouting(`found PM2 processes`, { count: pm2Processes.length });
  } catch (error) {
    console.warn(`[pm2-reconcile] failed to list PM2 processes for apps: ${(error as Error).message}`);
    return { appsReconciled: 0, appsCleared: 0 };
  }

  // Get apps from registry
  const apps = await registry.listApps();
  const appsById = new Map(apps.map((app) => [app.id, app]));
  const runningPm2Names = new Set<string>();

  // Build map of APP_ID -> PM2 process for running apps
  const pm2AppProcesses = new Map<string, PM2ProcessDescription>();
  for (const proc of pm2Processes) {
    const status = proc.pm2_env?.status;
    const name = typeof proc.name === "string" ? proc.name : null;
    if (status === "online" && name) {
      runningPm2Names.add(name);
    }
    const appId = getAppIdFromPM2(proc);
    if (appId) {
      pm2AppProcesses.set(appId, proc);
    }
  }

  // Reconcile: update apps that have running PM2 processes
  for (const [appId, proc] of pm2AppProcesses) {
    const app = appsById.get(appId);
    if (!app) {
      // PM2 process for unknown app - orphaned
      console.warn(`[pm2-reconcile] PM2 process ${proc.name} has APP_ID ${appId} but no registry entry`);
      continue;
    }

    const pm2Status = proc.pm2_env?.status;
    if (pm2Status === "online") {
      // Update app with PM2 info if it doesn't match
      const pm2Name = proc.name ?? undefined;
      const pm2Port = getPortFromPM2(proc);
      const pid = proc.pid ?? null;

      if (app.pm2Name !== pm2Name) {
        try {
          await registry.updateApp(appId, { pm2Name });
          const portInfo = pm2Port ? ` on port ${pm2Port}` : "";
          console.log(`[pm2-reconcile] updated app ${appId} with PM2 name ${pm2Name}${portInfo}`);
          appsReconciled++;
        } catch (error) {
          console.warn(`[pm2-reconcile] failed to update app ${appId}: ${(error as Error).message}`);
        }
      } else {
        appsReconciled++;
      }

      // Register runtime port for running apps.
      // Registered web apps have a stable assigned port injected as PORT when
      // they start. Prefer that contract over PID port detection: PM2 can
      // report wrapper/parent process information, and detection has produced
      // Autopilot's own port, causing app subdomain proxy loops.
      if (pid) {
        if (app.webApp && app.webAppPort) {
          runtimePortRegistry.set(appId, app.webAppPort, pid);
          logRouting(`registered assigned web app port`, { appId, port: app.webAppPort, pid });
        } else if (pm2Port) {
          runtimePortRegistry.set(appId, pm2Port, pid);
          logRouting(`registered PM2 env port`, { appId, port: pm2Port, pid });
        } else {
          logRouting(`detecting port for app`, { appId, pid, pm2Port });
          const detectedPort = await getListeningPortForPid(pid);
          logRouting(`port detection result`, { appId, pid, detectedPort, pm2Port });
          if (detectedPort) {
            runtimePortRegistry.set(appId, detectedPort, pid);
            logRouting(`registered detected port`, { appId, port: detectedPort, pid });
          } else {
            logRouting(`WARN: no port detected or in PM2 env`, { appId, pid });
          }
        }
      } else {
        if (app.webApp && app.webAppPort) {
          runtimePortRegistry.set(appId, app.webAppPort);
          logRouting(`registered assigned web app port without PID`, { appId, port: app.webAppPort });
        } else if (pm2Port) {
          runtimePortRegistry.set(appId, pm2Port);
          logRouting(`registered PM2 env port without PID`, { appId, port: pm2Port });
        } else {
          logRouting(`WARN: no PID for running app`, { appId });
        }
      }
    }
  }

  // Secondary reconciliation path:
  // if APP_ID is missing from PM2 env, keep apps attached by matching stored pm2Name.
  for (const app of apps) {
    if (!app.pm2Name || pm2AppProcesses.has(app.id) || !runningPm2Names.has(app.pm2Name)) {
      continue;
    }
    appsReconciled++;
    if (app.webApp && app.webAppPort) {
      runtimePortRegistry.set(app.id, app.webAppPort);
      logRouting(`matched running app by pm2Name and restored web app port`, {
        appId: app.id,
        pm2Name: app.pm2Name,
        port: app.webAppPort,
      });
    } else {
      logRouting(`matched running app by pm2Name`, { appId: app.id, pm2Name: app.pm2Name });
    }
  }

  // Clear pm2Name only when we are sure there is no running PM2 process by APP_ID or pm2Name.
  for (const app of apps) {
    if (app.pm2Name && !pm2AppProcesses.has(app.id) && !runningPm2Names.has(app.pm2Name)) {
      // This app has a pm2Name but no PM2 process - clear it
      try {
        await registry.updateApp(app.id, { pm2Name: undefined });
        console.log(`[pm2-reconcile] cleared pm2Name for app ${app.id} (process not running)`);
        appsCleared++;
      } catch (error) {
        console.warn(`[pm2-reconcile] failed to clear pm2Name for app ${app.id}: ${(error as Error).message}`);
      }
    }
  }

  if (appsReconciled > 0) {
    console.log(`[pm2-reconcile] reconciled ${appsReconciled} app(s) with PM2`);
  }
  if (appsCleared > 0) {
    console.log(`[pm2-reconcile] cleared PM2 state for ${appsCleared} app(s)`);
  }

  return { appsReconciled, appsCleared };
}

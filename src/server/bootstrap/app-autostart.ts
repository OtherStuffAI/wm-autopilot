import type { AppLifecycleScripts, AppRecord } from "../../apps/app-registry";
import type { AppProcessStatus } from "../../apps/app-process-manager";

import { awaitAppStartup } from "../../apps/app-startup-deadline";

export const APP_AUTOSTART_TIMEOUT_MS = 60_000;

export interface AppAutostartRegistry {
  listApps: () => Promise<AppRecord[]>;
}

export interface AppAutostartProcessManager {
  getStatus: (appId: string) => Promise<AppProcessStatus>;
  restart: (appId: string, signal?: AbortSignal) => Promise<AppProcessStatus>;
}

export interface AppAutostartLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
}

export interface AppAutostartResult {
  checked: number;
  started: number;
  skippedRunning: number;
  skippedInProgress: number;
  skippedMissingStartScript: number;
  skippedReviewRequired: number;
  failed: Array<{ appId: string; label: string; error: string }>;
}

function hasStartScript(scripts: AppLifecycleScripts): boolean {
  return Boolean(scripts.start?.executable);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export async function autostartApps(
  registry: AppAutostartRegistry,
  processManager: AppAutostartProcessManager,
  logger: AppAutostartLogger = console,
  timeoutMs = APP_AUTOSTART_TIMEOUT_MS,
): Promise<AppAutostartResult> {
  const result: AppAutostartResult = {
    checked: 0,
    started: 0,
    skippedRunning: 0,
    skippedInProgress: 0,
    skippedMissingStartScript: 0,
    skippedReviewRequired: 0,
    failed: [],
  };

  const apps = await registry.listApps();
  const autoStartApps = apps.filter((app) => app.autoStart);
  result.checked = autoStartApps.length;

  for (const app of autoStartApps) {
    if (app.lifecycleReviewRequired) {
      result.skippedReviewRequired++;
      logger.warn(`[apps-autostart] skipped ${app.label} (${app.id}): lifecycle requires Admin review`);
      continue;
    }
    if (!hasStartScript(app.scripts)) {
      result.skippedMissingStartScript++;
      logger.warn(`[apps-autostart] skipped ${app.label} (${app.id}): missing start script`);
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(
      `Autostart abandoned after ${timeoutMs / 1000} seconds; start manually from the Apps UI`,
    )), timeoutMs);
    try {
      const status = await awaitAppStartup(() => processManager.getStatus(app.id), controller.signal);
      if (status.inProgressAction) {
        result.skippedInProgress++;
        logger.warn(
          `[apps-autostart] skipped ${app.label} (${app.id}): ${status.inProgressAction} already in progress`,
        );
        continue;
      }

      await awaitAppStartup(() => processManager.restart(app.id, controller.signal), controller.signal);
      result.started++;
      const previousState = status.running ? "running" : "stopped";
      logger.log(`[apps-autostart] restarted ${app.label} (${app.id}) from ${previousState} state`);
    } catch (error) {
      const message = errorMessage(error);
      result.failed.push({ appId: app.id, label: app.label, error: message });
      logger.warn(`[apps-autostart] failed to restart ${app.label} (${app.id}): ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  if (result.checked > 0) {
    logger.log(
      `[apps-autostart] checked ${result.checked} app(s): ${result.started} restarted, ${result.skippedRunning} already running, ${result.failed.length} failed`,
    );
  }

  return result;
}

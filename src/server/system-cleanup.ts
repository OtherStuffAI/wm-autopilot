import type { AgentType } from "../config";
import type { ProcessManager } from "../agents/process-manager";
import type { MessageStore } from "../storage/message-store";
import type { AppProcessManager } from "../apps/app-process-manager";
import type { AppRegistry } from "../apps/app-registry";

type SessionCleanupDetail = {
  id: string;
  agent: AgentType;
  name: string;
  port: number;
  npub: string | null;
  stopped: boolean;
  deleted: boolean;
  stopError?: string;
  deleteError?: string;
};

type AppCleanupDetail = {
  id: string;
  label: string;
  running: boolean;
  killed: boolean;
  removed: boolean;
  killError?: string;
  removeError?: string;
};

export type SystemCleanupResult = {
  timestamp: string;
  requestedBy?: string | null;
  preservedCoreApp: boolean;
  sessions: {
    total: number;
    stopped: number;
    deleted: number;
    failed: number;
    details: SessionCleanupDetail[];
  };
  apps: {
    total: number;
    killed: number;
    removed: number;
    failed: number;
    skipped: number;
    details: AppCleanupDetail[];
  };
};

export interface SystemCleanupDeps {
  manager: ProcessManager;
  messageStore: MessageStore;
  appProcessManager: AppProcessManager;
  appRegistry: AppRegistry;
  requestedBy?: string | null;
}

export async function performSystemCleanup(deps: SystemCleanupDeps): Promise<SystemCleanupResult> {
  const { manager, messageStore, appProcessManager, appRegistry, requestedBy = null } = deps;
  const snapshotTimestamp = new Date().toISOString();
  const sessionSnapshots = manager.listSessions();
  const sessionDetails: SessionCleanupDetail[] = [];
  let sessionsStopped = 0;
  let sessionsDeleted = 0;
  let sessionFailures = 0;

  console.log(
    `[system-cleanup] requested by ${requestedBy ?? "unknown"}; stopping ${sessionSnapshots.length} session${sessionSnapshots.length === 1 ? "" : "s"}`,
  );

  for (const snapshot of sessionSnapshots) {
    const detail: SessionCleanupDetail = {
      id: snapshot.id,
      agent: snapshot.agent,
      name: snapshot.name,
      port: snapshot.port,
      npub: snapshot.npub ?? null,
      stopped: false,
      deleted: false,
    };

    try {
      await manager.stopSession(snapshot.id);
      detail.stopped = true;
      sessionsStopped += 1;
    } catch (error) {
      detail.stopError = error instanceof Error ? error.message : String(error);
    }

    const current = manager.getSession(snapshot.id);
    const canDelete =
      !current ||
      current.status === "stopped" ||
      current.status === "error";

    if (canDelete) {
      try {
        const removed = manager.deleteSession(snapshot.id);
        if (removed) {
          detail.deleted = true;
          sessionsDeleted += 1;
          try {
            messageStore.removeSession(snapshot.id);
          } catch (error) {
            detail.deleteError = error instanceof Error ? error.message : String(error);
            detail.deleted = false;
            sessionsDeleted -= 1;
          }
        }
      } catch (error) {
        detail.deleteError = error instanceof Error ? error.message : String(error);
      }
    } else if (!detail.stopError) {
      detail.stopError = "Session still running after stop attempt";
    }

    if (detail.stopError || detail.deleteError) {
      sessionFailures += 1;
    }

    sessionDetails.push(detail);
  }

  const appDetails: AppCleanupDetail[] = [];
  const appStatuses = await appProcessManager.listStatuses().catch(() => []);
  const statusMap = new Map(appStatuses.map((status) => [status.appId, status]));
  const apps = await appRegistry.listApps();
  let appsKilled = 0;
  let appsRemoved = 0;
  let appFailures = 0;
  let appSkipped = 0;
  let preservedCoreApp = false;

  console.log(
    `[system-cleanup] requested by ${requestedBy ?? "unknown"}; stopping/removing ${apps.length} app${apps.length === 1 ? "" : "s"}`,
  );

  for (const app of apps) {
    if (app.id === "wingman-core") {
      preservedCoreApp = true;
      appSkipped += 1;
      continue;
    }

    const status = statusMap.get(app.id);
    const detail: AppCleanupDetail = {
      id: app.id,
      label: app.label,
      running: Boolean(status?.running),
      killed: false,
      removed: false,
    };

    try {
      await appProcessManager.kill(app.id);
      detail.killed = true;
      appsKilled += 1;
    } catch (error) {
      detail.killError = error instanceof Error ? error.message : String(error);
    }

    try {
      const removed = await appRegistry.removeApp(app.id);
      if (removed) {
        detail.removed = true;
        appsRemoved += 1;
      }
    } catch (error) {
      detail.removeError = error instanceof Error ? error.message : String(error);
    } finally {
      appProcessManager.forget(app.id);
    }

    if (detail.killError || detail.removeError) {
      appFailures += 1;
    }

    appDetails.push(detail);
  }

  const result = {
    timestamp: snapshotTimestamp,
    requestedBy,
    preservedCoreApp,
    sessions: {
      total: sessionDetails.length,
      stopped: sessionsStopped,
      deleted: sessionsDeleted,
      failed: sessionFailures,
      details: sessionDetails,
    },
    apps: {
      total: appDetails.length,
      killed: appsKilled,
      removed: appsRemoved,
      failed: appFailures,
      skipped: appSkipped,
      details: appDetails,
    },
  };

  console.log(
    `[system-cleanup] completed for ${requestedBy ?? "unknown"}; sessions stopped=${sessionsStopped} deleted=${sessionsDeleted} failed=${sessionFailures}; apps killed=${appsKilled} removed=${appsRemoved} failed=${appFailures} skipped=${appSkipped}`,
  );

  return result;
}

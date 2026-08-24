/**
 * PM2 Agent Session Cleanup
 *
 * After session rehydration, sweeps PM2 for any agent processes that were NOT
 * reclaimed by the ProcessManager. These are orphans from a previous server
 * run that should be stopped and removed so they don't hold agent ports
 * indefinitely.
 */

import {
  listProcesses,
  stopProcess,
  deleteProcess,
  type PM2ProcessDescription,
} from "../../agents/pm2-wrapper";
import { PM2_NAMESPACE_AGENTS } from "../../agents/ecosystem-generator";
import type { ProcessManager } from "../../agents/process-manager";
import type { MessageStore } from "../../storage/message-store";

export interface AgentCleanupOutcome {
  checked: number;
  cleaned: number;
  failed: number;
  timestamp: string;
}

export interface Pm2CleanupOperations {
  listProcesses: typeof listProcesses;
  stopProcess: typeof stopProcess;
  deleteProcess: typeof deleteProcess;
}

const PM2_DEFAULT_NAMESPACE = "default";

function getPm2Env(proc: PM2ProcessDescription): Record<string, unknown> {
  return (proc.pm2_env as Record<string, unknown> | undefined) ?? {};
}

function getNestedEnv(pm2Env: Record<string, unknown>): Record<string, unknown> {
  return (pm2Env.env as Record<string, unknown> | undefined) ?? {};
}

function getEnvValue(pm2Env: Record<string, unknown>, key: string): unknown {
  const nestedEnv = getNestedEnv(pm2Env);
  return nestedEnv[key] ?? pm2Env[key];
}

function hasAgentSessionEnv(pm2Env: Record<string, unknown>): boolean {
  return (
    typeof getEnvValue(pm2Env, "SESSION_ID") === "string" &&
    typeof getEnvValue(pm2Env, "SESSION_PORT") === "string" &&
    typeof getEnvValue(pm2Env, "SESSION_AGENT") === "string" &&
    typeof getEnvValue(pm2Env, "SESSION_DIRECTORY") === "string"
  );
}

function hasLegacyAgentWrapperShape(pm2Env: Record<string, unknown>): boolean {
  const args = Array.isArray(pm2Env.args) ? pm2Env.args : [];
  const [shellMode, command] = args;
  return (
    shellMode === "-lc" &&
    typeof command === "string" &&
    command.includes("exec ") &&
    command.includes("< /dev/null")
  );
}

export function isWingmanAgentPm2Process(proc: PM2ProcessDescription): boolean {
  if (proc.name === "wingman" || proc.name === "wm-ap") {
    return false;
  }

  const pm2Env = getPm2Env(proc);
  const namespace = pm2Env.namespace;
  if (namespace === PM2_NAMESPACE_AGENTS) {
    return true;
  }

  // Current agent sessions are launched in the dedicated PM2 namespace above.
  // Older PM2 records were written in the default namespace and may carry the
  // agent marker/env. Only trust those inherited values when the process also
  // has the shell wrapper shape from createAppConfig; otherwise a core Wingman
  // server or user app started from an agent shell can inherit WINGMAN_PROCESS_KIND
  // and accidentally delete itself during cleanup.
  return (
    namespace === PM2_DEFAULT_NAMESPACE &&
    getEnvValue(pm2Env, "WINGMAN_PROCESS_KIND") === "agent-session" &&
    hasAgentSessionEnv(pm2Env) &&
    hasLegacyAgentWrapperShape(pm2Env) &&
    getEnvValue(pm2Env, "APP_ID") === undefined
  );
}

/**
 * Stop and delete any PM2 agent processes that are not tracked by the
 * ProcessManager.
 *
 * Call this AFTER all rehydration (warm restart + orphan reconnect) has
 * completed so we don't accidentally kill sessions that were just reclaimed.
 */
export async function cleanupOrphanedAgentProcesses(
  manager: ProcessManager,
  store?: MessageStore,
  operations: Pm2CleanupOperations = { listProcesses, stopProcess, deleteProcess },
): Promise<AgentCleanupOutcome> {
  let pm2Processes: PM2ProcessDescription[];
  try {
    pm2Processes = await operations.listProcesses();
  } catch (error) {
    console.warn(`[pm2-cleanup] failed to list PM2 processes: ${(error as Error).message}`);
    return { checked: 0, cleaned: 0, failed: 0, timestamp: new Date().toISOString() };
  }

  // Collect PM2 names that the ProcessManager currently owns
  const activePm2Names = new Set<string>();
  for (const session of manager.listSessions()) {
    if (session.pm2Name) {
      activePm2Names.add(session.pm2Name);
    }
  }

  const agentProcesses = pm2Processes.filter(isWingmanAgentPm2Process);

  let cleaned = 0;
  let failed = 0;
  const cleanedSessionIds: string[] = [];

  for (const proc of agentProcesses) {
    const name = proc.name;
    if (!name || activePm2Names.has(name)) {
      continue;
    }

    const pm2Env = getPm2Env(proc);
    const status = pm2Env.status;
    console.log(`[pm2-cleanup] removing orphaned agent process ${name} (status: ${status}, pid: ${proc.pid ?? "none"})`);

    try {
      await operations.stopProcess(name);
    } catch {
      // May already be stopped
    }
    try {
      await operations.deleteProcess(name);
      cleaned++;
      const sessionId = String(getEnvValue(pm2Env, "SESSION_ID") ?? "").trim();
      if (sessionId) cleanedSessionIds.push(sessionId);
    } catch (error) {
      console.warn(`[pm2-cleanup] failed to delete ${name}: ${(error as Error).message}`);
      failed++;
    }
  }

  if (store && cleanedSessionIds.length > 0) {
    store.markSessionsRuntimeStatus(cleanedSessionIds, "stable");
  }

  const outcome: AgentCleanupOutcome = {
    checked: agentProcesses.length,
    cleaned,
    failed,
    timestamp: new Date().toISOString(),
  };

  if (cleaned > 0) {
    console.log(`[pm2-cleanup] removed ${cleaned} orphaned agent process${cleaned === 1 ? "" : "es"}`);
  }
  if (failed > 0) {
    console.warn(`[pm2-cleanup] failed to remove ${failed} orphaned agent process${failed === 1 ? "" : "es"}`);
  }

  return outcome;
}

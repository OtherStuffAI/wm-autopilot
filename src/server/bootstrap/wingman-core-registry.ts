import { normalize } from "node:path";

import type {
  AppRecord,
  AppRegistry,
  RegisterAppInput,
  UpdateAppInput,
} from "../../apps/app-registry";
import { appCommand, appCommandsEqual, migrateLegacyAppCommand, type AppCommand } from "../../apps/app-command";

export const WINGMAN_CORE_APP_ID = "wingman-core";

const DEFAULT_LABEL = "Wingman Server";
const DEFAULT_RESTART_COMMAND = appCommand("bun", "run", "scripts/restart-wingman.ts");
const DEFAULT_TMUX_SESSION = "wingman-core";
const DEFAULT_NOTES = "Controls the Wingman server process.";

type AppRegistryLike = Pick<
  AppRegistry,
  "listApps" | "getApp" | "registerApp" | "updateApp" | "removeApp" | "reassignAppId"
>;

type LoggerLike = Pick<Console, "log" | "warn" | "error">;

export interface EnsureWingmanCoreRegistrationOptions {
  projectRoot: string;
  adminNpub?: string | null;
  restartCommand?: string | AppCommand;
  tmuxSession?: string;
  notes?: string;
  logger?: LoggerLike;
}

export interface CleanupLegacyWingmanRootAppsOptions {
  projectRoot: string;
  logger?: LoggerLike;
}

export interface WingmanCoreRegistrationResult {
  action: "registered" | "updated" | "unchanged" | "adopted" | "error";
  app: AppRecord | null;
  legacyConflictIds: string[];
}

export interface WingmanCoreCleanupResult {
  matchedIds: string[];
  removedIds: string[];
  failedIds: string[];
}

export async function ensureWingmanCoreRegistration(
  registry: AppRegistryLike,
  options: EnsureWingmanCoreRegistrationOptions,
): Promise<WingmanCoreRegistrationResult> {
  const logger = options.logger ?? console;
  const expectedRoot = normalize(options.projectRoot);
  const restartCommand = typeof options.restartCommand === "string"
    ? migrateLegacyAppCommand(options.restartCommand)
    : options.restartCommand ?? DEFAULT_RESTART_COMMAND;
  if (!restartCommand) throw new Error("Wingman restart command requires explicit structured review");
  const tmuxSession = options.tmuxSession ?? DEFAULT_TMUX_SESSION;
  const notes = options.notes ?? DEFAULT_NOTES;

  try {
    const apps = await registry.listApps();
    const legacyApps = findLegacyWingmanRootApps(apps, expectedRoot);
    const existing = await registry.getApp(WINGMAN_CORE_APP_ID);

    if (existing) {
      const updateInput = buildWingmanCoreUpdateInput(
        existing,
        expectedRoot,
        DEFAULT_LABEL,
        restartCommand,
        tmuxSession,
        notes,
        options.adminNpub ?? null,
      );
      const app = updateInput ? await registry.updateApp(WINGMAN_CORE_APP_ID, updateInput) : existing;
      if (updateInput) {
        logger.log("[apps] reconciled Wingman core app entry");
      }
      if (legacyApps.length > 0) {
        logger.warn(
          `[apps] preserving ${legacyApps.length} legacy Wingman app entr${legacyApps.length === 1 ? "y" : "ies"} during startup; run cleanupLegacyWingmanRootApps() to remove them explicitly`,
        );
      }
      return {
        action: updateInput ? "updated" : "unchanged",
        app,
        legacyConflictIds: legacyApps.map((appRecord) => appRecord.id),
      };
    }

    if (legacyApps.length > 0) {
      const seed = selectLegacyWingmanSeed(legacyApps);
      const adopted = await registry.reassignAppId(seed.id, WINGMAN_CORE_APP_ID);
      const updateInput = buildWingmanCoreUpdateInput(
        adopted,
        expectedRoot,
        DEFAULT_LABEL,
        restartCommand,
        tmuxSession,
        notes,
        options.adminNpub ?? null,
      );
      const app = updateInput ? await registry.updateApp(WINGMAN_CORE_APP_ID, updateInput) : adopted;
      logger.warn(
        `[apps] adopted legacy Wingman app entry (${seed.id}) as ${WINGMAN_CORE_APP_ID} during startup to preserve core registration`,
      );
      const remainingLegacyConflictIds = legacyApps
        .filter((appRecord) => appRecord.id !== seed.id)
        .map((appRecord) => appRecord.id);
      if (remainingLegacyConflictIds.length > 0) {
        logger.warn(
          `[apps] preserving ${remainingLegacyConflictIds.length} additional legacy Wingman app entr${remainingLegacyConflictIds.length === 1 ? "y" : "ies"} during startup; run cleanupLegacyWingmanRootApps() to remove them explicitly`,
        );
      }
      return {
        action: "adopted",
        app,
        legacyConflictIds: remainingLegacyConflictIds,
      };
    }

    const app = await registry.registerApp(
      buildWingmanCoreRegistrationInput(
        expectedRoot,
        DEFAULT_LABEL,
        restartCommand,
        tmuxSession,
        notes,
        options.adminNpub ?? null,
      ),
    );
    logger.log("[apps] registered Wingman core app entry");
    return { action: "registered", app, legacyConflictIds: [] };
  } catch (error) {
    logger.error("[apps] Failed to ensure Wingman core registration:", error);
    return { action: "error", app: null, legacyConflictIds: [] };
  }
}

export async function cleanupLegacyWingmanRootApps(
  registry: AppRegistryLike,
  options: CleanupLegacyWingmanRootAppsOptions,
): Promise<WingmanCoreCleanupResult> {
  const logger = options.logger ?? console;
  const expectedRoot = normalize(options.projectRoot);

  try {
    const apps = await registry.listApps();
    const legacyApps = findLegacyWingmanRootApps(apps, expectedRoot);
    const matchedIds = legacyApps.map((app) => app.id);
    if (legacyApps.length === 0) {
      logger.log("[apps] explicit Wingman legacy cleanup found no matching app entries");
      return { matchedIds: [], removedIds: [], failedIds: [] };
    }

    logger.log(
      `[apps] running explicit Wingman legacy cleanup for ${legacyApps.length} same-root app entr${legacyApps.length === 1 ? "y" : "ies"}`,
    );

    const removedIds: string[] = [];
    const failedIds: string[] = [];
    for (const legacyApp of legacyApps) {
      try {
        const removed = await registry.removeApp(legacyApp.id);
        if (removed) {
          removedIds.push(legacyApp.id);
          logger.log(`[apps] removed legacy Wingman app entry (${legacyApp.id})`);
          continue;
        }
        failedIds.push(legacyApp.id);
        logger.warn(`[apps] legacy Wingman app entry disappeared before cleanup (${legacyApp.id})`);
      } catch (error) {
        failedIds.push(legacyApp.id);
        logger.warn(`[apps] failed to remove legacy Wingman app ${legacyApp.id}: ${(error as Error).message}`);
      }
    }

    logger.log(
      `[apps] explicit Wingman legacy cleanup removed ${removedIds.length} of ${legacyApps.length} matching app entr${legacyApps.length === 1 ? "y" : "ies"}`,
    );
    return { matchedIds, removedIds, failedIds };
  } catch (error) {
    logger.error("[apps] Failed to clean up legacy Wingman app entries:", error);
    return { matchedIds: [], removedIds: [], failedIds: [] };
  }
}

function findLegacyWingmanRootApps(apps: AppRecord[], projectRoot: string): AppRecord[] {
  return apps.filter((app) => app.id !== WINGMAN_CORE_APP_ID && normalize(app.root) === projectRoot);
}

function buildWingmanCoreRegistrationInput(
  projectRoot: string,
  label: string,
  restartCommand: AppCommand,
  tmuxSession: string,
  notes: string,
  adminNpub: string | null,
): RegisterAppInput {
  return {
    id: WINGMAN_CORE_APP_ID,
    label,
    root: projectRoot,
    scripts: { restart: restartCommand },
    tmuxSession,
    notes,
    ownerNpub: adminNpub,
  };
}

function buildWingmanCoreUpdateInput(
  existing: AppRecord,
  projectRoot: string,
  label: string,
  restartCommand: AppCommand,
  tmuxSession: string,
  notes: string,
  adminNpub: string | null,
): UpdateAppInput | null {
  const needsUpdate =
    existing.label !== label ||
    !appCommandsEqual(existing.scripts.restart, restartCommand) ||
    existing.tmuxSession !== tmuxSession ||
    normalize(existing.root) !== projectRoot ||
    !existing.notes ||
    (!existing.ownerNpub && Boolean(adminNpub));

  if (!needsUpdate) {
    return null;
  }

  return {
    label,
    root: projectRoot,
    scripts: { restart: restartCommand },
    tmuxSession,
    notes: existing.notes ?? notes,
    ownerNpub: adminNpub ?? existing.ownerNpub ?? null,
  };
}

function selectLegacyWingmanSeed(apps: AppRecord[]): AppRecord {
  return [...apps].sort((left, right) => {
    const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
    if (createdAtOrder !== 0) {
      return createdAtOrder;
    }
    return left.id.localeCompare(right.id);
  })[0]!;
}

/**
 * CapRover Store
 *
 * SQLite store for tracking CapRover apps and deployment history.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "../storage/message-store";
import type {
  CaproverAppRecord,
  CaproverDeploymentRecord,
  DeploymentStatus,
  DeployMethod,
} from "./types";

// ============================================================
// Input Types
// ============================================================

export interface CreateCaproverAppRecordInput {
  appId?: string | null;
  projectId?: string | null;
  caproverName: string;
  liveUrl?: string | null;
  customDomain?: string | null;
  hasSsl?: boolean;
  notes?: string | null;
}

export interface UpdateCaproverAppRecordInput {
  appId?: string | null;
  projectId?: string | null;
  caproverName?: string;
  liveUrl?: string | null;
  customDomain?: string | null;
  hasSsl?: boolean;
  deployedVersion?: number | null;
  notes?: string | null;
}

export interface CreateDeploymentInput {
  caproverAppId: string;
  targetName?: string;
  deployMethod: DeployMethod;
  dockerImage?: string | null;
  gitHash?: string | null;
}

export interface UpdateDeploymentInput {
  version?: number | null;
  status?: DeploymentStatus;
  completedAt?: string | null;
  errorMessage?: string | null;
  logs?: string | null;
}

// ============================================================
// Store Implementation
// ============================================================

const DEFAULT_DB_PATH = databaseFile;

class CaproverStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  // ----------------------------------------------------------
  // App Methods
  // ----------------------------------------------------------

  listApps(): CaproverAppRecord[] {
    return this.db
      .query<CaproverAppRecord, []>(
        `SELECT
           id,
           app_id as appId,
           project_id as projectId,
           caprover_name as caproverName,
           live_url as liveUrl,
           custom_domain as customDomain,
           has_ssl as hasSsl,
           env_vars_encrypted as envVarsEncrypted,
           deployed_version as deployedVersion,
           notes,
           created_at as createdAt,
           updated_at as updatedAt
         FROM caprover_apps
         ORDER BY created_at DESC`,
      )
      .all();
  }

  getApp(id: string): CaproverAppRecord | null {
    const result = this.db
      .query<CaproverAppRecord, [string]>(
        `SELECT
           id,
           app_id as appId,
           project_id as projectId,
           caprover_name as caproverName,
           live_url as liveUrl,
           custom_domain as customDomain,
           has_ssl as hasSsl,
           env_vars_encrypted as envVarsEncrypted,
           deployed_version as deployedVersion,
           notes,
           created_at as createdAt,
           updated_at as updatedAt
         FROM caprover_apps
         WHERE id = ?1`,
      )
      .get(id);
    return result ?? null;
  }

  getAppByCaproverName(caproverName: string): CaproverAppRecord | null {
    const result = this.db
      .query<CaproverAppRecord, [string]>(
        `SELECT
           id,
           app_id as appId,
           project_id as projectId,
           caprover_name as caproverName,
           live_url as liveUrl,
           custom_domain as customDomain,
           has_ssl as hasSsl,
           env_vars_encrypted as envVarsEncrypted,
           deployed_version as deployedVersion,
           notes,
           created_at as createdAt,
           updated_at as updatedAt
         FROM caprover_apps
         WHERE caprover_name = ?1`,
      )
      .get(caproverName);
    return result ?? null;
  }

  getAppByLocalAppId(appId: string): CaproverAppRecord | null {
    const result = this.db
      .query<CaproverAppRecord, [string]>(
        `SELECT
           id,
           app_id as appId,
           project_id as projectId,
           caprover_name as caproverName,
           live_url as liveUrl,
           custom_domain as customDomain,
           has_ssl as hasSsl,
           env_vars_encrypted as envVarsEncrypted,
           deployed_version as deployedVersion,
           notes,
           created_at as createdAt,
           updated_at as updatedAt
         FROM caprover_apps
         WHERE app_id = ?1`,
      )
      .get(appId);
    return result ?? null;
  }

  listAppsForProject(projectId: string): CaproverAppRecord[] {
    return this.db
      .query<CaproverAppRecord, [string]>(
        `SELECT
           id,
           app_id as appId,
           project_id as projectId,
           caprover_name as caproverName,
           live_url as liveUrl,
           custom_domain as customDomain,
           has_ssl as hasSsl,
           env_vars_encrypted as envVarsEncrypted,
           deployed_version as deployedVersion,
           notes,
           created_at as createdAt,
           updated_at as updatedAt
         FROM caprover_apps
         WHERE project_id = ?1
         ORDER BY created_at DESC`,
      )
      .all(projectId);
  }

  createApp(input: CreateCaproverAppRecordInput): CaproverAppRecord {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .query(
        `INSERT INTO caprover_apps (
           id, app_id, project_id, caprover_name, live_url, custom_domain,
           has_ssl, env_vars_encrypted, deployed_version, notes,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .run(
        id,
        input.appId ?? null,
        input.projectId ?? null,
        input.caproverName,
        input.liveUrl ?? null,
        input.customDomain ?? null,
        input.hasSsl ? 1 : 0,
        null, // envVarsEncrypted
        null, // deployedVersion
        input.notes ?? null,
        now,
        now,
      );

    const created = this.getApp(id);
    if (!created) {
      throw new Error("Failed to create CapRover app record");
    }
    return created;
  }

  updateApp(id: string, input: UpdateCaproverAppRecordInput): CaproverAppRecord {
    const existing = this.getApp(id);
    if (!existing) {
      throw new Error(`CapRover app not found: ${id}`);
    }

    const now = new Date().toISOString();

    this.db
      .query(
        `UPDATE caprover_apps SET
           app_id = ?2,
           project_id = ?3,
           caprover_name = ?4,
           live_url = ?5,
           custom_domain = ?6,
           has_ssl = ?7,
           deployed_version = ?8,
           notes = ?9,
           updated_at = ?10
         WHERE id = ?1`,
      )
      .run(
        id,
        input.appId !== undefined ? input.appId : existing.appId,
        input.projectId !== undefined ? input.projectId : existing.projectId,
        input.caproverName !== undefined ? input.caproverName : existing.caproverName,
        input.liveUrl !== undefined ? input.liveUrl : existing.liveUrl,
        input.customDomain !== undefined ? input.customDomain : existing.customDomain,
        input.hasSsl !== undefined ? (input.hasSsl ? 1 : 0) : (existing.hasSsl ? 1 : 0),
        input.deployedVersion !== undefined ? input.deployedVersion : existing.deployedVersion,
        input.notes !== undefined ? input.notes : existing.notes,
        now,
      );

    const updated = this.getApp(id);
    if (!updated) {
      throw new Error("Failed to update CapRover app record");
    }
    return updated;
  }

  deleteApp(id: string): boolean {
    const result = this.db.query("DELETE FROM caprover_apps WHERE id = ?1").run(id);
    return result.changes > 0;
  }

  // ----------------------------------------------------------
  // Deployment Methods
  // ----------------------------------------------------------

  listDeployments(caproverAppId?: string, limit = 50): CaproverDeploymentRecord[] {
    if (caproverAppId) {
      return this.db
        .query<CaproverDeploymentRecord, [string, number]>(
          `SELECT
             id,
             caprover_app_id as caproverAppId,
             target_name as targetName,
             version,
             status,
             deploy_method as deployMethod,
             docker_image as dockerImage,
             git_hash as gitHash,
             started_at as startedAt,
             completed_at as completedAt,
             error_message as errorMessage,
             logs_encrypted as logsEncrypted
           FROM caprover_deployments
           WHERE caprover_app_id = ?1
           ORDER BY started_at DESC
           LIMIT ?2`,
        )
        .all(caproverAppId, limit);
    }

    return this.db
      .query<CaproverDeploymentRecord, [number]>(
        `SELECT
           id,
           caprover_app_id as caproverAppId,
           target_name as targetName,
           version,
           status,
           deploy_method as deployMethod,
           docker_image as dockerImage,
           git_hash as gitHash,
           started_at as startedAt,
           completed_at as completedAt,
           error_message as errorMessage,
           logs_encrypted as logsEncrypted
         FROM caprover_deployments
         ORDER BY started_at DESC
         LIMIT ?1`,
      )
      .all(limit);
  }

  getDeployment(id: string): CaproverDeploymentRecord | null {
    const result = this.db
      .query<CaproverDeploymentRecord, [string]>(
        `SELECT
           id,
           caprover_app_id as caproverAppId,
           target_name as targetName,
           version,
           status,
           deploy_method as deployMethod,
           docker_image as dockerImage,
           git_hash as gitHash,
           started_at as startedAt,
           completed_at as completedAt,
           error_message as errorMessage,
           logs_encrypted as logsEncrypted
         FROM caprover_deployments
         WHERE id = ?1`,
      )
      .get(id);
    return result ?? null;
  }

  getLatestDeployment(caproverAppId: string): CaproverDeploymentRecord | null {
    const result = this.db
      .query<CaproverDeploymentRecord, [string]>(
        `SELECT
           id,
           caprover_app_id as caproverAppId,
           target_name as targetName,
           version,
           status,
           deploy_method as deployMethod,
           docker_image as dockerImage,
           git_hash as gitHash,
           started_at as startedAt,
           completed_at as completedAt,
           error_message as errorMessage,
           logs_encrypted as logsEncrypted
         FROM caprover_deployments
         WHERE caprover_app_id = ?1
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(caproverAppId);
    return result ?? null;
  }

  createDeployment(input: CreateDeploymentInput): CaproverDeploymentRecord {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .query(
        `INSERT INTO caprover_deployments (
           id, caprover_app_id, target_name, version, status, deploy_method,
           docker_image, git_hash, started_at, completed_at,
           error_message, logs_encrypted
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .run(
        id,
        input.caproverAppId,
        input.targetName ?? "primary",
        null, // version - set when deployment completes
        "pending",
        input.deployMethod,
        input.dockerImage ?? null,
        input.gitHash ?? null,
        now,
        null, // completedAt
        null, // errorMessage
        null, // logsEncrypted
      );

    const created = this.getDeployment(id);
    if (!created) {
      throw new Error("Failed to create deployment record");
    }
    return created;
  }

  updateDeployment(id: string, input: UpdateDeploymentInput): CaproverDeploymentRecord {
    const existing = this.getDeployment(id);
    if (!existing) {
      throw new Error(`Deployment not found: ${id}`);
    }

    this.db
      .query(
        `UPDATE caprover_deployments SET
           version = ?2,
           status = ?3,
           completed_at = ?4,
           error_message = ?5,
           logs_encrypted = ?6
         WHERE id = ?1`,
      )
      .run(
        id,
        input.version !== undefined ? input.version : existing.version,
        input.status ?? existing.status,
        input.completedAt !== undefined ? input.completedAt : existing.completedAt,
        input.errorMessage !== undefined ? input.errorMessage : existing.errorMessage,
        input.logs !== undefined ? input.logs : existing.logsEncrypted,
      );

    const updated = this.getDeployment(id);
    if (!updated) {
      throw new Error("Failed to update deployment record");
    }
    return updated;
  }

  // ----------------------------------------------------------
  // Initialization
  // ----------------------------------------------------------

  private initialise() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS caprover_apps (
        id TEXT PRIMARY KEY,
        app_id TEXT,
        project_id TEXT,
        caprover_name TEXT NOT NULL UNIQUE,
        live_url TEXT,
        custom_domain TEXT,
        has_ssl INTEGER NOT NULL DEFAULT 0,
        env_vars_encrypted TEXT,
        deployed_version INTEGER,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_caprover_apps_app_id ON caprover_apps(app_id);
      CREATE INDEX IF NOT EXISTS idx_caprover_apps_project_id ON caprover_apps(project_id);
      CREATE INDEX IF NOT EXISTS idx_caprover_apps_caprover_name ON caprover_apps(caprover_name);

      CREATE TABLE IF NOT EXISTS caprover_deployments (
        id TEXT PRIMARY KEY,
        caprover_app_id TEXT NOT NULL,
        target_name TEXT NOT NULL DEFAULT 'primary',
        version INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        deploy_method TEXT NOT NULL,
        docker_image TEXT,
        git_hash TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT,
        logs_encrypted TEXT,
        FOREIGN KEY (caprover_app_id) REFERENCES caprover_apps(id) ON DELETE CASCADE
      );
    `);

    const deploymentColumns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(caprover_deployments)")
      .all();
    if (!deploymentColumns.some((column) => column.name === "target_name")) {
      this.db.exec("ALTER TABLE caprover_deployments ADD COLUMN target_name TEXT NOT NULL DEFAULT 'primary'");
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_caprover_deployments_app ON caprover_deployments(caprover_app_id);
      CREATE INDEX IF NOT EXISTS idx_caprover_deployments_status ON caprover_deployments(status);
      CREATE INDEX IF NOT EXISTS idx_caprover_deployments_target ON caprover_deployments(target_name);
    `);
  }
}

export { CaproverStore };

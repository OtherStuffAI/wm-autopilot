import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";

import { databaseFile } from "../storage/message-store";
import {
  activateWappPublisherKey,
  readWappNsec,
  resolveCreateStoredWappKey,
  resolveUpdatedStoredWappKey,
  stageWappPublisherKey,
} from "./wapp-key-custody";
import { normalizeRegisteredOpenOrigins } from "./publication-metadata";
import { normalizeWappScopeLineage } from "./scope-access";
import { ensureWappStoreSchema } from "./wapp-store-schema";
import type {
  CreateWappInput,
  CreateWappTowerBindingInput,
  UpdateWappInput,
  UpdateWappTowerBindingInput,
  WappAppKeyMode,
  WappRecord,
  WappRecordState,
  WappSchedule,
  WappScopeLineage,
  WappStatus,
  WappTowerBinding,
} from "./types";
import { WappSigningBroker } from "./wapp-signing-broker";

const defaultWappDbPath = new URL("../../data/wapps.sqlite", import.meta.url).pathname;

interface WappRow {
  id: string;
  app_id: string;
  title: string;
  description: string | null;
  owner_npub: string;
  created_by_npub: string;
  workspace_owner_npub: string;
  scope_id: string;
  scope_lineage_json: string;
  allowed_npubs_json: string;
  launch_url: string;
  source_wingman_url: string | null;
  subdomain_alias: string | null;
  tower_binding_id: string | null;
  app_npub: string | null;
  registered_open_origins_json?: string | null;
  app_nsec_encrypted?: string | null;
  pending_app_npub?: string | null;
  pending_app_nsec_encrypted?: string | null;
  status?: WappStatus;
  schedule_json?: string | null;
  record_state: WappRecordState;
  created_at: string;
  updated_at: string;
  last_published_at: string | null;
}

interface WappTowerBindingRow {
  id: string;
  label: string;
  tower_url: string;
  workspace_id?: string | null;
  workspace_owner_npub: string;
  user_alias: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToTowerBinding(row: WappTowerBindingRow): WappTowerBinding {
  return {
    id: row.id,
    label: row.label,
    towerUrl: row.tower_url,
    workspaceId: row.workspace_id ?? null,
    workspaceOwnerNpub: row.workspace_owner_npub,
    userAlias: row.user_alias,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRecord(row: WappRow): WappRecord {
  return {
    id: row.id,
    wappInstallationId: row.id,
    appId: row.app_id,
    title: row.title,
    description: row.description,
    ownerNpub: row.owner_npub,
    createdByNpub: row.created_by_npub,
    workspaceOwnerNpub: row.workspace_owner_npub,
    scopeId: row.scope_id,
    scopeLineage: parseJson<WappScopeLineage>(
      row.scope_lineage_json,
      normalizeWappScopeLineage(row.scope_id),
    ),
    allowedNpubs: parseJson<string[]>(row.allowed_npubs_json, []),
    launchUrl: row.launch_url,
    sourceWingmanUrl: row.source_wingman_url,
    subdomainAlias: row.subdomain_alias,
    towerBindingId: row.tower_binding_id,
    towerBinding: null,
    appNpub: row.app_npub,
    publisherNpub: row.app_npub,
    pendingPublisherNpub: row.pending_app_npub ?? null,
    registeredOpenOrigins: parseJson<string[]>(row.registered_open_origins_json ?? null, []),
    status: row.status === "archived" ? "archived" : "active",
    schedule: parseJson<WappSchedule | null>(row.schedule_json ?? null, null),
    recordState: row.record_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastPublishedAt: row.last_published_at,
  };
}

function trimRequired(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

export class WappStore {
  private readonly db: Database;
  private readonly signingBroker: WappSigningBroker;

  constructor(dbPath: string = defaultWappDbPath, signingBroker = WappSigningBroker.forDataDirectory(dirname(dbPath))) {
    mkdirSync(dirname(dbPath || databaseFile), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    ensureWappStoreSchema(this.db);
    this.signingBroker = signingBroker;
    this.migrateSigningKeysToBroker();
  }

  list(): WappRecord[] {
    return (this.db.query("SELECT * FROM wapp_records ORDER BY updated_at DESC").all() as WappRow[]).map((row) => this.hydrateRecord(row));
  }

  get(id: string): WappRecord | null {
    const row = this.db.query("SELECT * FROM wapp_records WHERE id = ?").get(id) as WappRow | null;
    return row ? this.hydrateRecord(row) : null;
  }

  getByAppId(appId: string): WappRecord | null {
    const row = this.db.query("SELECT * FROM wapp_records WHERE app_id = ? AND record_state = 'active' ORDER BY updated_at DESC LIMIT 1").get(appId) as WappRow | null;
    return row ? this.hydrateRecord(row) : null;
  }

  listTowerBindings(): WappTowerBinding[] {
    return (this.db.query("SELECT * FROM wapp_tower_bindings ORDER BY is_default DESC, label ASC").all() as WappTowerBindingRow[])
      .map(rowToTowerBinding);
  }

  getTowerBinding(id: string): WappTowerBinding | null {
    const row = this.db.query("SELECT * FROM wapp_tower_bindings WHERE id = ?").get(id) as WappTowerBindingRow | null;
    return row ? rowToTowerBinding(row) : null;
  }

  getDefaultTowerBinding(): WappTowerBinding | null {
    const row = this.db.query("SELECT * FROM wapp_tower_bindings WHERE is_default = 1 LIMIT 1").get() as WappTowerBindingRow | null;
    return row ? rowToTowerBinding(row) : null;
  }

  createTowerBinding(input: CreateWappTowerBindingInput): WappTowerBinding {
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const isDefault = input.isDefault === true ? 1 : 0;
    if (isDefault) this.clearDefaultTowerBinding();
    this.db.query(`
      INSERT INTO wapp_tower_bindings (
        id, label, tower_url, workspace_id, workspace_owner_npub, user_alias, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      trimRequired(input.label, "label"),
      trimRequired(input.towerUrl, "towerUrl"),
      input.workspaceId?.trim() || null,
      trimRequired(input.workspaceOwnerNpub, "workspaceOwnerNpub"),
      input.userAlias?.trim() || null,
      isDefault,
      now,
      now,
    );
    return this.getTowerBinding(id)!;
  }

  updateTowerBinding(id: string, input: UpdateWappTowerBindingInput): WappTowerBinding | null {
    const existing = this.getTowerBinding(id);
    if (!existing) return null;
    const sets: string[] = [];
    const values: SQLQueryBindings[] = [];
    const add = (column: string, value: SQLQueryBindings) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (input.label !== undefined) add("label", trimRequired(input.label, "label"));
    if (input.towerUrl !== undefined) add("tower_url", trimRequired(input.towerUrl, "towerUrl"));
    if (input.workspaceId !== undefined) add("workspace_id", input.workspaceId?.trim() || null);
    if (input.workspaceOwnerNpub !== undefined) add("workspace_owner_npub", trimRequired(input.workspaceOwnerNpub, "workspaceOwnerNpub"));
    if (input.userAlias !== undefined) add("user_alias", input.userAlias?.trim() || null);
    if (input.isDefault !== undefined) {
      if (input.isDefault) this.clearDefaultTowerBinding(id);
      add("is_default", input.isDefault ? 1 : 0);
    }
    if (sets.length === 0) return existing;
    add("updated_at", new Date().toISOString());
    values.push(id);
    this.db.query(`UPDATE wapp_tower_bindings SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.getTowerBinding(id);
  }

  create(input: CreateWappInput): WappRecord {
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const lineage = normalizeWappScopeLineage(input.scopeId, input.scopeLineage);
    const appKey = resolveCreateStoredWappKey({
      towerBindingId: input.towerBindingId ?? null,
      mode: input.appKeyMode,
      appNsec: input.appNsec,
      bindingExists: (id) => Boolean(this.getTowerBinding(id)),
    });
    this.db.query(`
      INSERT INTO wapp_records (
        id, app_id, title, description, owner_npub, created_by_npub, workspace_owner_npub,
        scope_id, scope_lineage_json, allowed_npubs_json, launch_url, source_wingman_url,
        subdomain_alias, tower_binding_id, app_npub, app_nsec_encrypted, registered_open_origins_json, status, schedule_json,
        record_state, created_at, updated_at, last_published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
    `).run(
      id,
      input.appId,
      input.title,
      input.description ?? null,
      input.ownerNpub,
      input.createdByNpub,
      input.workspaceOwnerNpub,
      input.scopeId,
      JSON.stringify(lineage),
      JSON.stringify(input.allowedNpubs),
      input.launchUrl,
      input.sourceWingmanUrl ?? null,
      input.subdomainAlias ?? null,
      appKey.towerBindingId,
      appKey.appNpub,
      appKey.encryptedAppNsec,
      JSON.stringify(normalizeRegisteredOpenOrigins(input.registeredOpenOrigins, input.launchUrl)),
      input.status ?? "active",
      input.schedule ? JSON.stringify(input.schedule) : null,
      now,
      now,
    );
    this.migrateSigningKeysToBroker(id);
    return this.get(id)!;
  }

  update(id: string, input: UpdateWappInput): WappRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const sets: string[] = [];
    const values: SQLQueryBindings[] = [];
    const add = (column: string, value: SQLQueryBindings) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (input.title !== undefined) add("title", input.title);
    if (input.description !== undefined) add("description", input.description);
    if (input.workspaceOwnerNpub !== undefined) add("workspace_owner_npub", input.workspaceOwnerNpub);
    if (input.scopeId !== undefined) add("scope_id", input.scopeId);
    if (input.scopeLineage !== undefined || input.scopeId !== undefined) {
      add("scope_lineage_json", JSON.stringify(normalizeWappScopeLineage(input.scopeId ?? existing.scopeId, input.scopeLineage ?? existing.scopeLineage)));
    }
    if (input.allowedNpubs !== undefined) add("allowed_npubs_json", JSON.stringify(input.allowedNpubs));
    if (input.launchUrl !== undefined) add("launch_url", input.launchUrl);
    if (input.registeredOpenOrigins !== undefined || input.launchUrl !== undefined) {
      add("registered_open_origins_json", JSON.stringify(normalizeRegisteredOpenOrigins(
        input.registeredOpenOrigins ?? existing.registeredOpenOrigins,
        input.launchUrl ?? existing.launchUrl,
      )));
    }
    if (input.sourceWingmanUrl !== undefined) add("source_wingman_url", input.sourceWingmanUrl);
    if (input.subdomainAlias !== undefined) add("subdomain_alias", input.subdomainAlias);
    if (input.towerBindingId !== undefined || input.appNsec !== undefined || input.appKeyMode !== undefined) {
      const appKey = resolveUpdatedStoredWappKey({
        existing,
        towerBindingId: input.towerBindingId,
        mode: input.appKeyMode,
        appNsec: input.appNsec,
        bindingExists: (bindingId) => Boolean(this.getTowerBinding(bindingId)),
        existingKeyAvailable: this.hasAppSigningKey(existing.id),
      });
      add("tower_binding_id", appKey.towerBindingId);
      add("app_npub", appKey.appNpub);
      add("app_nsec_encrypted", appKey.encryptedAppNsec);
    }
    if (input.status !== undefined) add("status", input.status);
    if (input.schedule !== undefined) add("schedule_json", input.schedule ? JSON.stringify(input.schedule) : null);
    if (input.recordState !== undefined) add("record_state", input.recordState);
    if (input.lastPublishedAt !== undefined) add("last_published_at", input.lastPublishedAt);
    if (sets.length === 0) return existing;
    add("updated_at", new Date().toISOString());
    values.push(id);
    this.db.query(`UPDATE wapp_records SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  archive(id: string): WappRecord | null {
    return this.update(id, { status: "archived", recordState: "archived" });
  }

  markDeleted(id: string): WappRecord | null {
    return this.update(id, { status: "archived", recordState: "deleted" });
  }

  hasAppSigningKey(id: string, pending = false): boolean {
    const wapp = this.get(id);
    const npub = pending ? wapp?.pendingPublisherNpub : wapp?.appNpub;
    return Boolean(wapp && npub && this.signingBroker.has({ id, ownerNpub: wapp.ownerNpub, npub, pending }));
  }

  async withAppSigningKey<T>(id: string, operation: (nsec: string) => T | Promise<T>, pending = false): Promise<T> {
    const wapp = this.get(id);
    const npub = pending ? wapp?.pendingPublisherNpub : wapp?.appNpub;
    if (!wapp || !npub) throw new Error(`WApp ${id} has no ${pending ? "pending " : ""}publisher identity`);
    return await this.signingBroker.withNsec({ id, ownerNpub: wapp.ownerNpub, npub, pending }, operation);
  }

  stagePublisherKey(
    id: string,
    mode: WappAppKeyMode | undefined,
    importedNsec: string | null | undefined,
  ): WappRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (!existing.towerBindingId) {
      throw new Error(`WApp ${id} is not Tower-backed`);
    }
    stageWappPublisherKey(this.db, id, mode, importedNsec);
    this.migrateSigningKeysToBroker(id);
    return this.get(id);
  }

  async activatePendingPublisherKey(id: string): Promise<WappRecord | null> {
    const existing = this.get(id);
    if (!existing) return null;
    if (!existing.pendingPublisherNpub || !this.hasAppSigningKey(id, true)) {
      throw new Error(`WApp ${id} has no pending publisher key`);
    }
    await this.withAppSigningKey(id, (nsec) => this.signingBroker.provision({
      id,
      ownerNpub: existing.ownerNpub,
      npub: existing.pendingPublisherNpub!,
      nsec,
    }), true);
    activateWappPublisherKey(this.db, id);
    return this.get(id);
  }

  private clearDefaultTowerBinding(exceptId: string | null = null): void {
    if (exceptId) {
      this.db.query("UPDATE wapp_tower_bindings SET is_default = 0 WHERE id != ?").run(exceptId);
      return;
    }
    this.db.run("UPDATE wapp_tower_bindings SET is_default = 0");
  }

  private hydrateRecord(row: WappRow): WappRecord {
    const record = rowToRecord(row);
    if (record.registeredOpenOrigins.length === 0) {
      record.registeredOpenOrigins = normalizeRegisteredOpenOrigins(undefined, record.launchUrl);
      this.db.query("UPDATE wapp_records SET registered_open_origins_json = ? WHERE id = ?")
        .run(JSON.stringify(record.registeredOpenOrigins), row.id);
    }
    record.towerBinding = record.towerBindingId ? this.getTowerBinding(record.towerBindingId) : null;
    return record;
  }

  private migrateSigningKeysToBroker(onlyId?: string): void {
    const rows = (onlyId
      ? this.db.query("SELECT * FROM wapp_records WHERE id = ?").all(onlyId)
      : this.db.query("SELECT * FROM wapp_records").all()) as WappRow[];
    for (const row of rows) {
      for (const pending of [false, true]) {
        const stored = pending ? row.pending_app_nsec_encrypted : row.app_nsec_encrypted;
        const npub = pending ? row.pending_app_npub : row.app_npub;
        if (!stored || !npub) continue;
        const column = pending ? "pending_app_nsec_encrypted" : "app_nsec_encrypted";
        const nsec = readWappNsec(this.db, row.id, column);
        if (!nsec) continue;
        this.signingBroker.provision({ id: row.id, ownerNpub: row.owner_npub, npub, nsec, pending });
        this.db.query(`UPDATE wapp_records SET ${column} = NULL WHERE id = ?`).run(row.id);
      }
    }
  }
}

export const wappStore = new WappStore();

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { SkillDeploymentRecord, SkillProjectPolicy, SkillRevisionRecord, SkillSourceRecord } from "./types";

const DEFAULT_DB = new URL("../../data/skills.sqlite", import.meta.url).pathname;

export class SkillStore {
  private readonly db: Database;

  constructor(path = DEFAULT_DB) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    this.initialise();
  }

  createSource(input: Omit<SkillSourceRecord, "id" | "fetchedCommit" | "fetchedDigest" | "fetchedAt" | "activeImportId" | "createdAt" | "updatedAt">) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO skill_sources VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,NULL,NULL,NULL,?8,?9,?10,?10)`)
      .run(id, input.ownerNpub, input.name, input.sourceClass, input.sourceKind, input.location, input.ref, input.trustState, input.defaultEnabled ? 1 : 0, now);
    return this.getSource(id)!;
  }

  listSources(ownerNpub: string) {
    return (this.db.query(`SELECT * FROM skill_sources WHERE owner_npub IN (?1,'wingman-system') ORDER BY name`).all(ownerNpub) as Record<string, unknown>[]).map(mapSource);
  }

  getSource(id: string) {
    const row = this.db.query(`SELECT * FROM skill_sources WHERE id=?1`).get(id) as Record<string, unknown> | null;
    return row ? mapSource(row) : null;
  }

  updateFetched(id: string, commit: string | null, digest: string, fetchedAt: string) {
    this.db.prepare(`UPDATE skill_sources SET fetched_commit=?2,fetched_digest=?3,fetched_at=?4,updated_at=?4 WHERE id=?1`).run(id, commit, digest, fetchedAt);
    return this.getSource(id)!;
  }

  deleteSource(id: string) {
    const revisions = this.db.query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM skill_revisions WHERE source_id=?1`).get(id)?.count ?? 0;
    if (revisions > 0) throw new Error("Source has retained revisions and cannot be removed");
    return this.db.prepare(`DELETE FROM skill_sources WHERE id=?1`).run(id).changes > 0;
  }

  activate(sourceId: string, importId: string, activatedAt: string) {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE skill_sources SET active_import_id=?2,updated_at=?3 WHERE id=?1`).run(sourceId, importId, activatedAt);
      this.db.prepare(`UPDATE skill_revisions SET activated_at=?2 WHERE source_id=?1 AND import_id=?3`).run(sourceId, activatedAt, importId);
    })();
  }

  insertRevisions(revisions: SkillRevisionRecord[]) {
    const insert = this.db.prepare(`INSERT INTO skill_revisions VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`);
    this.db.transaction(() => revisions.forEach((r) => insert.run(r.id, r.importId, r.sourceId, r.skillId, r.name, r.description, r.relativePath, r.sourceCommit, r.contentDigest, JSON.stringify(r.compatibility), JSON.stringify(r.files), JSON.stringify(r.executableFiles), JSON.stringify(r.warnings), JSON.stringify(r.errors), r.snapshotPath, r.importedAt, r.activatedAt)))();
  }

  listRevisions(ownerNpub: string, skillId?: string) {
    const sql = `SELECT r.* FROM skill_revisions r JOIN skill_sources s ON s.id=r.source_id WHERE s.owner_npub IN (?1,'wingman-system')${skillId ? " AND r.skill_id=?2" : ""} ORDER BY r.imported_at DESC`;
    const rows = skillId ? this.db.query(sql).all(ownerNpub, skillId) : this.db.query(sql).all(ownerNpub);
    return (rows as Record<string, unknown>[]).map(mapRevision);
  }

  getRevision(id: string) {
    const row = this.db.query(`SELECT * FROM skill_revisions WHERE id=?1`).get(id) as Record<string, unknown> | null;
    return row ? mapRevision(row) : null;
  }

  listActiveCatalog(ownerNpub: string) {
    const rows = this.db.query(`SELECT r.* FROM skill_revisions r JOIN skill_sources s ON s.id=r.source_id AND s.active_import_id=r.import_id WHERE s.owner_npub IN (?1,'wingman-system') ORDER BY r.name`).all(ownerNpub) as Record<string, unknown>[];
    return rows.map(mapRevision);
  }

  upsertDeployment(record: SkillDeploymentRecord) {
    this.db.prepare(`INSERT INTO skill_deployments VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
      ON CONFLICT(owner_npub,project_id,skill_id) DO UPDATE SET revision_id=excluded.revision_id,deployment_name=excluded.deployment_name,installed_digest=excluded.installed_digest,portable=excluded.portable,claude_compatibility=excluded.claude_compatibility,repository_policy=excluded.repository_policy,state=excluded.state,updated_at=excluded.updated_at,checked_at=excluded.checked_at,last_result=excluded.last_result`)
      .run(record.id, record.ownerNpub, record.projectId, record.targetDirectory, record.skillId, record.revisionId, record.deploymentName, record.installedDigest, record.portable ? 1 : 0, record.claudeCompatibility ? 1 : 0, record.repositoryPolicy, record.state, record.installedAt, record.updatedAt, record.checkedAt, record.lastResult);
    return this.getDeployment(record.ownerNpub, record.projectId, record.skillId)!;
  }

  listDeployments(ownerNpub: string, skillId?: string) {
    const rows = skillId
      ? this.db.query(`SELECT * FROM skill_deployments WHERE owner_npub=?1 AND skill_id=?2 ORDER BY target_directory`).all(ownerNpub, skillId)
      : this.db.query(`SELECT * FROM skill_deployments WHERE owner_npub=?1 ORDER BY target_directory`).all(ownerNpub);
    return (rows as Record<string, unknown>[]).map(mapDeployment);
  }

  getDeployment(owner: string, project: string, skill: string) {
    const row = this.db.query(`SELECT * FROM skill_deployments WHERE owner_npub=?1 AND project_id=?2 AND skill_id=?3`).get(owner, project, skill) as Record<string, unknown> | null;
    return row ? mapDeployment(row) : null;
  }

  deleteDeployment(owner: string, project: string, skill: string) {
    return this.db.prepare(`DELETE FROM skill_deployments WHERE owner_npub=?1 AND project_id=?2 AND skill_id=?3`).run(owner, project, skill).changes > 0;
  }

  getPolicy(owner: string, project: string): SkillProjectPolicy {
    const row = this.db.query(`SELECT * FROM skill_project_policies WHERE owner_npub=?1 AND project_id=?2`).get(owner, project) as Record<string, unknown> | null;
    return row ? mapPolicy(row) : { ownerNpub: owner, projectId: project, claudeCompatibility: false, repositoryPolicy: "local_managed", defaultOptOuts: [], updatedAt: new Date(0).toISOString() };
  }

  putPolicy(policy: SkillProjectPolicy) {
    this.db.prepare(`INSERT INTO skill_project_policies VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(owner_npub,project_id) DO UPDATE SET claude_compatibility=excluded.claude_compatibility,repository_policy=excluded.repository_policy,default_opt_outs_json=excluded.default_opt_outs_json,updated_at=excluded.updated_at`)
      .run(policy.ownerNpub, policy.projectId, policy.claudeCompatibility ? 1 : 0, policy.repositoryPolicy, JSON.stringify(policy.defaultOptOuts), policy.updatedAt);
    return this.getPolicy(policy.ownerNpub, policy.projectId);
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_sources (id TEXT PRIMARY KEY,owner_npub TEXT NOT NULL,name TEXT NOT NULL,source_class TEXT NOT NULL,source_kind TEXT NOT NULL,location TEXT NOT NULL,ref TEXT,fetched_commit TEXT,fetched_digest TEXT,fetched_at TEXT,active_import_id TEXT,trust_state TEXT NOT NULL,default_enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_revisions (id TEXT PRIMARY KEY,import_id TEXT NOT NULL,source_id TEXT NOT NULL,skill_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,relative_path TEXT NOT NULL,source_commit TEXT,content_digest TEXT NOT NULL,compatibility_json TEXT NOT NULL,files_json TEXT NOT NULL,executable_files_json TEXT NOT NULL,warnings_json TEXT NOT NULL,errors_json TEXT NOT NULL,snapshot_path TEXT NOT NULL,imported_at TEXT NOT NULL,activated_at TEXT,FOREIGN KEY(source_id) REFERENCES skill_sources(id));
      CREATE TABLE IF NOT EXISTS skill_deployments (id TEXT PRIMARY KEY,owner_npub TEXT NOT NULL,project_id TEXT NOT NULL,target_directory TEXT NOT NULL,skill_id TEXT NOT NULL,revision_id TEXT NOT NULL,deployment_name TEXT NOT NULL,installed_digest TEXT NOT NULL,portable INTEGER NOT NULL,claude_compatibility INTEGER NOT NULL,repository_policy TEXT NOT NULL,state TEXT NOT NULL,installed_at TEXT NOT NULL,updated_at TEXT NOT NULL,checked_at TEXT NOT NULL,last_result TEXT,UNIQUE(owner_npub,project_id,skill_id));
      CREATE TABLE IF NOT EXISTS skill_project_policies (owner_npub TEXT NOT NULL,project_id TEXT NOT NULL,claude_compatibility INTEGER NOT NULL,repository_policy TEXT NOT NULL,default_opt_outs_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_npub,project_id));
      CREATE INDEX IF NOT EXISTS idx_skill_revisions_skill ON skill_revisions(skill_id); CREATE INDEX IF NOT EXISTS idx_skill_deployments_skill ON skill_deployments(skill_id);
    `);
  }
}

const strings = (value: unknown) => JSON.parse(String(value ?? "[]")) as string[];
const mapSource = (r: Record<string, unknown>): SkillSourceRecord => ({ id:String(r.id),ownerNpub:String(r.owner_npub),name:String(r.name),sourceClass:r.source_class as SkillSourceRecord["sourceClass"],sourceKind:r.source_kind as SkillSourceRecord["sourceKind"],location:String(r.location),ref:r.ref ? String(r.ref):null,fetchedCommit:r.fetched_commit?String(r.fetched_commit):null,fetchedDigest:r.fetched_digest?String(r.fetched_digest):null,fetchedAt:r.fetched_at?String(r.fetched_at):null,activeImportId:r.active_import_id?String(r.active_import_id):null,trustState:r.trust_state as SkillSourceRecord["trustState"],defaultEnabled:Boolean(r.default_enabled),createdAt:String(r.created_at),updatedAt:String(r.updated_at)});
const mapRevision = (r: Record<string, unknown>): SkillRevisionRecord => ({ id:String(r.id),importId:String(r.import_id),sourceId:String(r.source_id),skillId:String(r.skill_id),name:String(r.name),description:String(r.description),relativePath:String(r.relative_path),sourceCommit:r.source_commit?String(r.source_commit):null,contentDigest:String(r.content_digest),compatibility:strings(r.compatibility_json),files:strings(r.files_json),executableFiles:strings(r.executable_files_json),warnings:strings(r.warnings_json),errors:strings(r.errors_json),snapshotPath:String(r.snapshot_path),importedAt:String(r.imported_at),activatedAt:r.activated_at?String(r.activated_at):null});
const mapDeployment = (r: Record<string, unknown>): SkillDeploymentRecord => ({ id:String(r.id),ownerNpub:String(r.owner_npub),projectId:String(r.project_id),targetDirectory:String(r.target_directory),skillId:String(r.skill_id),revisionId:String(r.revision_id),deploymentName:String(r.deployment_name),installedDigest:String(r.installed_digest),portable:Boolean(r.portable),claudeCompatibility:Boolean(r.claude_compatibility),repositoryPolicy:r.repository_policy as SkillDeploymentRecord["repositoryPolicy"],state:r.state as SkillDeploymentRecord["state"],installedAt:String(r.installed_at),updatedAt:String(r.updated_at),checkedAt:String(r.checked_at),lastResult:r.last_result?String(r.last_result):null});
const mapPolicy = (r: Record<string, unknown>): SkillProjectPolicy => ({ownerNpub:String(r.owner_npub),projectId:String(r.project_id),claudeCompatibility:Boolean(r.claude_compatibility),repositoryPolicy:r.repository_policy as SkillProjectPolicy["repositoryPolicy"],defaultOptOuts:strings(r.default_opt_outs_json),updatedAt:String(r.updated_at)});

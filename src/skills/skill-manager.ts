import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { appendGitExclude, atomicCopy, digestDirectory, resolveAuthorizedDirectory } from "./skill-content";
import { SkillSourceImporter } from "./source-importer";
import { SkillStore } from "./skill-store";
import type { SkillDeploymentRecord, SkillPlanOperation, SkillProjectPolicy, SkillSourceClass, SkillSourceKind } from "./types";

type Project = { id: string; npub: string; directoryPath: string; name: string };
type ProjectStore = { getById(id: string): Project | null; getByPath?(owner: string, path: string): Project | null; createProject(npub: string, path: string, name?: string): Project | null };
type Plan = { ownerNpub: string; expiresAt: number; operations: SkillPlanOperation[] };

export class SkillManager {
  private readonly plans = new Map<string, Plan>();
  private readonly planSecret = crypto.getRandomValues(new Uint8Array(32));

  constructor(readonly store: SkillStore, private readonly projects: ProjectStore, private readonly importer = new SkillSourceImporter()) {}

  list(owner: string) {
    const sources = this.store.listSources(owner);
    const deployments = this.store.listDeployments(owner);
    return { sources, catalog: this.store.listActiveCatalog(owner).map((skill) => ({ ...skill, source: sources.find((source) => source.id === skill.sourceId), deployments: deployments.filter((deployment) => deployment.skillId === skill.skillId) })) };
  }

  registerSource(ownerNpub: string, input: { name: string; sourceClass: SkillSourceClass; sourceKind: SkillSourceKind; location: string; ref?: string | null; defaultEnabled?: boolean }, isAdmin: boolean) {
    if (!input.name.trim() || !input.location.trim()) throw new Error("Source name and location are required");
    if (!["wingman", "third_party", "user"].includes(input.sourceClass)) throw new Error("Invalid source class");
    if (!["git", "local"].includes(input.sourceKind)) throw new Error("Invalid source kind");
    if (input.sourceClass === "wingman" && !isAdmin) throw new Error("Only administrators can register Wingman sources");
    return this.store.createSource({ ownerNpub: input.sourceClass === "wingman" ? "wingman-system" : ownerNpub, name: input.name.trim(), sourceClass: input.sourceClass, sourceKind: input.sourceKind, location: input.location.trim(), ref: input.ref?.trim() || null, trustState: input.sourceClass === "wingman" ? "system" : input.sourceClass === "third_party" ? "operator_imported" : "user_imported", defaultEnabled: input.sourceClass === "wingman" && Boolean(input.defaultEnabled) });
  }

  private ownedSource(owner: string, sourceId: string, write = false) {
    const source = this.store.getSource(sourceId);
    if (!source || (source.ownerNpub !== owner && source.ownerNpub !== "wingman-system")) throw new Error("Source not found");
    if (write && source.ownerNpub === "wingman-system" && owner !== "wingman-system") throw new Error("Wingman sources require administrator ownership");
    return source;
  }

  async fetch(owner: string, sourceId: string, allowedRoots: string[], canManageSystem: boolean) {
    const source = this.ownedSource(owner, sourceId, sourceId.length > 0 && !canManageSystem);
    const inspected = await this.importer.inspect(source, allowedRoots);
    try { return this.store.updateFetched(source.id, inspected.commit, inspected.digest, new Date().toISOString()); }
    finally { await inspected.cleanup(); }
  }

  async import(owner: string, sourceId: string, allowedRoots: string[], canManageSystem: boolean) {
    const source = this.ownedSource(owner, sourceId, !canManageSystem);
    const result = await this.importer.import(source, allowedRoots);
    if (result.revisions.some((revision) => revision.errors.length)) return { imported: false, revisions: result.revisions };
    this.store.insertRevisions(result.revisions);
    this.store.updateFetched(source.id, result.commit, result.digest, new Date().toISOString());
    return { imported: true, importId: result.revisions[0]!.importId, revisions: result.revisions };
  }

  activate(owner: string, sourceId: string, importId: string, canManageSystem: boolean) {
    const source = this.ownedSource(owner, sourceId, !canManageSystem);
    const revision = this.store.listRevisions(owner).find((candidate) => candidate.sourceId === source.id && candidate.importId === importId);
    if (!revision) throw new Error("Imported revision not found");
    this.store.activate(source.id, importId, new Date().toISOString());
    return this.list(owner);
  }

  getProject(owner: string, projectId: string) {
    const project = this.projects.getById(projectId);
    if (!project || project.npub !== owner) throw new Error("Project not found");
    return project;
  }

  putPolicy(owner: string, projectId: string, input: Partial<SkillProjectPolicy>) {
    this.getProject(owner, projectId);
    const current = this.store.getPolicy(owner, projectId);
    return this.store.putPolicy({ ...current, claudeCompatibility: input.claudeCompatibility ?? current.claudeCompatibility, repositoryPolicy: input.repositoryPolicy ?? current.repositoryPolicy, defaultOptOuts: input.defaultOptOuts ?? current.defaultOptOuts, updatedAt: new Date().toISOString() });
  }

  async registerProject(owner: string, directory: string, name: string | undefined, roots: string[]) {
    const target = await resolveAuthorizedDirectory(directory, roots);
    const project = this.projects.createProject(owner, target, name);
    if (!project) throw new Error("Project already exists for this directory");
    return project;
  }

  async plan(owner: string, input: { action: SkillPlanOperation["action"]; projectIds: string[]; skillIds?: string[]; revisionId?: string; deploymentName?: string; resolution?: SkillPlanOperation["resolution"] }, roots: string[]) {
    if (!["apply", "update", "remove", "detach", "reconcile"].includes(input.action)) throw new Error("Invalid deployment action");
    const catalog = this.store.listActiveCatalog(owner);
    const operations: SkillPlanOperation[] = [];
    for (const projectId of input.projectIds) {
      const project = this.getProject(owner, projectId);
      const targetDirectory = await resolveAuthorizedDirectory(project.directoryPath, roots);
      const policy = this.store.getPolicy(owner, project.id);
      const selected = input.action === "reconcile"
        ? catalog.filter((revision) => this.store.getSource(revision.sourceId)?.defaultEnabled && !policy.defaultOptOuts.includes(revision.skillId))
        : catalog.filter((revision) => input.skillIds?.includes(revision.skillId) || revision.id === input.revisionId);
      const deploymentCandidates = input.action === "remove" || input.action === "detach" ? this.store.listDeployments(owner).filter((d) => d.projectId === project.id && input.skillIds?.includes(d.skillId)) : [];
      for (const candidate of [...selected, ...deploymentCandidates]) {
        const skillId = "skillId" in candidate ? candidate.skillId : "";
        const revision = "contentDigest" in candidate ? candidate : catalog.find((entry) => entry.skillId === skillId);
        const deployment = this.store.getDeployment(owner, project.id, skillId);
        const name = input.deploymentName || revision?.name || deployment?.deploymentName || basename(skillId);
        const destination = join(targetDirectory, ".agents", "skills", name);
        let state: SkillPlanOperation["state"] = "current";
        let reason = "Already current";
        try {
          const currentDigest = (await digestDirectory(destination)).digest;
          if (!deployment) { state = "conflict"; reason = "Destination exists but is unmanaged"; }
          else if (currentDigest !== deployment.installedDigest) { state = "locally_modified"; reason = "Managed files differ from the installed digest"; }
          else if (revision && deployment.revisionId !== revision.id) { state = "update_available"; reason = "A newer active revision is available"; }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") { state = "missing"; reason = deployment ? "Managed deployment is missing" : "Safe to install"; }
          else { state = "error"; reason = (error as Error).message; }
        }
        operations.push({ action: input.action, projectId, targetDirectory, skillId, revisionId: revision?.id ?? deployment?.revisionId ?? null, deploymentName: name, claudeCompatibility: policy.claudeCompatibility, repositoryPolicy: policy.repositoryPolicy, resolution: input.resolution ?? null, state, reason });
      }
    }
    const expiresAt = Date.now() + 10 * 60_000;
    const id = randomUUID();
    this.plans.set(id, { ownerNpub: owner, expiresAt, operations });
    return { token: this.signPlan(id), expiresAt: new Date(expiresAt).toISOString(), operations };
  }

  async apply(owner: string, token: string) {
    const plan = this.consumePlan(owner, token);
    const results = [];
    for (const operation of plan.operations) {
      try { results.push({ operation, ok: true, deployment: await this.applyOperation(owner, operation) }); }
      catch (error) { results.push({ operation, ok: false, error: (error as Error).message }); }
    }
    return { results };
  }

  async reconcileState(owner: string) {
    const deployments = this.store.listDeployments(owner);
    for (const deployment of deployments) {
      let state: SkillDeploymentRecord["state"] = "current";
      try {
        const digest = (await digestDirectory(join(deployment.targetDirectory, ".agents", "skills", deployment.deploymentName))).digest;
        if (digest !== deployment.installedDigest) state = "locally_modified";
        const active = this.store.listActiveCatalog(owner).find((revision) => revision.skillId === deployment.skillId);
        if (state === "current" && active && active.id !== deployment.revisionId) state = "update_available";
      } catch (error) { state = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error"; }
      this.store.upsertDeployment({ ...deployment, state, checkedAt: new Date().toISOString() });
    }
    return this.list(owner);
  }

  async resolvedRevisions(owner: string, directory: string) {
    let target = directory;
    try { target = await realpath(directory); } catch { /* unresolved directories have no managed revisions */ }
    return this.store.listDeployments(owner).filter((deployment) => deployment.targetDirectory === target && deployment.state === "current").map(({ skillId, revisionId, installedDigest }) => ({ skillId, revisionId, digest: installedDigest }));
  }

  async reconcileDefaultsBeforeLaunch(owner: string, directory: string, roots: string[]) {
    const known = this.projects.getByPath?.(owner, directory);
    if (!known) return await this.resolvedRevisions(owner, directory);
    const plan = await this.plan(owner, { action: "reconcile", projectIds: [known.id] }, roots);
    const safeOperations = plan.operations.filter((operation) => operation.state === "missing" || operation.state === "update_available" || operation.state === "current");
    if (safeOperations.some((operation) => operation.state !== "current")) {
      const id = plan.token.split(".")[0]!;
      const stored = this.plans.get(id);
      if (stored) stored.operations = safeOperations.filter((operation) => operation.state !== "current");
      await this.apply(owner, plan.token);
    }
    return await this.resolvedRevisions(owner, directory);
  }

  private async applyOperation(owner: string, operation: SkillPlanOperation) {
    const existing = this.store.getDeployment(owner, operation.projectId, operation.skillId);
    const destination = join(operation.targetDirectory, ".agents", "skills", operation.deploymentName);
    if (operation.action === "detach") { this.store.deleteDeployment(owner, operation.projectId, operation.skillId); await this.writeManifest(owner, operation.targetDirectory); return null; }
    if (operation.action === "remove") {
      if (!existing) throw new Error("Managed deployment not found");
      const digest = (await digestDirectory(destination)).digest;
      if (digest !== existing.installedDigest) throw new Error("Refusing to remove locally modified content");
      if (existing.claudeCompatibility) {
        const claudeDigest = (await digestDirectory(join(operation.targetDirectory, ".claude", "skills", operation.deploymentName))).digest;
        if (claudeDigest !== existing.installedDigest) throw new Error("Refusing to remove locally modified Claude compatibility content");
      }
      await rm(destination, { recursive: true });
      if (existing.claudeCompatibility) await rm(join(operation.targetDirectory, ".claude", "skills", operation.deploymentName), { recursive: true, force: true });
      this.store.deleteDeployment(owner, operation.projectId, operation.skillId);
      await this.writeManifest(owner, operation.targetDirectory);
      return null;
    }
    if (["conflict", "locally_modified"].includes(operation.state) && operation.resolution !== "replace") throw new Error(`Refusing unsafe ${operation.state} deployment without replace resolution`);
    if (!operation.revisionId) throw new Error("Revision is required");
    const revision = this.store.getRevision(operation.revisionId);
    if (!revision || revision.skillId !== operation.skillId) throw new Error("Revision changed; create a new plan");
    await atomicCopy(revision.snapshotPath, destination);
    if (operation.claudeCompatibility) await atomicCopy(revision.snapshotPath, join(operation.targetDirectory, ".claude", "skills", operation.deploymentName));
    const now = new Date().toISOString();
    const record = this.store.upsertDeployment({ id: existing?.id ?? randomUUID(), ownerNpub: owner, projectId: operation.projectId, targetDirectory: operation.targetDirectory, skillId: operation.skillId, revisionId: revision.id, deploymentName: operation.deploymentName, installedDigest: revision.contentDigest, portable: true, claudeCompatibility: operation.claudeCompatibility, repositoryPolicy: operation.repositoryPolicy, state: "current", installedAt: existing?.installedAt ?? now, updatedAt: now, checkedAt: now, lastResult: operation.action });
    await this.writeManifest(owner, operation.targetDirectory);
    if (operation.repositoryPolicy === "local_managed") await appendGitExclude(operation.targetDirectory, [`.agents/skills/${operation.deploymentName}/`, ".agents/skills/.wingman-managed.json", ...(operation.claudeCompatibility ? [`.claude/skills/${operation.deploymentName}/`] : [])]);
    return record;
  }

  private async writeManifest(owner: string, target: string) {
    const records = this.store.listDeployments(owner).filter((deployment) => deployment.targetDirectory === target);
    const path = join(target, ".agents", "skills", ".wingman-managed.json");
    await mkdir(join(target, ".agents", "skills"), { recursive: true });
    await writeFile(path, `${JSON.stringify({ version: 1, deployments: Object.fromEntries(records.map((record) => [record.deploymentName, { skillId: record.skillId, revisionId: record.revisionId, digest: record.installedDigest, installedAt: record.installedAt, updatedAt: record.updatedAt }])) }, null, 2)}\n`, { mode: 0o600 });
  }

  private signPlan(id: string) { return `${id}.${createHash("sha256").update(this.planSecret).update(id).digest("hex")}`; }
  private consumePlan(owner: string, token: string) {
    const [id, signature] = token.split(".");
    if (!id || !signature) throw new Error("Invalid plan token");
    const expected = this.signPlan(id).split(".")[1]!;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("Invalid plan token");
    const plan = this.plans.get(id);
    this.plans.delete(id);
    if (!plan || plan.ownerNpub !== owner || plan.expiresAt < Date.now()) throw new Error("Plan is missing, stale, or belongs to another owner");
    return plan;
  }
}

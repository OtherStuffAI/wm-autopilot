import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SkillManager } from "./skill-manager";
import { SkillSourceImporter } from "./source-importer";
import { SkillStore } from "./skill-store";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wingman-skills-test-")); roots.push(root);
  const source = join(root, "source", "example-skill");
  const projectPath = join(root, "project");
  await mkdir(source, { recursive: true }); await mkdir(projectPath);
  await writeFile(join(source, "SKILL.md"), "---\nname: example-skill\ndescription: Safe example\n---\n\nInstructions.\n");
  const project = { id: "project-1", npub: "npub-owner", directoryPath: projectPath, name: "Project" };
  const projects = { getById: (id: string) => id === project.id ? project : null, getByPath: (owner: string, path: string) => owner === project.npub && path === projectPath ? project : null, createProject: () => null };
  const store = new SkillStore(join(root, "skills.sqlite"));
  const manager = new SkillManager(store, projects, new SkillSourceImporter(join(root, "snapshots")));
  return { root, source: join(root, "source"), project, store, manager };
}

describe("SkillManager", () => {
  test("registers, imports, and activates atomically on first use", async () => {
    const { root, source, store, manager } = await fixture();
    const result = await manager.registerImportAndActivate("npub-owner", { name: "Example", sourceClass: "user", sourceKind: "local", location: source }, [root], false);
    expect(result.imported).toBe(true);
    expect(result.source?.activeImportId).toBe(result.importId);
    expect(manager.list("npub-owner").catalog).toHaveLength(1);

    await writeFile(join(source, "example-skill", "SKILL.md"), "Missing frontmatter\n");
    await expect(manager.registerImportAndActivate("npub-owner", { name: "Broken", sourceClass: "user", sourceKind: "local", location: source }, [root], false)).rejects.toThrow("SKILL.md requires YAML frontmatter");
    expect(store.listSources("npub-owner").map((entry) => entry.name)).toEqual(["Example"]);
  });

  test("imports immutable validated revisions and atomically deploys provenance", async () => {
    const { root, source, project, manager } = await fixture();
    const registered = manager.registerSource("npub-owner", { name: "Example", sourceClass: "user", sourceKind: "local", location: source }, false);
    const imported = await manager.import("npub-owner", registered.id, [root], false);
    expect(imported.imported).toBe(true);
    manager.activate("npub-owner", registered.id, imported.importId!, false);
    const skill = manager.list("npub-owner").catalog[0]!;
    const plan = await manager.plan("npub-owner", { action: "apply", projectIds: [project.id], skillIds: [skill.skillId] }, [root]);
    expect(plan.operations[0]?.state).toBe("missing");
    const result = await manager.apply("npub-owner", plan.token);
    expect(result.results[0]?.ok).toBe(true);
    expect(await readFile(join(project.directoryPath, ".agents/skills/example-skill/SKILL.md"), "utf8")).toContain("Safe example");
    const manifest = JSON.parse(await readFile(join(project.directoryPath, ".agents/skills/.wingman-managed.json"), "utf8"));
    expect(manifest.deployments["example-skill"].revisionId).toBe(skill.id);
    expect(await manager.resolvedRevisions("npub-owner", project.directoryPath)).toEqual([{ skillId: skill.skillId, revisionId: skill.id, digest: skill.contentDigest }]);
  });

  test("refuses unmanaged and locally modified content unless replace is explicitly planned", async () => {
    const { root, source, project, manager } = await fixture();
    const registered = manager.registerSource("npub-owner", { name: "Example", sourceClass: "user", sourceKind: "local", location: source }, false);
    const imported = await manager.import("npub-owner", registered.id, [root], false); manager.activate("npub-owner", registered.id, imported.importId!, false);
    const skill = manager.list("npub-owner").catalog[0]!;
    await mkdir(join(project.directoryPath, ".agents/skills/example-skill"), { recursive: true });
    await writeFile(join(project.directoryPath, ".agents/skills/example-skill/unmanaged.txt"), "mine");
    const plan = await manager.plan("npub-owner", { action: "apply", projectIds: [project.id], skillIds: [skill.skillId] }, [root]);
    expect(plan.operations[0]?.state).toBe("conflict");
    expect((await manager.apply("npub-owner", plan.token)).results[0]?.ok).toBe(false);
  });

  test("rejects source symlinks and cross-owner projects", async () => {
    const { root, source, manager } = await fixture();
    await symlink("/tmp", join(source, "escape"));
    const registered = manager.registerSource("npub-owner", { name: "Example", sourceClass: "user", sourceKind: "local", location: source }, false);
    await expect(manager.import("npub-owner", registered.id, [root], false)).rejects.toThrow("Symbolic link is not allowed in canonical skill content: escape");
    await expect(manager.plan("npub-other", { action: "apply", projectIds: ["project-1"], skillIds: [] }, [root])).rejects.toThrow("Project not found");
  });

  test("binds one-use plan tokens to their owner", async () => {
    const { root, project, manager } = await fixture();
    const plan = await manager.plan("npub-owner", { action: "reconcile", projectIds: [project.id] }, [root]);
    await expect(manager.apply("npub-other", plan.token)).rejects.toThrow("another owner");
    await expect(manager.apply("npub-owner", plan.token)).rejects.toThrow("missing");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestDirectory, discoverSkills } from "./skill-content";
import type { SkillSourceRecord } from "./types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-content-test-"));
  roots.push(root);
  await mkdir(join(root, "brag", "references"), { recursive: true });
  await writeFile(join(root, "brag", "SKILL.md"), "---\nname: brag\ndescription: Build retrieval augmented generation systems\n---\n# Brag\n");
  await writeFile(join(root, "brag", "references", "guide.md"), "Canonical content\n");
  await mkdir(join(root, ".opencode", "skills"), { recursive: true });
  await symlink("../../brag", join(root, ".opencode", "skills", "brag"));
  return root;
};

const source = (): SkillSourceRecord => ({
  id: "source-brag", ownerNpub: "owner", name: "Brag", sourceClass: "third_party", sourceKind: "git",
  location: "https://example.invalid/brag.git", ref: null, fetchedCommit: "abc123", fetchedDigest: null,
  fetchedAt: null, activeImportId: null, trustState: "operator_imported", defaultEnabled: false,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
});

describe("skill content symlink policy", () => {
  test("imports one canonical skill while ignoring an in-root harness alias", async () => {
    const root = await fixture();
    const first = await digestDirectory(root);
    const second = await digestDirectory(root);
    const revisions = await discoverSkills(root, source(), join(root, "snapshots"));
    expect(first).toEqual(second);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.name).toBe("brag");
    expect(revisions[0]?.relativePath).toBe("brag");
    expect(revisions[0]?.files).toEqual(["references/guide.md", "SKILL.md"]);
  });

  test("rejects a compatibility alias that escapes the checkout", async () => {
    const root = await fixture();
    await rm(join(root, ".opencode", "skills", "brag"));
    await symlink(tmpdir(), join(root, ".opencode", "skills", "brag"));
    await expect(digestDirectory(root)).rejects.toThrow("Compatibility alias escapes the source checkout: .opencode/skills/brag");
  });

  test("rejects cyclic aliases and links inside canonical skill content", async () => {
    const root = await fixture();
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await symlink("cycle", join(root, ".claude", "skills", "cycle"));
    await expect(digestDirectory(root)).rejects.toThrow("Compatibility alias is broken or cyclic: .claude/skills/cycle");
    await rm(join(root, ".claude"), { recursive: true, force: true });
    await symlink("SKILL.md", join(root, "brag", "linked.md"));
    await expect(digestDirectory(root)).rejects.toThrow("Symbolic link is not allowed in canonical skill content: brag/linked.md");
  });
});

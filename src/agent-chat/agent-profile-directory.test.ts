import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAgentProfileDirectory } from "./agent-profile-directory";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bot-directory-"));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("bot working folder", () => {
  test("creates missing parent folders after validation and validates the result", async () => {
    const root = await fixture();
    const target = join(root, "new", "bot");
    const checked: string[] = [];
    await prepareAgentProfileDirectory(target, async (path) => { checked.push(path); return path; });
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(checked).toEqual([root, target]);
  });
  test("keeps existing files and refuses file paths", async () => {
    const root = await fixture();
    const file = join(root, "keep.txt");
    await writeFile(file, "keep");
    await prepareAgentProfileDirectory(root);
    expect(await readFile(file, "utf8")).toBe("keep");
    await expect(prepareAgentProfileDirectory(file)).rejects.toThrow("not a directory");
    await expect(prepareAgentProfileDirectory("relative/bot")).rejects.toThrow("absolute path");
  });
  test("does not create folders when workspace policy rejects the ancestor", async () => {
    const root = await fixture();
    const target = join(root, "denied", "bot");
    await expect(prepareAgentProfileDirectory(target, async () => { throw new Error("Outside allowed directories"); })).rejects.toThrow("Outside allowed");
    expect(await stat(join(root, "denied")).catch(() => null)).toBeNull();
  });
  test("surfaces filesystem permission errors", async () => {
    const root = await fixture();
    await chmod(root, 0o500);
    try {
      await expect(prepareAgentProfileDirectory(join(root, "bot"))).rejects.toThrow("Permission denied");
    } finally { await chmod(root, 0o700); }
  });
  test("validates symlink ancestors before creating inside them", async () => {
    const root = await fixture();
    const outside = await fixture();
    const link = join(root, "link");
    await symlink(outside, link);
    await expect(prepareAgentProfileDirectory(join(link, "bot"), async () => { throw new Error("Outside allowed directories"); })).rejects.toThrow("Outside allowed");
    expect(await stat(join(outside, "bot")).catch(() => null)).toBeNull();
  });
});

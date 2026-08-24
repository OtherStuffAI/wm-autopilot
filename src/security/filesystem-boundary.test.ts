import { afterEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeFilesystemPath,
  openAuthorizedFile,
  resolveSessionTargetFile,
  resolveStoredSessionTargetFile,
} from "./filesystem-boundary";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "wingman-filesystem-boundary-"));
  roots.push(base);
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");
  return { base, workspace, outside };
}

describe("filesystem boundary", () => {
  test("rejects file, directory, final, and broken symlink escapes", async () => {
    const { workspace, outside } = await fixture();
    await symlink(join(outside, "secret.txt"), join(workspace, "file-link"));
    await symlink(outside, join(workspace, "directory-link"));
    await symlink(join(outside, "missing.txt"), join(workspace, "broken-link"));

    for (const input of ["file-link", "directory-link/secret.txt", "broken-link"]) {
      expect(authorizeFilesystemPath({ root: workspace, input, policy: "existing" })).rejects.toThrow();
    }
    await expect(authorizeFilesystemPath({ root: workspace, input: "broken-link", policy: "create" }))
      .rejects.toThrow("Symbolic links");
  });

  test("accepts safe Unicode creation and rejects traversal and prefix collisions", async () => {
    const { base, workspace } = await fixture();
    await mkdir(join(workspace, "資料"));
    expect(await authorizeFilesystemPath({ root: workspace, input: "資料/計画.md", policy: "create" }))
      .toBe(join(workspace, "資料", "計画.md"));
    await expect(authorizeFilesystemPath({ root: workspace, input: "../outside/secret.txt", policy: "existing" }))
      .rejects.toThrow();
    await expect(authorizeFilesystemPath({ root: workspace, input: join(base, "workspace-other"), policy: "create" }))
      .rejects.toThrow();
  });

  test("rejects absolute session targets and accepts contained relative targets", async () => {
    const { workspace, outside } = await fixture();
    await expect(resolveSessionTargetFile(workspace, join(outside, "secret.txt"))).rejects.toThrow("Absolute");
    await expect(resolveSessionTargetFile(workspace, "../outside/secret.txt")).rejects.toThrow();
    expect(await resolveSessionTargetFile(workspace, "notes/draft.md")).toBe(join(workspace, "notes", "draft.md"));
    expect(await resolveStoredSessionTargetFile(workspace, join(workspace, "notes", "draft.md")))
      .toBe(join(workspace, "notes", "draft.md"));
    await expect(resolveStoredSessionTargetFile(workspace, join(outside, "secret.txt"))).rejects.toThrow();
  });

  test("descriptor identity check fails closed after a final-link swap", async () => {
    const { workspace, outside } = await fixture();
    const target = join(workspace, "note.txt");
    await writeFile(target, "safe");
    await rm(target);
    await symlink(join(outside, "secret.txt"), target);
    await expect(openAuthorizedFile({ root: workspace, input: target, flags: constants.O_RDONLY }))
      .rejects.toThrow();
  });
});

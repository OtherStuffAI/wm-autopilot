import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson, verifyEvidencePath, withRunLock } from "./storage.ts";

test("ignored/untracked storage and occupied legacy lock are verified without expiry", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "consolidation-test-"));
  try {
    await Bun.$`git -C ${root} init -q`.quiet();
    await writeFile(join(root, ".gitignore"), "evidence/\n");
    const evidence = join(root, "evidence");
    await mkdir(evidence);
    const state = join(evidence, "state.json");
    await verifyEvidencePath(state);
    await atomicJson(state, { checkpoint: "old" });
    await withRunLock(evidence, "this-run", async () => {
      await expect(withRunLock(evidence, "other-run", async () => {})).rejects.toThrow("occupied");
      await atomicJson(state, { checkpoint: "new" });
    });
    expect(JSON.parse(await readFile(state, "utf8")).checkpoint).toBe("new");
    await mkdir(join(evidence, "lock"));
    await writeFile(join(evidence, "lock", "owner.json"), JSON.stringify({ session_id: "legacy-owner" }));
    await expect(withRunLock(evidence, "this-run", async () => {})).rejects.toThrow("occupied");
    expect(JSON.parse(await readFile(join(evidence, "lock", "owner.json"), "utf8")).session_id).toBe("legacy-owner");
    await expect(verifyEvidencePath(join(root, "public.json"))).rejects.toThrow("ignored");
    await symlink(state, join(evidence, "link.json"));
    await expect(atomicJson(join(evidence, "link.json"), {})).rejects.toThrow("Symlink");
    await Bun.$`git -C ${root} add -f ${state}`.quiet();
    await expect(verifyEvidencePath(state)).rejects.toThrow("ignored and untracked");
  } finally { await rm(root, { recursive: true, force: true }); }
});

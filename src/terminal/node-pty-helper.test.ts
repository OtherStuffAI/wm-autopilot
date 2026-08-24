import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureExecutableBit } from "./node-pty-helper";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("node-pty helper permissions", () => {
  test("adds executable bits when helper is installed without them", async () => {
    const root = join(tmpdir(), `wingman-pty-helper-${crypto.randomUUID()}`);
    tempRoots.push(root);
    await mkdir(root, { recursive: true });
    const helperPath = join(root, "spawn-helper");
    await writeFile(helperPath, "#!/bin/sh\n");
    await chmod(helperPath, 0o644);

    await ensureExecutableBit(helperPath);

    const info = await stat(helperPath);
    expect((info.mode & 0o111) !== 0).toBe(true);
  });
});

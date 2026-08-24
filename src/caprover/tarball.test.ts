import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppTarball } from "./tarball";

const dirs: string[] = [];

async function tempApp() {
  const dir = await mkdtemp(join(tmpdir(), "caprover-tarball-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createAppTarball", () => {
  test("force-includes explicitly listed seed files while excluding sqlite files by default", async () => {
    const root = await tempApp();
    await mkdir(join(root, "deploy-seed"), { recursive: true });
    await mkdir(join(root, "server"), { recursive: true });
    await writeFile(join(root, "captain-definition"), JSON.stringify({ schemaVersion: 2 }));
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
    await writeFile(join(root, ".gitignore"), "deploy-seed/*.seed\n");
    await writeFile(join(root, ".caproverinclude"), "deploy-seed/census-db.seed\n");
    await writeFile(join(root, "deploy-seed", "census-db.seed"), "seed");
    await writeFile(join(root, "server", "local.sqlite"), "db");

    const result = await createAppTarball(root);

    expect(result.files).toContain("deploy-seed/census-db.seed");
    expect(result.files).not.toContain("server/local.sqlite");
  });
});

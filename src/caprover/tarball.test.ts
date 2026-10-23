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
  test("excludes trailing-slash private directories without excluding similarly named source", async () => {
    const root = await tempApp();
    await writeFile(join(root, "captain-definition"), JSON.stringify({ schemaVersion: 2 }));
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
    await writeFile(join(root, ".gitignore"), "tmp/\n/public/uploads/\ncache/\n");
    for (const directory of ["tmp/docs/handoffs", "server/tmp", "public/uploads", "server/cache", "temporary"]) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, "note.txt"), "fixture");
    }
    await writeFile(join(root, "public", "tmp-logo.svg"), "source");
    await writeFile(join(root, "cache"), "source file, not a directory");

    const result = await createAppTarball(root);

    expect(result.files).not.toContain("tmp/docs/handoffs/note.txt");
    expect(result.files).not.toContain("server/tmp/note.txt");
    expect(result.files).not.toContain("public/uploads/note.txt");
    expect(result.files).not.toContain("server/cache/note.txt");
    expect(result.files).toContain("temporary/note.txt");
    expect(result.files).toContain("public/tmp-logo.svg");
    expect(result.files).toContain("cache");
  });

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

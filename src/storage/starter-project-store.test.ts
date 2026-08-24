import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { StarterProjectStore } from "./starter-project-store";

const tempDirs: string[] = [];

async function createStore(): Promise<{ store: StarterProjectStore; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "starter-project-store-"));
  tempDirs.push(dir);
  const filePath = join(dir, "wingman.db");
  return { store: new StarterProjectStore(filePath), filePath };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("StarterProjectStore", () => {
  test("starts without implicit external starter repositories", async () => {
    const { store } = await createStore();

    expect(store.list()).toEqual([]);
  });

  test("removes legacy Speedrun default starter records on startup", async () => {
    const { store, filePath } = await createStore();
    store.create({
      name: "Speedrun Lite Agent",
      gitUrl: "https://git.example.invalid/example/speedrun-lite-agent-starter.git",
    });

    const restartedStore = new StarterProjectStore(filePath);

    expect(restartedStore.list()).toEqual([]);
  });
});

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { change, pagePayload } from "./record-sync-fixture.test-helper.ts";

test("source catch-up exits on sync certification then source review continues across CLI processes", () => {
  const root = mkdtempSync(join(tmpdir(), "heartbeat-review-cli-"));
  const preload = join(root, "mock.ts");
  const output = join(root, "evidence.json");
  const pages = [
    pagePayload(
      Array.from({ length: 200 }, (_, i) =>
        change(`task-${i}`, "task", "1", { state: "ready" }),
      ),
      false,
      { snapshot_complete: false },
    ),
    pagePayload([change("task-200", "task", "1", { state: "ready" })]),
    pagePayload([], true),
  ];
  try {
    writeFileSync(
      preload,
      `import { fixture } from ${JSON.stringify(join(import.meta.dir, "record-sync-fixture.test-helper.ts"))};
      import { rmSync } from "node:fs";
      const f = fixture(${JSON.stringify(pages)});
      process.on("exit", () => rmSync(f.cacheRoot, { recursive: true, force: true }));
      globalThis.fetch = (input, init) => {
        if (process.argv.includes("--review-only") && String(input).includes("tower.test")) throw new Error("Review continuation attempted live sync");
        return f.context.fetch(input, init);
      };`,
    );
    const cli = (args: string[]) =>
      spawnSync(
        "bun",
        [
          "--preload",
          preload,
          "clis/heartbeat-wake.ts",
          "--workspace",
          "workspace",
          "--tower-url",
          "https://tower.test",
          "--app-npub",
          "app",
          "--cache-dir",
          join(root, "cache"),
          "--output",
          output,
          ...args,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            WINGMAN_BROKER_URL: "https://broker.test",
            SESSION_ID: "source-review-cli-fixture",
            WINGMAN_CAPABILITY: "fixture",
          },
        },
      );
    const caught = cli(["--catch-up", "--max-pages", "1", "--max-wakes", "5"]);
    expect(caught.status).toBe(0);
    const lines = caught.stdout
      .trim()
      .split("\n")
      .map((v) => JSON.parse(v));
    expect(lines.at(-1)).toEqual({ outcome: "certified", wakes: 3 });
    const sync = JSON.parse(readFileSync(output, "utf8"));
    expect(sync.syncComplete).toBe(true);
    expect(sync.review.started).toBe(false);
    expect(sync.coverage.downloadedCounts.task).toBe(201);
    const first = cli(["--review-only"]);
    expect(first.status).toBe(2);
    const page = JSON.parse(readFileSync(output, "utf8"));
    expect(page.workspaces[0].review.length).toBe(200);
    const last = cli([
      "--review-only",
      "--review-cursor",
      page.review.nextCursor,
    ]);
    expect(last.status).toBe(0);
    const end = JSON.parse(readFileSync(output, "utf8"));
    expect(end.review.delivered).toBe(201);
    expect(end.review.nextCursor).toBeNull();
    expect(end.workspaces[0].review.length).toBe(1);
    expect(end.cache.clientId).toBe(sync.cache.clientId);
    expect(end.coverage.observation).toBe("pinned-cache-review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverClaudeModels, discoverCodexModels } from "./harness-model-discovery";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-models-test-"));
  roots.push(root);
  return root;
}

function claudeCatalog(fetchedAt: number, models: unknown[]) {
  return JSON.stringify({ version: 2, fetchedAt, catalog: { surface: "cc", config: { id: "cc", models }, state: {} } });
}

describe("Codex model discovery", () => {
  test("returns listed models in CLI order and skips hidden ones", async () => {
    const home = tempDir();
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({
      fetched_at: "2026-10-08T05:02:22Z",
      models: [
        { slug: "gpt-6.1-sol", visibility: "list" },
        { slug: "gpt-reserve", visibility: "hide" },
        { slug: "gpt-5.6-luna", visibility: "list" },
        { slug: "codex-auto-review", visibility: "hide" },
      ],
    }));
    expect(await discoverCodexModels({ CODEX_HOME: home })).toEqual({
      harness: "codex",
      models: ["gpt-6.1-sol", "gpt-5.6-luna"],
      source: join(home, "models_cache.json"),
      fetchedAt: "2026-10-08T05:02:22Z",
    });
  });

  test("fails loudly when the cache is missing or malformed", async () => {
    const home = tempDir();
    await expect(discoverCodexModels({ CODEX_HOME: home })).rejects.toThrow("Codex model cache not found");
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "x", visibility: "hide" }] }));
    await expect(discoverCodexModels({ CODEX_HOME: home })).rejects.toThrow("No selectable models");
  });
});

describe("Claude Code model discovery", () => {
  test("uses the newest account catalogue with main models first", async () => {
    const configDir = tempDir();
    const catalogDir = join(configDir, "cache", "model-catalog");
    mkdirSync(catalogDir, { recursive: true });
    writeFileSync(join(catalogDir, "older-cc.json"), claudeCatalog(1, [{ id: "claude-opus-4-8", section: "main" }]));
    writeFileSync(join(catalogDir, "published-abc.json"), JSON.stringify({ fetchedAt: 99, document: {} }));
    writeFileSync(join(catalogDir, "tok-cc.json"), claudeCatalog(1791436623340, [
      { id: "claude-opus-5-5", section: "main" },
      { id: "claude-sonnet-5", section: "overflow" },
      { id: "claude-fable-5-1", section: "main" },
      { id: "claude-secret", section: "main", hidden: true },
      { id: "claude-haiku-5-5", section: "main" },
    ]));
    const discovered = await discoverClaudeModels({ CLAUDE_CONFIG_DIR: configDir });
    expect(discovered.models).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-haiku-5-5", "claude-sonnet-5"]);
    expect(discovered.source).toBe(join(catalogDir, "tok-cc.json"));
    expect(discovered.fetchedAt).toBe(new Date(1791436623340).toISOString());
  });

  test("explains when Claude Code has not cached a catalogue yet", async () => {
    await expect(discoverClaudeModels({ CLAUDE_CONFIG_DIR: tempDir() })).rejects.toThrow("start Claude Code once");
  });
});

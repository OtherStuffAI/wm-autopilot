import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPipelineFunctionRegistry } from "./function-loader";
import { builtinPipelineFunctions } from "./functions";

let dir: string;
let previous: string | undefined;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bird-hot-")); previous = process.env.WINGMEN_PIPELINES_ROOT; process.env.WINGMEN_PIPELINES_ROOT = join(dir, "pipelines"); });
afterEach(() => { if (previous === undefined) delete process.env.WINGMEN_PIPELINES_ROOT; else process.env.WINGMEN_PIPELINES_ROOT = previous; rmSync(dir, { recursive: true, force: true }); });

test("Bird core functions load beside a legacy statically cached registry and reload helpers without restart", async () => {
  const source = join(import.meta.dir, "runtime-functions");
  const core = join(dir, "runtime-functions"); mkdirSync(core, { recursive: true });
  for (const file of ["bird-prepare.ts", "bird-execute-decision.ts"]) writeFileSync(join(core, file), readFileSync(join(source, file)));
  for (const file of ["bird-retrieval.ts", "bird-adapter.ts"]) writeFileSync(join(dir, file), readFileSync(join(import.meta.dir, file)));
  const helper = join(import.meta.dir, "hot-runtime-module.ts");
  // Keep the actual fresh importer implementation; copy Bird code into an isolated editable graph.
  for (const file of ["bird-prepare.ts", "bird-execute-decision.ts"]) {
    const path = join(core, file); writeFileSync(path, readFileSync(path, "utf8").replace('"../hot-runtime-module"', JSON.stringify(helper)));
  }
  const legacy = { ...builtinPipelineFunctions, "bird.prepare": () => ({ stale: true }) };
  const first = await loadPipelineFunctionRegistry(null, legacy, { coreFunctionsDirectory: core });
  expect(first.records.filter(record => record.name.startsWith("bird.")).map(record => record.status)).toEqual(["ok", "ok", "ok"]);
  expect(await first.registry["bird.prepare.v1"]!({ request: "Get 2 following tweets" })).toMatchObject({ count: 2 });
  const originalHash = first.records.find(record => record.name === "bird.prepare.v1")!.hash;
  // Entry logic edit and helper policy edit are both visible on the next load in this process.
  const entry = join(core, "bird-prepare.ts");
  writeFileSync(entry, readFileSync(entry, "utf8").replace("export default bird.prepareBirdRetrieval;", 'export default input => ({ ...bird.prepareBirdRetrieval(input), entryRevision: 2 });'));
  const policy = join(dir, "bird-retrieval.ts");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("counts[0] ?? 20", "counts[0] ?? 17"));
  const second = await loadPipelineFunctionRegistry(null, legacy, { coreFunctionsDirectory: core });
  expect(await second.registry["bird.prepare.v1"]!({ request: "Get following tweets" })).toMatchObject({ count: 17, entryRevision: 2 });
  expect(second.records.find(record => record.name === "bird.prepare.v1")!.hash).not.toBe(originalHash);
  // Adapter edit, not just policy/entry edit, changes its bundled execution graph hash.
  const executionHash = second.records.find(record => record.name === "bird.executeDecision.v1")!.hash;
  const adapter = join(dir, "bird-adapter.ts");
  writeFileSync(adapter, readFileSync(adapter, "utf8").replace('action.count < 1', 'action.count < 3'));
  const third = await loadPipelineFunctionRegistry(null, legacy, { coreFunctionsDirectory: core });
  expect(third.records.find(record => record.name === "bird.executeDecision.v1")!.hash).not.toBe(executionHash);
  const choice = (value: string, keys: string[]) => ({ type: "choice", choice: value, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, key === value ? 1 : 0])) });
  const state = await third.registry["bird.prepare.v1"]!({ request: "Get 2 following tweets" });
  const result = await third.registry["bird.executeDecision.v1"]!({ state, decision: { shadowStatus: "ok", advisoryOnly: true, authoritative: false,
    error: null, answers: { action: choice("following", ["following", "for_you", "user_tweets", "search", "mentions", "continue", "partial", "clarify"]),
      handle: choice("none", ["none", "c0", "c1", "c2", "c3"]), query: choice("none", ["none", "c0", "c1", "c2", "c3"]), supported: { type: "noul", noul: 1 } } } });
  expect(result).toMatchObject({ verdict: "blocked", reason: "invalid_count", attempt: 0 });
  const fourth = await loadPipelineFunctionRegistry(null, legacy, { coreFunctionsDirectory: core });
  expect(fourth.records.find(record => record.name === "bird.executeDecision.v1")!.hash).toBe(third.records.find(record => record.name === "bird.executeDecision.v1")!.hash);
});

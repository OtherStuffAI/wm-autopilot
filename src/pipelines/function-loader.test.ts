import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinPipelineFunctions } from "./functions";
import { loadPipelineFunctionRegistry } from "./function-loader";

let tempDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-function-loader-test-"));
  previousRoot = process.env.WINGMEN_PIPELINES_ROOT;
  process.env.WINGMEN_PIPELINES_ROOT = join(tempDir, "pipelines");
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.WINGMEN_PIPELINES_ROOT;
  else process.env.WINGMEN_PIPELINES_ROOT = previousRoot;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadPipelineFunctionRegistry", () => {
  test("loads user-defined functions from the pipeline root", async () => {
    const functionsDir = join(tempDir, "pipelines", "users", "alpha-beta-gamma", "functions");
    mkdirSync(functionsDir, { recursive: true });
    writeFileSync(join(functionsDir, "make-greeting.v1.ts"), `
export const name = "user.makeGreeting";
export const description = "Builds a greeting.";
export const version = 1;
export default async function run(input) {
  return { greeting: "Hello " + String(input.name || "there") };
}
`);

    const loaded = await loadPipelineFunctionRegistry("alpha-beta-gamma", builtinPipelineFunctions);

    expect(loaded.records.find((record) => record.name === "user.makeGreeting")).toMatchObject({
      status: "ok",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
    });
    await expect(loaded.registry["user.makeGreeting"]!({ name: "Example Operator" })).resolves.toEqual({ greeting: "Hello Example Operator" });
  });

  test("does not allow user functions to shadow built-ins", async () => {
    const functionsDir = join(tempDir, "pipelines", "users", "alpha-beta-gamma", "functions");
    mkdirSync(functionsDir, { recursive: true });
    writeFileSync(join(functionsDir, "shadow.v1.ts"), `
export const name = "text.normalise";
export default async function run() {
  return { text: "shadowed" };
}
`);

    const loaded = await loadPipelineFunctionRegistry("alpha-beta-gamma", builtinPipelineFunctions);
    const record = loaded.records.find((entry) => entry.path?.endsWith("shadow.v1.ts"));

    expect(record).toMatchObject({
      name: "text.normalise",
      status: "shadowed",
    });
    await expect(loaded.registry["text.normalise"]!({ text: "  Real Builtin  " })).resolves.toMatchObject({
      text: "Real Builtin",
    });
  });

  test("initialises the pipeline root as a git repository", async () => {
    await loadPipelineFunctionRegistry("alpha-beta-gamma", builtinPipelineFunctions);
    expect(existsSync(join(tempDir, "pipelines", ".git"))).toBe(true);
  });
});

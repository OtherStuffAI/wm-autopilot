import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { FunctionRegistry } from "./declarative";
import type { JsonObject, PipelineScope } from "./pipeline-store";
import {
  ensurePipelineDirectories,
  getSharedPipelineFunctionsDirectory,
  getUserPipelineFunctionsDirectory,
} from "./pipeline-loader";

export type PipelineFunctionStatus = "ok" | "error" | "shadowed";

export interface PipelineFunctionRecord {
  name: string;
  description: string;
  version: string | number | null;
  scope: PipelineScope | "builtin";
  ownerAlias: string | null;
  path: string | null;
  status: PipelineFunctionStatus;
  error: string | null;
  hash: string | null;
}

type UserFunctionModule = {
  default?: unknown;
  name?: unknown;
  description?: unknown;
  version?: unknown;
};

export async function loadPipelineFunctionRegistry(
  ownerAlias: string | null,
  builtinRegistry: FunctionRegistry,
): Promise<{ registry: FunctionRegistry; records: PipelineFunctionRecord[] }> {
  await ensurePipelineDirectories(ownerAlias);
  const registry: FunctionRegistry = { ...builtinRegistry };
  const records: PipelineFunctionRecord[] = Object.keys(builtinRegistry)
    .sort()
    .map((name) => ({
      name,
      description: "Built-in pipeline function",
      version: null,
      scope: "builtin",
      ownerAlias: null,
      path: null,
      status: "ok",
      error: null,
      hash: null,
    }));

  const sharedRecords = await loadFunctionDirectory({
    directory: getSharedPipelineFunctionsDirectory(),
    scope: "shared",
    ownerAlias: null,
    registry,
  });
  records.push(...sharedRecords);

  if (ownerAlias) {
    const userRecords = await loadFunctionDirectory({
      directory: getUserPipelineFunctionsDirectory(ownerAlias),
      scope: "user",
      ownerAlias,
      registry,
    });
    records.push(...userRecords);
  }

  return { registry, records };
}

async function loadFunctionDirectory(input: {
  directory: string;
  scope: PipelineScope;
  ownerAlias: string | null;
  registry: FunctionRegistry;
}): Promise<PipelineFunctionRecord[]> {
  if (!existsSync(input.directory)) return [];
  const entries = await readdir(input.directory, { withFileTypes: true });
  const records: PipelineFunctionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isFunctionModule(entry.name)) continue;
    const path = join(input.directory, entry.name);
    records.push(await loadFunctionFile({ ...input, path }));
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadFunctionFile(input: {
  path: string;
  scope: PipelineScope;
  ownerAlias: string | null;
  registry: FunctionRegistry;
}): Promise<PipelineFunctionRecord> {
  const fallbackName = `${input.scope}.${functionNameFromFilename(input.path)}`;
  let hash: string | null = null;
  try {
    const info = await stat(input.path);
    hash = createHash("sha256")
      .update(`${input.path}:${info.mtimeMs}:${info.size}`)
      .digest("hex")
      .slice(0, 16);
    const mod = await import(`${pathToFileURL(input.path).href}?pipelineFunction=${hash}`) as UserFunctionModule;
    const name = typeof mod.name === "string" && mod.name.trim() ? mod.name.trim() : fallbackName;
    const description = typeof mod.description === "string" ? mod.description : "";
    const version = typeof mod.version === "string" || typeof mod.version === "number" ? mod.version : null;
    if (input.registry[name]) {
      return {
        name,
        description,
        version,
        scope: input.scope,
        ownerAlias: input.ownerAlias,
        path: input.path,
        status: "shadowed",
        error: `Function name is already registered: ${name}`,
        hash,
      };
    }
    if (typeof mod.default !== "function") {
      return {
        name,
        description,
        version,
        scope: input.scope,
        ownerAlias: input.ownerAlias,
        path: input.path,
        status: "error",
        error: "Pipeline function module must default-export a function",
        hash,
      };
    }
    input.registry[name] = async (stepInput: JsonObject): Promise<JsonObject> => {
      const result = await (mod.default as (value: JsonObject) => unknown | Promise<unknown>)(stepInput);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error(`Pipeline function ${name} must return a JSON object`);
      }
      return result as JsonObject;
    };
    return {
      name,
      description,
      version,
      scope: input.scope,
      ownerAlias: input.ownerAlias,
      path: input.path,
      status: "ok",
      error: null,
      hash,
    };
  } catch (error) {
    return {
      name: fallbackName,
      description: "",
      version: null,
      scope: input.scope,
      ownerAlias: input.ownerAlias,
      path: input.path,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      hash,
    };
  }
}

function isFunctionModule(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mjs");
}

function functionNameFromFilename(path: string): string {
  const base = basename(path).replace(/\.(ts|js|mjs)$/i, "").replace(/\.v\d+$/i, "");
  const parts = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "function";
  return parts.map((part, index) => {
    if (index === 0) return part;
    return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
  }).join("");
}

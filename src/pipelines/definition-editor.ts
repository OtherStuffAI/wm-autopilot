import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { DeclarativePipeline, DeclarativeStep } from "./declarative";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import { nextVersionedDefinitionPathForSource } from "./pipeline-loader";
import type { JsonObject } from "./pipeline-store";

export interface ManualDefinitionEditResult {
  sourcePath: string;
  targetPath: string;
  spec: DeclarativePipeline;
}

export async function writeManualDefinitionVersion(
  definition: PipelineDefinitionRecord,
  body: Record<string, unknown>,
): Promise<ManualDefinitionEditResult> {
  const targetPath = await nextVersionedDefinitionPathForSource(definition.path);
  const spec = buildEditedDefinition(definition, body, targetPath);
  await writeFile(targetPath, `${JSON.stringify(spec, null, 2)}\n`);
  return {
    sourcePath: definition.path,
    targetPath,
    spec,
  };
}

function buildEditedDefinition(
  definition: PipelineDefinitionRecord,
  body: Record<string, unknown>,
  targetPath: string,
): DeclarativePipeline {
  const name = requireString(body.name, "name");
  const description = optionalString(body.description, "description");
  const tags = optionalTags(body.tags);
  const isDefault = body.default === true;
  const input = requireJsonObject(body.input, "input");
  const steps = requireSteps(body.steps);
  const version = versionFromPath(targetPath) ?? nextNumericVersion(definition.spec.version);
  const spec: DeclarativePipeline = {
    ...definition.spec,
    name,
    version,
    supersedes: basename(definition.path),
    default: isDefault,
    tags,
    input,
    steps,
  };
  if (description) {
    spec.description = description;
  } else {
    delete spec.description;
  }
  return spec;
}

function optionalTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("tags must be an array");
  }
  return [...new Set(value
    .map((entry) => typeof entry === "string" ? entry.trim().toLowerCase() : "")
    .filter(Boolean))]
    .sort();
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value.trim() || undefined;
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function requireSteps(value: unknown): DeclarativeStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("steps must be a non-empty array");
  }
  for (const [index, step] of value.entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`steps[${index}] must be an object`);
    }
    const record = step as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim()) {
      throw new Error(`steps[${index}].name is required`);
    }
    if (typeof record.type !== "string" || !record.type.trim()) {
      throw new Error(`steps[${index}].type is required`);
    }
  }
  return value as DeclarativeStep[];
}

function versionFromPath(path: string): number | null {
  const match = basename(path).match(/\.v(\d+)\.json$/i);
  return match ? Number(match[1]) : null;
}

function nextNumericVersion(value: unknown): number {
  const current = Number(value);
  return Number.isFinite(current) ? current + 1 : 1;
}

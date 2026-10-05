import { readFile } from "node:fs/promises";
import { isChatAddressable, chatPipelineDescriptor } from "../pipelines/chat-pipeline-catalogue.ts";
import type { PipelineDefinitionRecord } from "../pipelines/pipeline-loader.ts";
import type { JsonObject } from "../pipelines/pipeline-store.ts";

export function pipelineRecommendations(definitions: PipelineDefinitionRecord[]): JsonObject[] {
  return definitions.filter(d => d.spec.enabled !== false && isChatAddressable(d)).map(chatPipelineDescriptor);
}

// Read registrations and their exported descriptors from the callable capability
// source. No second list of descriptions and no mutation of a session's tools.
export async function toolRecommendations(names: string[]): Promise<JsonObject[]> {
  if (!names.length) return [];
  const entry = new URL("../mcp/stdio-server.ts", import.meta.url);
  const source = await readFile(entry, "utf8");
  const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)];
  const registrations = [...source.matchAll(/registerWingmanTool\(server,\s*["']([^"']+)["'],\s*(\w+),\s*(\w+)/g)];
  return await Promise.all(names.map(async name => {
    const registration = registrations.find(r => r[1] === name);
    if (!registration) throw new Error(`Tool ${name} is not in the current callable tool registrations.`);
    const declaration = imports.find(i => i[1]!.split(",").map(s => s.trim()).includes(registration[2]!));
    if (!declaration) throw new Error(`Tool ${name} has no discoverable descriptor source.`);
    const path = new URL(`${declaration[2]}.ts`, entry);
    const exports = await import(path.href);
    const description = exports[registration[2]!];
    const schema = exports[registration[3]!];
    if (typeof description !== "string" || !schema) throw new Error(`Tool ${name} has an invalid descriptor.`);
    return { key: `tool:${name}`, kind: "tool", name, description, source: path.pathname,
      input: Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, (value as any)._def?.typeName ?? "typed"])),
      invocation: `Discover and invoke ${name} through the session's existing MCP tools. Descriptor only; no hot-loading or permission grant.` };
  }));
}

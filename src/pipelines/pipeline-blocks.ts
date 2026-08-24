import type { DeclarativeStep } from "./declarative";

export interface PipelineBlockExpansion {
  scratchPath: string;
  inputPath: string;
  outputPath: string;
  steps: DeclarativeStep[];
}

export function expandPipelineBlock(step: Extract<DeclarativeStep, { type: "block" }>): PipelineBlockExpansion {
  if (step.block !== "memory.graphContext") {
    throw new Error(`Unknown pipeline block: ${step.block}`);
  }
  const scratchPath = `$.blocks.${sanitizePathPart(step.name || step.block)}`;
  const inputPath = `${scratchPath}.input`;
  const outputPath = step.assign ?? "$.graphMemory";
  return {
    scratchPath,
    inputPath,
    outputPath,
    steps: [
      {
        name: `${step.name} / extract-memory-entities`,
        description: "Extract searchable long-term-memory entities from the current prompt.",
        type: "agent",
        agent: `${inputPath}.agent`,
        directory: `${inputPath}.directory`,
        input: {
          pick: {
            prompt: `${inputPath}.prompt`,
            entityLimit: `${inputPath}.entityLimit`,
          },
        },
        prompt: [
          "Extract entities, concepts, projects, files, people, systems, decisions, and constraints worth searching long-term graph memory for.",
          "Return a JSON result object with this exact shape:",
          "{ \"entities\": [{ \"name\": \"...\", \"type\": \"project|file|person|system|decision|constraint|concept|other\", \"reason\": \"why this may matter\", \"query\": \"search query text\" }] }",
          "Keep entities specific and useful. Prefer 3-8 entities. Do not include prose outside the JSON result.",
        ].join(" "),
        assign: `${scratchPath}.entityExtraction`,
      },
      {
        name: `${step.name} / search-graph-memory`,
        description: "Run parallel vector searches for the extracted entities.",
        type: "code",
        function: "memory.searchEntities",
        input: {
          pick: {
            prompt: `${inputPath}.prompt`,
            entities: `${scratchPath}.entityExtraction.entities`,
            topKPerEntity: `${inputPath}.topKPerEntity`,
            maxEntities: `${inputPath}.maxEntities`,
            maxMatches: `${inputPath}.maxMatches`,
            index: `${inputPath}.index`,
            ownerNpub: `${inputPath}.ownerNpub`,
          },
        },
        assign: `${scratchPath}.rawMatches`,
      },
      {
        name: `${step.name} / consolidate-graph-context`,
        description: "Consolidate graph memory matches into agent-consumable graphContext.",
        type: "code",
        function: "memory.consolidateGraphContext",
        input: {
          pick: {
            prompt: `${inputPath}.prompt`,
            entities: `${scratchPath}.entityExtraction.entities`,
            matches: `${scratchPath}.rawMatches.matches`,
            warnings: `${scratchPath}.rawMatches.warnings`,
            maxChars: `${inputPath}.maxChars`,
          },
        },
        assign: outputPath,
      },
    ],
  };
}

function sanitizePathPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "block";
}

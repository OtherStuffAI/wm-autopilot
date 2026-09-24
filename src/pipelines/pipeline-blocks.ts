import type { DeclarativeStep } from "./declarative";

export interface PipelineBlockExpansion {
  scratchPath: string;
  inputPath: string;
  outputPath: string;
  steps: DeclarativeStep[];
}

export function expandPipelineBlock(step: Extract<DeclarativeStep, { type: "block" }>): PipelineBlockExpansion {
  const scratchPath = `$.blocks.${sanitizePathPart(step.name || step.block)}`;
  const inputPath = `${scratchPath}.input`;
  const outputPath = step.assign ?? defaultBlockOutputPath(step.block);
  if (step.block === "flightdeck.sendDirectMessage") {
    return {
      scratchPath,
      inputPath,
      outputPath,
      steps: [
        {
          name: `${step.name} / send-direct-message`,
          description: "Validate the sender as an active Autopilot agent and deliver the Markdown message to the exact two-party Flight Deck DM.",
          type: "code",
          function: "flightdeck.sendDirectMessage",
          input: {
            pick: {
              fromNpub: `${inputPath}.fromNpub`,
              toNpub: `${inputPath}.toNpub`,
              message: `${inputPath}.message`,
            },
          },
          assign: outputPath,
          display: {
            in: [
              { label: "From Agent", path: "$.fromNpub", format: "text" },
              { label: "To", path: "$.toNpub", format: "text" },
              { label: "Message", path: "$.message", format: "text" },
            ],
            out: [
              { label: "Delivered", path: "$.delivered" },
              { label: "Channel", path: "$.channelId", format: "text" },
              { label: "Message ID", path: "$.messageId", format: "text" },
            ],
          },
        },
      ],
    };
  }
  if (step.block === "jev.rerankCandidates") {
    return {
      scratchPath,
      inputPath,
      outputPath,
      steps: [
        {
          name: `${step.name} / judge-candidates`,
          description: "Obtain one independent Jev Noul relevance probability for every query-candidate pair; errors remain explicit for fail-open composition.",
          type: "parallel",
          source: `${inputPath}.candidates`,
          itemKey: "id",
          maxConcurrency: `${inputPath}.maxConcurrency`,
          itemInput: {
            pick: {
              query: `${inputPath}.query`,
              priorContext: `${inputPath}.priorContext`,
              candidate: "$item",
            },
          },
          step: {
            name: "judge-candidate-relevance",
            description: "Judge only whether this candidate would materially help satisfy the supplied brief in light of compact prior context.",
            type: "classifier",
            provider: "openrouter",
            mode: "decisions",
            model: "~typesafe/jev-latest",
            failurePolicy: "record_error",
            retries: 1,
            timeoutMs: 15_000,
            prompt: "Use only query, priorContext and candidate. Do not research, select, summarize or infer missing facts. Return the configured narrow relevance judgment.",
            questions: {
              relevance: {
                type: "noul",
                instructions: "Would `candidate` materially help satisfy `query`, considering `priorContext` only to avoid already-covered or mismatched material?",
                criteria: {
                  true: "The candidate provides directly useful, material evidence or coverage for the supplied brief.",
                  false: "The candidate is irrelevant, duplicative of prior coverage, too weakly connected, or would not materially help satisfy the brief.",
                },
              },
            },
          },
          assign: `${scratchPath}.judgments`,
          display: {
            in: [
              { label: "Editorial Brief", path: `${inputPath}.query`, format: "text" },
              { label: "Candidates", path: `${inputPath}.candidates`, format: "records", limit: 20 },
            ],
            out: [
              { label: "Jev Results", path: "$.items", format: "records", limit: 20 },
              { label: "Completed", path: "$.ok", format: "count" },
              { label: "Errors", path: "$.error", format: "count" },
            ],
          },
        },
        {
          name: `${step.name} / compose-rerank`,
          description: "Deterministically sort stable ties, enforce threshold/count/context budgets, calculate replay metrics, and restore the complete original set on any incomplete Jev result.",
          type: "code",
          function: "jev.composeRerank",
          input: {
            pick: {
              candidates: `${inputPath}.candidates`,
              knownSelectedIds: `${inputPath}.knownSelectedIds`,
              config: `${inputPath}.config`,
              judgments: `${scratchPath}.judgments`,
            },
          },
          assign: outputPath,
          display: {
            in: [
              { label: "Candidates", path: "$.candidates", format: "records", limit: 20 },
              { label: "Jev Results", path: "$.judgments.items", format: "records", limit: 20 },
            ],
            out: [
              { label: "Mode", path: "$.mode", format: "text" },
              { label: "Selected Candidates", path: "$.selectedCandidates", format: "records", limit: 20 },
              { label: "Metrics", path: "$.metrics", format: "json" },
              { label: "Warnings", path: "$.warnings", format: "list", empty: "None" },
            ],
          },
        },
      ],
    };
  }
  if (step.block !== "memory.graphContext") {
    throw new Error(`Unknown pipeline block: ${step.block}`);
  }
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

function defaultBlockOutputPath(block: Extract<DeclarativeStep, { type: "block" }>['block']): string {
  if (block === "jev.rerankCandidates") return "$.jevRerank";
  if (block === "flightdeck.sendDirectMessage") return "$.directMessage";
  return "$.graphMemory";
}

function sanitizePathPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "block";
}

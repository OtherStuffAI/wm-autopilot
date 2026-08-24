import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPipelineDefinition,
  getSharedPipelineDefinitionsDirectory,
  getUserPipelineDefinitionsDirectory,
  listLatestPipelineDefinitions,
  makePipelineSlug,
  nextVersionedDefinitionPath,
  nextVersionedDefinitionPathForSource,
  selectLatestPipelineDefinitions,
  type PipelineDefinitionRecord,
} from "./pipeline-loader";

let tempDir: string;
let previousPipelineRoot: string | undefined;

beforeEach(async () => {
  previousPipelineRoot = process.env.WINGMEN_PIPELINES_ROOT;
  tempDir = await mkdtemp(join(tmpdir(), "wingmen-pipeline-loader-test-"));
  process.env.WINGMEN_PIPELINES_ROOT = tempDir;
});

afterEach(() => {
  if (previousPipelineRoot === undefined) {
    delete process.env.WINGMEN_PIPELINES_ROOT;
  } else {
    process.env.WINGMEN_PIPELINES_ROOT = previousPipelineRoot;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("pipeline definition version paths", () => {
  test("creates stable slugs from prompts", () => {
    expect(makePipelineSlug("Split paragraphs, analyse #2, then finalise!")).toBe("split-paragraphs-analyse-2-then-finalise");
  });

  test("allocates the next version without overwriting prior declarations", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "paragraph-analysis.v1.json"), "{}\n");
    writeFileSync(join(tempDir, "paragraph-analysis.v2.json"), "{}\n");

    await expect(nextVersionedDefinitionPath(tempDir, "paragraph-analysis")).resolves.toBe(
      join(tempDir, "paragraph-analysis.v3.json"),
    );
    await expect(nextVersionedDefinitionPathForSource(join(tempDir, "paragraph-analysis.v2.json"))).resolves.toBe(
      join(tempDir, "paragraph-analysis.v3.json"),
    );
  });

  test("selects only the latest declaration per versioned slug", () => {
    const records = [
      makeRecord("article-review.v1", 1),
      makeRecord("article-review.v3", 3),
      makeRecord("article-review.v2", 2),
      makeRecord("other-workflow", undefined),
    ];

    expect(selectLatestPipelineDefinitions(records).map((record) => record.slug)).toEqual([
      "article-review.v3",
      "other-workflow",
    ]);
  });

  test("resolves seeded dispatch definitions by stable slug", async () => {
    const definition = await getPipelineDefinition("fd-agent-dispatch-chat", "tester");

    expect(definition?.id.startsWith("shared:")).toBe(true);
    expect(definition?.slug).toBe("fd-agent-dispatch-chat");
    expect(definition?.name).toBe("fd-agent-dispatch-chat");
    expect(definition?.spec.steps.map((step) => step.name)).toEqual([
      "prepare-workroom-participant-metadata",
      "hydrate-chat-context",
      "prepare-intent-input",
      "prepare-short-lookup-answer",
      "analyse-intent",
      "normalise-decision",
      "dispatch-agent",
      "normalise-agent-work-decision",
      "route-discussion-chat",
      "prepare-task-pipeline-input",
      "select-task-pipeline",
      "normalise-task-pipeline-selection",
      "create-in-progress-task",
      "start-selected-pipeline",
      "start-required-pipelines",
      "start-direct-pipeline",
      "reload-chat-thread-before-reply",
      "mark-response-drafting",
      "prepare-chat-response",
      "publish-chat-response",
    ]);
    expect(definition?.spec.steps.find((step) => step.name === "analyse-intent")).toMatchObject({
      type: "classifier",
      when: { path: "$.agentDecision.skipAgent", equals: false },
      provider: "openrouter",
      model: "openai/gpt-oss-120b:nitro",
      retries: 3,
    });
    expect(definition?.spec.steps.find((step) => step.name === "prepare-short-lookup-answer")).toMatchObject({
      type: "code",
      function: "dispatch.prepareShortLookupAnswer",
    });
    expect(definition?.spec.steps.find((step) => step.name === "dispatch-agent")).toMatchObject({
      type: "agent",
      when: { path: "$.decision.dispatchAgent", equals: true },
    });
    expect(JSON.stringify(definition?.spec.steps.find((step) => step.name === "analyse-intent"))).toContain(
      "Classify only as answer_now, think_then_answer, create_task, or ignore",
    );
    expect(JSON.stringify(definition?.spec.steps.find((step) => step.name === "analyse-intent"))).toContain(
      "Do not choose child pipelines",
    );
    expect(definition?.spec.steps.map((step) => step.name)).toContain("select-task-pipeline");
    expect(definition?.spec.steps.map((step) => step.name)).toContain("normalise-task-pipeline-selection");
    expect(JSON.stringify(definition?.spec.steps.find((step) => step.name === "analyse-intent"))).toContain(
      "chatDispatchInput.channelContext.contextPrompt",
    );
    expect(definition?.spec.steps.find((step) => step.name === "hydrate-chat-context")?.display?.out).toContainEqual({
      label: "Self Authored",
      path: "$.selfAuthored",
    });
    expect(definition?.spec.steps.find((step) => step.name === "prepare-intent-input")?.display?.out).toContainEqual({
      label: "Channel Context",
      path: "$.channelContext.contextPrompt",
      format: "text",
    });
    expect(definition?.spec.steps.find((step) => step.name === "publish-chat-response")).toMatchObject({
      when: { path: "$.chatContext.shouldProceed", equals: true },
    });
  });

  test("resolves Flight Deck PG dispatch definition aliases", async () => {
    const chatDefinition = await getPipelineDefinition("fd-agent-dispatch-chat", "tester");
    const taskDefinition = await getPipelineDefinition("fd-agent-dispatch-task-response", "tester");
    const commentDefinition = await getPipelineDefinition("fd-agent-dispatch-comment-response", "tester");

    expect(chatDefinition?.id.startsWith("shared:")).toBe(true);
    expect(chatDefinition?.slug).toBe("fd-agent-dispatch-chat");
    expect(chatDefinition?.name).toBe("fd-agent-dispatch-chat");
    expect(chatDefinition?.spec.supersedes).toBe("agent-dispatch-chat");
    expect(chatDefinition?.spec.steps.map((step) => step.name)).toContain("publish-chat-response");
    expect(taskDefinition?.slug).toBe("fd-agent-dispatch-task-response");
    expect(taskDefinition?.spec.supersedes).toBe("agent-dispatch-task-response");
    expect(JSON.stringify(taskDefinition?.spec.steps.find((step) => step.name === "investigate-and-route-task"))).toContain(
      "flightDeckContext.channel.contextPrompt",
    );
    expect(commentDefinition?.slug).toBe("fd-agent-dispatch-comment-response");
    expect(commentDefinition?.spec.supersedes).toBe("agent-dispatch-comment-response");
    expect(JSON.stringify(commentDefinition?.spec.steps.find((step) => step.name === "draft-comment-response"))).toContain(
      "flightDeckContext.channel.contextPrompt",
    );
  });

  test("resolves stable user definition aliases to the latest version", async () => {
    const userDir = getUserPipelineDefinitionsDirectory("tester");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "stable-chat.v1.json"), JSON.stringify({
      name: "stable-chat",
      version: 1,
      input: {},
      steps: [],
    }));
    writeFileSync(join(userDir, "stable-chat.v2.json"), JSON.stringify({
      name: "stable-chat",
      version: 2,
      input: {},
      steps: [],
    }));

    const definition = await getPipelineDefinition("stable-chat", "tester");

    expect(definition?.slug).toBe("stable-chat.v2");
    expect(definition?.spec.version).toBe(2);
  });

  test("skips invalid definition files instead of failing the whole definitions list", async () => {
    await getPipelineDefinition("fd-agent-dispatch-chat", "tester");
    writeFileSync(join(getSharedPipelineDefinitionsDirectory(), "broken.json"), "{ not valid json\n");

    const definitions = await listLatestPipelineDefinitions("tester");

    expect(definitions.some((definition) => definition.slug === "fd-agent-dispatch-chat")).toBe(true);
    expect(definitions.some((definition) => definition.slug === "broken")).toBe(false);
  });

  test("seeds task pipeline handoff steps explicitly", async () => {
    const intake = await getPipelineDefinition("agent-dispatch-task-response", "tester");
    const software = await getPipelineDefinition("software-implementation-manager-review", "tester");
    const generic = await getPipelineDefinition("do-and-review", "tester");
    const research = await getPipelineDefinition("research-and-report", "tester");
    const implementationLoop = await getPipelineDefinition("software-implementation-review-loop", "tester");
    const implementationLoopAlias = await getPipelineDefinition("implementation-review-loop.v2", "tester");

    expect(intake?.spec.steps.map((step) => step.name)).toEqual([
      "investigate-and-route-task",
      "normalise-work-plan",
      "move-task-to-in-progress",
      "start-follow-up-pipeline",
      "publish-task-update",
    ]);
    expect(software).toBeNull();
    expect(generic?.spec.steps.at(-1)).toMatchObject({
      name: "move-task-to-review",
      type: "code",
      function: "dispatch.markTaskReadyForReview",
    });
    expect(research?.spec.steps.at(-1)).toMatchObject({
      name: "move-task-to-review",
      type: "code",
      function: "dispatch.markTaskReadyForReview",
    });
    expect(implementationLoop?.spec.steps[0]).toMatchObject({
      name: "ensure-review-loop-task",
      type: "code",
      function: "dispatch.ensureImplementationReviewTask",
    });
    expect(implementationLoopAlias?.slug).toBe("software-implementation-review-loop");
    expect(implementationLoop?.spec.default).toBe(true);
    expect(implementationLoop?.spec.tags).toContain("software");
    expect(implementationLoop?.spec.steps.find((step) => step.name === "comment-manager-progress")).toMatchObject({
      type: "code",
      function: "dispatch.commentImplementationReviewProgress",
    });
    expect(implementationLoop?.spec.steps.find((step) => step.name === "ensure-review-loop-task")?.input).toMatchObject({
      pick: {
        designDocumentUrl: "$.designDocumentUrl",
        designDocumentUnavailableReason: "$.designDocumentUnavailableReason",
      },
    });
    expect(implementationLoop?.spec.steps.find((step) => step.name === "implementation-worker")?.input).toMatchObject({
      pick: {
        designDocumentUrl: "$.createdTask.workPlan.designDocumentUrl",
        designDocumentUnavailableReason: "$.createdTask.workPlan.designDocumentUnavailableReason",
      },
    });
    expect(implementationLoop?.spec.steps.find((step) => step.name === "managerial-review")?.input).toMatchObject({
      pick: {
        designDocumentUrl: "$.createdTask.workPlan.designDocumentUrl",
        designDocumentUnavailableReason: "$.createdTask.workPlan.designDocumentUnavailableReason",
      },
    });
    expect(implementationLoop?.spec.steps.find((step) => step.name === "close-review-task")).toMatchObject({
      name: "close-review-task",
      type: "code",
      function: "dispatch.markTaskReadyForReview",
    });
    expect(generic?.spec.steps.find((step) => step.name === "do-work")?.input).toEqual({
      pick: {
        createdTask: "$.workContext.createdTask",
        workPlan: "$.workContext.workPlan",
      },
    });
    expect(generic?.spec.steps.find((step) => step.name === "do-work")?.prompt).toContain(
      "do not return callback status needs_input; return callback status ok with completed false",
    );
    expect(generic?.spec.steps.find((step) => step.name === "manager-review")?.prompt).toContain(
      "handoffable partial outcome",
    );
    expect(research?.spec.steps.find((step) => step.name === "report-writer")?.input).toEqual({
      pick: {
        taskId: "$.workContext.createdTask.taskId",
        taskSummary: "$.workContext.workPlan.taskSummary",
        instructions: "$.workContext.workPlan.instructions",
        acceptanceCriteria: "$.workContext.workPlan.acceptanceCriteria",
        reporting: "$.workContext.workPlan.reporting",
        researchQuestion: "$.researchResult.researchQuestion",
        findings: "$.researchResult.findings",
        sources: "$.researchResult.sources",
        contradictions: "$.researchResult.contradictions",
        openQuestions: "$.researchResult.openQuestions",
        evidence: "$.researchResult.evidence",
        blockers: "$.researchResult.blockers",
      },
    });
  });
});

function makeRecord(slug: string, version: number | undefined): PipelineDefinitionRecord {
  return {
    id: `id-${slug}`,
    slug,
    name: slug.startsWith("article-review") ? "Article Review" : "Other Workflow",
    scope: "user",
    ownerAlias: "tester",
    path: join(tempDir, `${slug}.json`),
    spec: {
      name: slug,
      version,
      steps: [{ name: "step", type: "code", function: "text.normalise" }],
    },
  };
}

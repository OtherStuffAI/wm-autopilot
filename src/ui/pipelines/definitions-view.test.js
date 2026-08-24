import { describe, expect, test } from "bun:test";

import { getDefinitionFlowRows, renderDefinitionDetailPage, renderDefinitionsListPage } from "./definitions-view.js";

function makeState(overrides = {}) {
  return {
    definitions: [
      {
        id: "one",
        name: "One",
        description: "First pipeline",
        scope: "user",
        default: false,
        tags: [],
        steps: [],
      },
      {
        id: "two",
        name: "Two",
        description: "Second pipeline",
        scope: "shared",
        default: true,
        tags: ["default"],
        steps: [{ name: "Step", type: "code" }],
      },
    ],
    definitionSearch: "",
    definitionFilter: "all",
    definitionTagFilter: "",
    creatorOpen: false,
    wizardPrompt: "",
    wizardBusy: false,
    wizardResult: null,
    ...overrides,
  };
}

describe("pipeline definition list rendering", () => {
  test("renders the new pipeline creator before the definition list", () => {
    const html = renderDefinitionsListPage(makeState({ creatorOpen: true }));

    expect(html).toContain('data-testid="pipeline-creator"');
    expect(html.indexOf('data-testid="pipeline-creator"')).toBeLessThan(
      html.indexOf('data-testid="pipeline-definition-list"'),
    );
  });

  test("renders definition steps as definitions in and activity out", () => {
    const definition = {
      id: "semantic",
      name: "Semantic",
      description: "Shows display rows",
      scope: "user",
      default: false,
      tags: [],
      steps: [{
        name: "Hydrate",
        type: "code",
        input: { pick: { chat: "$.chat.messageText" } },
        assign: "$.chatContext",
        display: {
          in: [{ label: "Message", path: "$.chat.messageText" }],
          out: [{ label: "Thread", path: "$.thread", source: "output" }],
        },
      }],
    };

    expect(getDefinitionFlowRows(definition.steps[0], "in")).toEqual([
      { name: "Message", value: "chat.messageText" },
    ]);
    expect(getDefinitionFlowRows(definition.steps[0], "out")).toEqual([
      { name: "Thread", value: "output: thread" },
    ]);

    const html = renderDefinitionDetailPage(makeState({ definitions: [definition] }), definition);
    expect(html).toContain("Definitions In");
    expect(html).toContain("Activity Out");
    expect(html).toContain("<code>Message</code>");
    expect(html).toContain("<code>Thread</code>");
  });

  test("renders agent prompts in definition previews", () => {
    const definition = {
      id: "agent-pipeline",
      name: "Agent Pipeline",
      description: "Shows agent prompts",
      scope: "user",
      default: false,
      tags: [],
      steps: [{
        name: "Decide",
        type: "agent",
        agent: "$.agent.defaultAgent",
        prompt: "Read the thread and decide what happens next.",
      }],
    };

    const html = renderDefinitionDetailPage(makeState({ definitions: [definition] }), definition);

    expect(html).toContain('data-testid="pipeline-agent-prompt-preview"');
    expect(html).toContain('data-testid="pipeline-agent-prompt-text"');
    expect(html).toContain("Read the thread and decide what happens next.");
    expect(html).toContain("Edit Prompt");
  });

  test("renders agent prompts as direct fields in manual edit mode", () => {
    const definition = {
      id: "agent-pipeline",
      name: "Agent Pipeline",
      description: "Shows agent prompts",
      scope: "user",
      default: false,
      tags: [],
      steps: [{
        name: "Decide",
        type: "agent",
        prompt: "Use the available context.",
      }],
    };

    const html = renderDefinitionDetailPage(makeState({
      definitions: [definition],
      manualEditDefinitionId: definition.id,
      manualEditForm: {
        name: definition.name,
        description: definition.description,
        tagsText: "",
        default: false,
        inputText: "{}",
        stepsText: JSON.stringify(definition.steps, null, 2),
      },
    }), definition);

    expect(html).toContain('data-testid="pipeline-manual-agent-prompts"');
    expect(html).toContain('data-action="manual-edit-agent-prompt"');
    expect(html).toContain('data-step-index="0"');
    expect(html).toContain("Use the available context.");
  });
});

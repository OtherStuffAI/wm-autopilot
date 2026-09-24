import { describe, expect, test } from "bun:test";
import { renderRunLauncher } from "./launcher-view.js";

describe("pipeline Flight Deck launcher", () => {
  test("renders the same four accessible domain inputs for every definition", () => {
    const state = {
      definitions: [{ id: "one", name: "One" }, { id: "two", name: "Two" }],
      flightDeckInput: { workspaceId: "workspace", threadId: "thread", frmNpub: "requester", prompt: "question" },
      runningId: null,
    };
    const html = renderRunLauncher(state, state.definitions[0]);

    expect(html).toContain('data-testid="flightdeck-pipeline-invocation"');
    expect(html).toContain('data-field="workspaceId"');
    expect(html).toContain('data-field="threadId"');
    expect(html).toContain('data-field="frmNpub"');
    expect(html).toContain('data-field="prompt"');
    expect(html).not.toContain("Run input JSON");
  });
});

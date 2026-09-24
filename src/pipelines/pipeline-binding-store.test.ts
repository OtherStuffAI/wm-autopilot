import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PipelineBindingStore } from "./pipeline-binding-store";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-pipeline-binding-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeStore(): PipelineBindingStore {
  return new PipelineBindingStore(join(tempDir, "bindings.sqlite"));
}

describe("PipelineBindingStore", () => {
  test("uses explicit implicit-all semantics and supports many-to-many availability", () => {
    const store = makeStore();
    expect(store.getAvailabilityMode("agent-1")).toBe("implicit_all");
    expect(store.listAvailableIds("agent-1")).toEqual([]);

    store.setAvailable("agent-1", ["pipeline-a", "pipeline-b", "pipeline-a"]);
    store.setAvailable("agent-2", ["pipeline-a"]);
    expect(store.getAvailabilityMode("agent-1")).toBe("explicit");
    expect(store.listAvailableIds("agent-1")).toEqual(["pipeline-a", "pipeline-b"]);
    expect(store.listAvailableIds("agent-2")).toEqual(["pipeline-a"]);

    store.setAvailable("agent-1", []);
    expect(store.getAvailabilityMode("agent-1")).toBe("explicit");
    expect(store.listAvailableIds("agent-1")).toEqual([]);

    store.useImplicitAvailability("agent-1");
    expect(store.getAvailabilityMode("agent-1")).toBe("implicit_all");
  });

  test("stores definition references without copying or changing definition JSON", () => {
    const definitionPath = join(tempDir, "pipeline.v1.json");
    const definitionJson = `${JSON.stringify({ name: "Pipeline", version: 1, input: { privateExample: "not binding data" }, steps: [] }, null, 2)}\n`;
    writeFileSync(definitionPath, definitionJson);
    const store = makeStore();

    store.setAvailable("agent-1", ["shared:definition-reference"]);
    store.setDefaults("agent-1", ["shared:definition-reference"]);

    expect(readFileSync(definitionPath, "utf8")).toBe(definitionJson);
    expect(store.listAvailableIds("agent-1")).toEqual(["shared:definition-reference"]);
    expect(readFileSync(store.path).includes(Buffer.from("not binding data"))).toBe(false);
  });

  test("persists defaults and resolves channel, scope, workspace, then default precedence", () => {
    const path = join(tempDir, "bindings.sqlite");
    const store = new PipelineBindingStore(path);
    expect(store.getDefaultMode("agent-1")).toBe("implicit_library");
    store.setDefaults("agent-1", ["pipeline-default"]);
    store.setOverride({ agentId: "agent-1", kind: "workspace", contextId: "workspace-1", pipelineDefinitionId: "pipeline-workspace" });
    store.setOverride({ agentId: "agent-1", kind: "scope", contextId: "scope-1", pipelineDefinitionId: "pipeline-scope" });
    store.setOverride({ agentId: "agent-1", kind: "channel", contextId: "channel-1", pipelineDefinitionId: "pipeline-channel" });

    const reopened = new PipelineBindingStore(path);
    expect(reopened.getDefaultMode("agent-1")).toBe("explicit");
    expect(reopened.resolve({
      agentId: "agent-1", workspaceId: "workspace-1", scopeId: "scope-1", channelId: "channel-1",
    })).toEqual({ pipelineDefinitionId: "pipeline-channel", source: "channel", contextId: "channel-1" });

    expect(reopened.removeOverride("agent-1", "channel", "channel-1")).toBe(true);
    expect(reopened.resolve({
      agentId: "agent-1", workspaceId: "workspace-1", scopeId: "scope-1", channelId: "channel-1",
    })).toEqual({ pipelineDefinitionId: "pipeline-scope", source: "scope", contextId: "scope-1" });

    reopened.removeOverride("agent-1", "scope", "scope-1");
    reopened.removeOverride("agent-1", "workspace", "workspace-1");
    expect(reopened.resolve({ agentId: "agent-1", workspaceId: "workspace-1" })).toEqual({
      pipelineDefinitionId: "pipeline-default", source: "default", contextId: null,
    });
    reopened.setDefaults("agent-1", []);
    expect(reopened.resolve({ agentId: "agent-1" })).toEqual({
      pipelineDefinitionId: null, source: "none", contextId: null,
    });
  });
});

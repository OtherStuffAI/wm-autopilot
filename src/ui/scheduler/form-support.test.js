import { describe, expect, test } from "bun:test";

import { createSchedulerFormSupport } from "./form-support.js";

const config = {
  defaultDirectory: "/workspace",
  agents: [
    { id: "codex", modelOptions: ["default", "gpt-5.5"] },
    { id: "goose", modelOptions: ["default", "openrouter/moonshotai/kimi-k3"] },
  ],
};

describe("scheduler form support", () => {
  test("keeps model choices aligned with the selected agent", () => {
    const support = createSchedulerFormSupport({ getConfig: () => config, getDefaultAgent: () => "codex" });
    const form = { agent: "goose", model: "openrouter/moonshotai/kimi-k3" };

    expect(support.modelOptions(form.agent)).toEqual(["default", "openrouter/moonshotai/kimi-k3"]);
    expect(support.modelForPayload(form.model)).toBe("openrouter/moonshotai/kimi-k3");

    form.agent = "codex";
    support.syncModel(form);
    expect(form.model).toBe("default");
    expect(support.modelForPayload(form.model)).toBeNull();
  });

  test("opens the shared directory browser and writes the selected path", async () => {
    let request = null;
    const support = createSchedulerFormSupport({
      getConfig: () => config,
      getDefaultAgent: () => "codex",
      openDirectoryBrowser: async (options) => {
        request = options;
        options.onSelect("/workspace/project");
      },
    });
    const form = { workingDirectory: "" };

    await support.browseDirectory(form, "workingDirectory", "Select Working Directory");

    expect(request).toMatchObject({
      initialPath: "/workspace",
      title: "Select Working Directory",
      confirmLabel: "Use This Directory",
      allowCreate: true,
    });
    expect(form.workingDirectory).toBe("/workspace/project");
  });
});

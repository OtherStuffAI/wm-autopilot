import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  buildRemoteInstructVariables,
  loadRemoteInstruct,
  RemoteInstructConfigError,
  renderRemoteInstructTemplate,
} from "./remote-instruct";

describe("remote instruct template rendering", () => {
  test("substitutes known dollar variables", () => {
    const result = renderRemoteInstructTemplate(
      "Host $hostname handles $project_reference from $default_workdir.",
      {
        hostname: "box-1",
        project_reference: "Project A",
        default_workdir: "/workspace",
      },
    );

    expect(result.content).toBe("Host box-1 handles Project A from /workspace.");
    expect(result.missingVariables).toEqual([]);
  });

  test("leaves unknown variables in place and reports them", () => {
    const result = renderRemoteInstructTemplate("Use $known and $unknown.", {
      known: "this",
    });

    expect(result.content).toBe("Use this and $unknown.");
    expect(result.missingVariables).toEqual(["unknown"]);
  });

  test("builds stable variables for the remote prompt", () => {
    const variables = buildRemoteInstructVariables({
      autopilotUrl: "https://autopilot.example",
      defaultWorkdir: "/workspace",
      agentTypes: ["codex", "claude"],
      viewerNpub: "npub1viewer",
      authMethod: "nip98",
      projectReference: "Acme Project",
    });

    expect(variables.autopilot_url).toBe("https://autopilot.example");
    expect(variables.default_workdir).toBe("/workspace");
    expect(variables.agent_types).toBe("claude, codex");
    expect(variables.viewer_npub).toBe("npub1viewer");
    expect(variables.auth_method).toBe("nip98");
    expect(variables.project_reference).toBe("Acme Project");
    expect(variables.hostname.length).toBeGreaterThan(0);
  });

  test("surfaces a missing prompt file as configuration error", async () => {
    const missingPath = join(import.meta.dir, "missing-remote-instruct.md");

    await expect(loadRemoteInstruct({
      promptPath: missingPath,
      variables: {},
    })).rejects.toBeInstanceOf(RemoteInstructConfigError);
  });
});

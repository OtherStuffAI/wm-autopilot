import { describe, expect, test } from "bun:test";

import { describeGitRemote } from "./remote-auth";

describe("describeGitRemote", () => {
  test("detects GitHub HTTPS remotes", () => {
    const remote = describeGitRemote("origin", "https://github.com/openai/wingmen.git");
    expect(remote.isGithub).toBe(true);
    expect(remote.usesSsh).toBe(false);
    expect(remote.host).toBe("github.com");
  });

  test("detects GitHub SSH remotes", () => {
    const remote = describeGitRemote("origin", "git@github.com:openai/wingmen.git");
    expect(remote.isGithub).toBe(true);
    expect(remote.usesSsh).toBe(true);
    expect(remote.host).toBe("github.com");
  });

  test("matches the configured Gitea host", () => {
    const remote = describeGitRemote(
      "gitea",
      "https://gitea.example.com/example-owner/wingmen.git",
      { giteaUrl: "https://gitea.example.com" },
    );
    expect(remote.isGitea).toBe(true);
    expect(remote.isGithub).toBe(false);
  });
});

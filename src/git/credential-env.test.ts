import { describe, expect, test } from "bun:test";

import { mergeGitCredentialEnvs } from "./credential-env";

describe("mergeGitCredentialEnvs", () => {
  test("preserves multiple host-scoped git credential helpers", () => {
    const merged = mergeGitCredentialEnvs(
      {
        WINGMAN_GITHUB_USERNAME: "example-user",
        WINGMAN_GITHUB_TOKEN: "ghp_secret",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_0: "/tmp/github-helper.sh",
      },
      {
        WINGMAN_GITEA_OWNER: "example-owner",
        WINGMAN_GITEA_TOKEN: "gitea_secret",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.https://gitea.example.com.helper",
        GIT_CONFIG_VALUE_0: "/tmp/gitea-helper.sh",
      },
    );

    expect(merged.GIT_CONFIG_COUNT).toBe("2");
    expect(merged.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(merged.GIT_CONFIG_KEY_1).toBe("credential.https://gitea.example.com.helper");
    expect(merged.WINGMAN_GITHUB_TOKEN).toBe("ghp_secret");
    expect(merged.WINGMAN_GITEA_TOKEN).toBe("gitea_secret");
  });
});

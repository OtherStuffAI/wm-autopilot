import { describe, expect, test } from "bun:test";

import { replaceWingmanGitCredentialConfig } from "./wingman-credential-env";

describe("Wingman Git credential environment", () => {
  test("adds only advertised HTTPS gateways with useHttpPath", () => {
    const result = replaceWingmanGitCredentialConfig({}, [
      "https://git-b.example.test",
      "https://git-a.example.test:8443",
    ]);
    expect(result).toEqual({
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "credential.https://git-a.example.test:8443.helper",
      GIT_CONFIG_VALUE_0: "wingman",
      GIT_CONFIG_KEY_1: "credential.https://git-a.example.test:8443.useHttpPath",
      GIT_CONFIG_VALUE_1: "true",
      GIT_CONFIG_KEY_2: "credential.https://git-b.example.test.helper",
      GIT_CONFIG_VALUE_2: "wingman",
      GIT_CONFIG_KEY_3: "credential.https://git-b.example.test.useHttpPath",
      GIT_CONFIG_VALUE_3: "true",
    });
  });

  test("removes stale Wingman entries while preserving other helpers", () => {
    const result = replaceWingmanGitCredentialConfig({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "/tmp/github-helper",
      GIT_CONFIG_KEY_1: "credential.https://stale.example.test.helper",
      GIT_CONFIG_VALUE_1: "wingman",
      GIT_CONFIG_KEY_2: "credential.https://stale.example.test.useHttpPath",
      GIT_CONFIG_VALUE_2: "true",
      KEEP_ME: "yes",
    }, ["https://current.example.test"]);
    expect(result).toEqual({
      KEEP_ME: "yes",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "/tmp/github-helper",
      GIT_CONFIG_KEY_1: "credential.https://current.example.test.helper",
      GIT_CONFIG_VALUE_1: "wingman",
      GIT_CONFIG_KEY_2: "credential.https://current.example.test.useHttpPath",
      GIT_CONFIG_VALUE_2: "true",
    });
  });

  test("preserves useHttpPath settings owned by another helper", () => {
    const result = replaceWingmanGitCredentialConfig({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://other.example.test.helper",
      GIT_CONFIG_VALUE_0: "other-helper",
      GIT_CONFIG_KEY_1: "credential.https://other.example.test.useHttpPath",
      GIT_CONFIG_VALUE_1: "true",
    }, []);
    expect(result.GIT_CONFIG_COUNT).toBe("2");
    expect(result.GIT_CONFIG_KEY_1).toBe("credential.https://other.example.test.useHttpPath");
  });

  test.each([
    "http://git.example.test",
    "https://user@git.example.test",
    "https://git.example.test/path",
  ])("rejects an invalid advertised origin: %s", (origin) => {
    expect(() => replaceWingmanGitCredentialConfig({}, [origin])).toThrow(
      "Native Forgejo configuration contains an invalid origin.",
    );
  });
});

import { describe, expect, test } from "bun:test";

import {
  canonicalizeGitCredentialRequest,
  formatGitCredentialOutput,
  parseGitCredentialInput,
} from "./wingman-credential-protocol";

describe("Wingman Git credential protocol", () => {
  test("parses standard fields and preserves unknown fields", () => {
    const parsed = parseGitCredentialInput(
      "protocol=https\nhost=git.example.test\npath=studio/project.git\nwwwauth[]=Basic realm=git\n\n",
    );
    expect(parsed.protocol).toBe("https");
    expect(parsed.host).toBe("git.example.test");
    expect(parsed.path).toBe("studio/project.git");
    expect(parsed.fields.get("wwwauth[]")).toBe("Basic realm=git");
  });

  test("canonicalizes exactly one repository path", () => {
    expect(canonicalizeGitCredentialRequest({
      protocol: "https",
      host: "git.example.test:8443",
      path: "studio/project.git",
    })).toEqual({
      protocol: "https",
      host: "git.example.test:8443",
      path: "/studio/project.git",
      gatewayOrigin: "https://git.example.test:8443",
      organization: "studio",
      repository: "project",
    });
  });

  test("preserves mixed-case repository identity for Tower resolution", () => {
    expect(canonicalizeGitCredentialRequest({
      protocol: "https",
      host: "GIT.EXAMPLE.TEST",
      path: "Studio/ProjectName.git",
    })).toEqual({
      protocol: "https",
      host: "git.example.test",
      path: "/Studio/ProjectName.git",
      gatewayOrigin: "https://git.example.test",
      organization: "Studio",
      repository: "ProjectName",
    });
  });

  test.each([
    [{ protocol: "http", host: "git.example.test", path: "studio/project.git" }],
    [{ protocol: "https", host: "user@git.example.test", path: "studio/project.git" }],
    [{ protocol: "https", host: "git.example.test", path: "studio/project" }],
    [{ protocol: "https", host: "git.example.test", path: "studio/one/two.git" }],
    [{ protocol: "https", host: "git.example.test", path: "studio/%2e%2e.git" }],
  ])("rejects non-HTTPS, malformed hosts, and malformed repository paths", (input) => {
    expect(() => canonicalizeGitCredentialRequest(input)).toThrow();
  });

  test("formats only the Git username and password fields", () => {
    expect(formatGitCredentialOutput({ username: "nostr", password: "opaque" }))
      .toBe("username=nostr\npassword=opaque\n\n");
  });
});

import { describe, expect, mock, test } from "bun:test";

import { runWingmanCredentialHelper } from "./wingman-credential-helper";

function fixture(input: string) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      readStdin: async () => input,
      writeStdout: (value: string) => { stdout += value; },
      writeStderr: (value: string) => { stderr += value; },
    },
    output: () => ({ stdout, stderr }),
  };
}

describe("git-credential-wingman", () => {
  test("reports a stable executable version", async () => {
    const f = fixture("");
    expect(await runWingmanCredentialHelper("--version", f.io)).toBe(0);
    expect(f.output()).toEqual({ stdout: "git-credential-wingman 3\n", stderr: "" });
  });

  test("gets an ephemeral credential only through the loopback broker context", async () => {
    const f = fixture("protocol=https\nhost=git.example.test\npath=studio/project.git\n\n");
    const requests: Request[] = [];
    const exitCode = await runWingmanCredentialHelper("get", f.io, {
      wingmanUrl: "http://127.0.0.1:3600",
      sessionId: "session-a",
      capabilityToken: "session-capability",
      fetch: mock(async (request: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(request, init));
        return Response.json({ username: "nostr", password: "ephemeral", expiresAt: "2030-01-01T00:00:00.000Z" });
      }),
    });
    expect(exitCode).toBe(0);
    expect(f.output()).toEqual({ stdout: "username=nostr\npassword=ephemeral\n\n", stderr: "" });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).hostname).toBe("127.0.0.1");
    expect(await requests[0]!.json()).toEqual({
      sessionId: "session-a",
      protocol: "https",
      host: "git.example.test",
      path: "/studio/project.git",
    });
  });

  test("accepts repeated Git capability fields from the credential protocol", async () => {
    const f = fixture([
      "capability[]=authtype",
      "capability[]=state",
      "protocol=https",
      "host=git.example.test",
      "path=studio/project.git",
      'wwwauth[]=Basic realm="Wingman Git", charset="UTF-8"',
      "",
    ].join("\n"));
    const exitCode = await runWingmanCredentialHelper("get", f.io, {
      wingmanUrl: "http://127.0.0.1:3600",
      sessionId: "session-a",
      capabilityToken: "session-capability",
      fetch: mock(async () => Response.json({
        username: "nostr",
        password: "ephemeral",
        expiresAt: "2030-01-01T00:00:00.000Z",
      })),
    });
    expect(exitCode).toBe(0);
    expect(f.output().stderr).toBe("");
  });

  test.each(["store", "erase"])("%s is a successful no-op when no cache is used", async (action) => {
    const f = fixture("protocol=https\nhost=git.example.test\npath=studio/project.git\n\n");
    expect(await runWingmanCredentialHelper(action, f.io)).toBe(0);
    expect(f.output()).toEqual({ stdout: "", stderr: "" });
  });

  test("does not print broker response data on failure", async () => {
    const f = fixture("protocol=https\nhost=git.example.test\npath=studio/project.git\n\n");
    const exitCode = await runWingmanCredentialHelper("get", f.io, {
      wingmanUrl: "http://127.0.0.1:3600",
      sessionId: "session-a",
      capabilityToken: "session-capability",
      fetch: mock(async () => Response.json({ error: "denied", password: "must-not-leak" }, { status: 403 })),
    });
    expect(exitCode).toBe(1);
    expect(JSON.stringify(f.output())).not.toContain("must-not-leak");
  });

  test("rejects a non-loopback broker before making a request", async () => {
    const f = fixture("protocol=https\nhost=git.example.test\npath=studio/project.git\n\n");
    const fetchImpl = mock(async () => Response.json({}));
    expect(await runWingmanCredentialHelper("get", f.io, {
      wingmanUrl: "https://autopilot.example.test",
      sessionId: "session-a",
      capabilityToken: "session-capability",
      fetch: fetchImpl,
    })).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(f.output().stderr).toContain("loopback capability broker");
  });
});

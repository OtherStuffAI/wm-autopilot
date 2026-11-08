import { expect, test } from "bun:test";

async function probe(cli: string, args: string[], payload: unknown = {}, status = 200, explicitBroker = true, handler?: (request: Request) => Promise<Response>) {
  const calls: Array<{ path: string; method: string; body: unknown; auth: string | null }> = [];
  const brokerCalls: unknown[] = [];
  const broker = Bun.serve({ port: 0, async fetch(request) {
    brokerCalls.push(await request.json());
    return Response.json({ token: "Nostr test-signature" });
  } });
  const api = Bun.serve({ port: 0, async fetch(request) {
    calls.push({ path: new URL(request.url).pathname + new URL(request.url).search, method: request.method, body: request.method === "GET" ? null : await request.json(), auth: request.headers.get("authorization") });
    return handler ? handler(request) : Response.json(payload, { status });
  } });
  try {
    const child = Bun.spawn([process.execPath, `./clis/${cli}.ts`, ...args, "--url", api.url.toString(), ...(explicitBroker ? ["--bot-crypto"] : [])], {
      env: { ...process.env, SESSION_ID: "test-session", WINGMAN_CAPABILITY: "test-capability", WINGMAN_BROKER_URL: broker.url.toString(), WINGMAN_NSEC: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code, calls, brokerCalls };
  } finally { await api.stop(true); await broker.stop(true); }
}

test("deploy and legacy session reads use broker without operator keys", async () => {
  for (const [cli, args, payload, path] of [
    ["deploy", ["list"], { apps: [] }, "/api/apps"],
    ["delegate-sessions", ["info", "exact-session"], { id: "exact-session" }, "/api/sessions/exact-session"],
  ] as const) {
    const result = await probe(cli, [...args], payload, 200, false);
    expect(result.code).toBe(0);
    expect(result.calls[0]).toMatchObject({ path, auth: "Nostr test-signature" });
    expect(result.brokerCalls).toHaveLength(1);
  }
});

test("deployment inspection selects exact local app and owner through broker", async () => {
  const result = await probe("deploy", ["deployments", "local app", "--owner", "npub-owner", "--caprover-name", "remote-prod"], { targets: [] });
  expect(result.code).toBe(0);
  expect(result.calls[0]!.path).toBe("/api/owners/npub-owner/apps/local%20app/caprover/deployments?caproverName=remote-prod");
});

test("deploy logs render lines and empty arrays correctly", async () => {
  expect((await probe("deploy", ["logs", "app"], { logs: ["first", "second"] })).stdout).toBe("first\nsecond\n");
  expect((await probe("deploy", ["logs", "app"], { logs: [] })).stdout).toBe("No logs available.\n");
});

test("feature flags render current array schema in flags and full", async () => {
  const payload = { apps: [], sessions: [], flags: [{ key: "policy", state: "on_admin", effectiveState: "off" }] };
  for (const command of ["flags", "full"]) {
    const result = await probe("status", [command], payload);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("policy\ton_admin\teffective=off");
    expect(result.stdout).not.toContain("undefined");
  }
});

test("feature flag setter uses PATCH state and validates before transport", async () => {
  for (const [input, state] of [["true", "on"], ["false", "off"], ["on_admin", "on_admin"]]) {
    const result = await probe("status", ["flags-set", "flag/key", input!]);
    expect(result.code).toBe(0);
    expect(result.calls[0]).toMatchObject({ path: "/api/feature-flags/flag%2Fkey", method: "PATCH", body: { state } });
  }
  const invalid = await probe("status", ["flags-set", "flag", "typo"]);
  expect(invalid.code).toBe(1);
  expect(invalid.calls).toHaveLength(0);
  expect(invalid.brokerCalls).toHaveLength(0);
});

test("owner pipeline routing and scheduler trigger outcomes retain meaning", async () => {
  const owner = await probe("pipelines", ["runs", "--owner", "exact-owner"], { runs: [] });
  expect(owner.code).toBe(0);
  expect(owner.calls[0]!.path).toBe("/api/owners/exact-owner/pipelines/runs");
  for (const [payload, output] of [[{ pipelineRunId: "run-1" }, "pipeline run run-1"], [{ sessionId: "session-1" }, "session session-1"], [{ cleanup: { removed: 2 } }, 'cleanup {"removed":2}'], [{}, "no work started"]] as const) {
    const result = await probe("scheduler", ["trigger", "job"], payload);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(output);
    expect(result.stdout).not.toContain("session ?");
  }
});

test("unknown, retired, misplaced and surplus arguments fail before transport", async () => {
  for (const [cli, args] of [
    ["deploy", ["list", "extra"]], ["deploy", ["deploy", "app"]], ["deploy", ["deploy", "app", "--target", "all"]], ["deploy", ["status", "app", "--owner"]],
    ["deploy", ["list", "--caprover-name", "ignored"]],
    ["delegate-sessions", ["list", "--model", "ignored"]],
    ["delegate-sessions", ["list", "--owner"]],
    ["pipelines", ["runs", "extra"]], ["pipelines", ["runs", "--dry-run"]],
    ["scheduler", ["list", "--nightwatch", "true"]], ["scheduler", ["list", "extra"]],
    ["scheduler", ["create", "--prompt", "a", "--prompt-file", "/missing"]],
    ["scheduler", ["create", "--name", "a", "--agent", "codex", "--directory", "/tmp", "--prompt", "work", "--cron", "* * * * *", "--pipeline-input", "{}"]],
    ["scheduler", ["list", "--enabled", "true"]], ["scheduler", ["list", "--owner", "--name", "wrong"]],
    ["status", ["flags", "--owner", "ignored"]],
  ] as const) {
    const result = await probe(cli, [...args]);
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(0);
    expect(result.brokerCalls).toHaveLength(0);
  }
});

test("full status surfaces authorization errors instead of false empty status", async () => {
  const result = await probe("status", ["full"], { error: "denied" }, 403);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("403 denied");
  expect(result.stdout).toBe("");
});

 test("HTTP failures in operational reads remain visible", async () => {
  for (const [cli, args] of [["deploy", ["list"]], ["delegate-sessions", ["list"]], ["pipelines", ["runs"]], ["scheduler", ["list"]]] as const) {
    const result = await probe(cli, [...args], { error: "scope-denied" }, 403);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("403 scope-denied");
    expect(result.stdout).toBe("");
  }
});

test("deploy requires an exact target and inspection filters without changing remote state", async () => {
  const deployed = await probe("deploy", ["deploy", "app", "--target", "production"]);
  expect(deployed.code).toBe(0);
  expect(deployed.calls[0]).toMatchObject({ method: "POST", path: "/api/apps/app/deploy-to-caprover", body: { caproverName: "app", caproverTarget: "production" } });
  const inspected = await probe("deploy", ["deployments", "app", "--target", "production"], { targets: [{ name: "staging" }, { name: "production", linked: true }] });
  expect(inspected.code).toBe(0);
  expect(JSON.parse(inspected.stdout).targets).toEqual([{ name: "production", linked: true }]);
  expect(inspected.calls[0]!.method).toBe("GET");
  expect((await probe("deploy", ["deployments", "app", "--target", "missing"], { targets: [] })).code).toBe(1);
});

test("delegated compatibility info uses maintained server route without legacy owner binding", async () => {
  const { handleSessionApi } = await import("../src/server/session-api-routes");
  const { AccessActions } = await import("../src/auth/access-control");
  const session = { id: "exact-session", status: "running", npub: "caller" };
  const ctx = {
    AccessActions, ensureApiAccess: async () => null,
    isAdminNpub: () => false, getViewerNormalizedNpub: () => "caller",
    manager: { listSessions: () => [session] }, sessionBelongsToViewer: (owner: string, _metadata: unknown, viewer: string) => owner === viewer,
    serializeSession: (value: unknown) => value,
  } as unknown as import("../src/server/session-api-routes").SessionApiContext;
  const auth = { authMethod: "nip98", npub: null, subjectNpub: null, signerNpub: null, delegatedByBot: false, delegatedOwnerNpub: null } as unknown as import("../src/auth/request-context").RequestAuthContext;
  const result = await probe("delegate-sessions", ["info", "exact-session"], {}, 200, true, async request =>
    await handleSessionApi(request, new URL(request.url), "GET", auth, ctx) ?? Response.json({ error: "unhandled" }, { status: 404 }));
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).id).toBe("exact-session");
  expect(result.calls[0]!.path).toBe("/api/sessions/exact-session");
  const owned = await probe("delegate-sessions", ["info", "exact-session", "--owner", "chosen-owner"], { id: "exact-session" });
  expect(owned.calls[0]!.path).toBe("/api/owners/chosen-owner/sessions/exact-session");
});

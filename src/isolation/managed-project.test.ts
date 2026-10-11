import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolatedProject } from "./managed-project.ts";

const image = process.env.WINGMAN_ISOLATION_TEST_IMAGE;
const runtimeTest = image ? test : test.skip;
function file(path: string, content: string) {
  return { path, base64: Buffer.from(content).toString("base64") };
}

runtimeTest("actual managed profile denies host authority and preserves scoped state", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "wm-isolation-synthetic-"));
  try {
    await writeFile(join(fixture, "sibling-project.txt"), "SYNTHETIC sibling");
    await writeFile(join(fixture, "credential.txt"), "SYNTHETIC credential");
    const script = `
      import { readFileSync, writeFileSync, existsSync, statfsSync } from "node:fs";
      function deny(name, operation) { let denied = false; try { operation(); } catch { denied = true; } if (!denied) throw Error(name + " allowed"); console.log(name + ": denied"); }
      deny("sibling", () => readFileSync(${JSON.stringify(join(fixture, "sibling-project.txt"))}));
      deny("credential", () => readFileSync(${JSON.stringify(join(fixture, "credential.txt"))}));
      if (existsSync("/proc/${process.ppid}")) throw Error("host PID exposed");
      deny("host-parent", () => readFileSync("/proc/${process.ppid}/mem"));
      deny("privileged-process", () => readFileSync("/proc/1/mem"));
      deny("root-write", () => writeFileSync("/etc/unauthorized", "x"));
      for (const path of ["/var/run/docker.sock", "/run/wingman", "/Users/mini", "/home/wingman/.codex/auth.json"]) if (existsSync(path)) throw Error("host authority exposed: " + path);
      if (!/^CapEff:\\s+0+$/m.test(readFileSync("/proc/self/status", "utf8"))) throw Error("capabilities exposed");
      if (!/^NoNewPrivs:\\s+1$/m.test(readFileSync("/proc/self/status", "utf8"))) throw Error("privilege escalation allowed");
      if (!/^Seccomp:\\s+2$/m.test(readFileSync("/proc/self/status", "utf8"))) throw Error("seccomp disabled");
      if (statfsSync("/workspace").blocks * statfsSync("/workspace").bsize !== 67108864) throw Error("workspace unbounded");
      if (statfsSync("/continuity").blocks * statfsSync("/continuity").bsize !== 33554432) throw Error("continuity unbounded");
      for (const key of Object.keys(process.env)) if (/BROKER|SECRET|TOKEN|PRIV|SESSION_ID|API_KEY/.test(key)) throw Error("authority env exposed");
      for (const url of ["http://1.1.1.1", "http://host.docker.internal:3600", "http://127.0.0.1:3600/api/system/restart"]) {
        let denied = false; try { await fetch(url, { signal: AbortSignal.timeout(1000) }); } catch { denied = true; }
        if (!denied) throw Error("network allowed: " + url);
      }
      console.log("network/signing/service-management: denied");
      if (process.getuid() !== 10001) throw Error("privileged uid");
      if (readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim() !== "536870912") throw Error("memory unbounded");
      if (readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim() !== "128") throw Error("pids unbounded");
      writeFileSync("allowed.txt", "project edited");
      writeFileSync("/continuity/native-reference.txt", "synthetic-native-123");
    `;
    const first = await runIsolatedProject(image!, { project: [file("check.ts", script)], continuity: [], command: ["bun", "check.ts"], durationMs: 20000 });
    expect(first.stdout).toContain("sibling: denied");
    expect(first.stdout).toContain("privileged-process: denied");
    expect(first.stdout).toContain("network/signing/service-management: denied");
    expect(first.project.find((f) => f.path === "allowed.txt")?.base64).toBe(Buffer.from("project edited").toString("base64"));
    const second = await runIsolatedProject(image!, {
      project: first.project, continuity: first.continuity,
      command: ["bun", "-e", 'if (await Bun.file("/continuity/native-reference.txt").text() !== "synthetic-native-123") throw Error("lost state"); console.log("continuity restored");'],
      durationMs: 10000,
    });
    expect(second.stdout).toContain("continuity restored");
    console.log(JSON.stringify({ first: first.containerName, second: second.containerName, image, nativeResume: "pending; synthetic persistence only" }));
  } finally { await rm(fixture, { recursive: true, force: true }); }
}, 40000);

runtimeTest("deadline removes the container and its generated descendants", async () => {
  await expect(runIsolatedProject(image!, { project: [], continuity: [], command: ["sh", "-c", "sleep 60 & wait"], durationMs: 1000 })).rejects.toThrow("deadline");
}, 15000);

runtimeTest("rejects links rather than exporting host-directed paths", async () => {
  await expect(runIsolatedProject(image!, { project: [], continuity: [], command: ["sh", "-c", "ln -s /etc/passwd bad"], durationMs: 10000 })).rejects.toThrow("links or special files");
}, 15000);

runtimeTest("bounds generated script output", async () => {
  await expect(runIsolatedProject(image!, { project: [], continuity: [], command: ["bun", "-e", 'console.log("x".repeat(100000))'], durationMs: 10000 })).rejects.toThrow("output limit");
}, 15000);

runtimeTest("credential-free model gateway grants only bounded inference over isolated loopback", async () => {
  let calls = 0;
  const script = `
    const url = process.env.OPENAI_BASE_URL;
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) throw Error("credential exposed");
    const send = (path, body) => fetch(url + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    for (const [path, body] of [["/system/restart", {}], ["/responses", { model: "wrong", input: [] }], ["/responses", { model: "fixture-model", input: [], previous_response_id: "other-project" }], ["/responses", { model: "fixture-model", input: [], tools: [{ type: "mcp", server_url: "http://host" }] }]]) {
      if ((await send(path, body)).status !== 403) throw Error("unauthorized gateway capability");
    }
    const reply = await send("/responses", { model: "fixture-model", input: [], stream: true });
    if (await reply.text() !== "synthetic model response") throw Error("missing inference");
    let networkDenied = false; try { await fetch("http://1.1.1.1", { signal: AbortSignal.timeout(1000) }); } catch { networkDenied = true; }
    if (!networkDenied) throw Error("external network allowed");
    console.log("gateway inference allowed; unauthorized capabilities denied");
  `;
  const result = await runIsolatedProject(image!, { project: [file("gateway.ts", script)], continuity: [], command: ["bun", "gateway.ts"], durationMs: 10000 }, {
    model: "fixture-model",
    async responses(body) {
      calls++;
      expect(body.store).toBe(false);
      expect(body.model).toBe("fixture-model");
      return { contentType: "text/event-stream", body: "synthetic model response" };
    },
  });
  expect(calls).toBe(1);
  expect(result.stdout).toContain("unauthorized capabilities denied");
}, 15000);

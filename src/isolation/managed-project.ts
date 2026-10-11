import { jsonLines } from "./json-lines.ts";
import { PROVIDER_LIMITS, validateProviderRequest, validateProviderReply } from "./provider-policy.ts";
import type { ProjectProvider } from "./provider-policy.ts";
import { randomUUID } from "node:crypto";
import { containerArguments, PROJECT_PROFILE, validateExecution, validateSnapshot } from "./project-profile.ts";
import type { ProjectExecution, ProjectFile } from "./project-profile.ts";

export interface IsolatedResult {
  containerName: string;
  image: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  project: ProjectFile[];
  continuity: ProjectFile[];
}

async function boundedText(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Isolation transport output limit exceeded");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function docker(args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 10_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      boundedText(proc.stdout, 65536), boundedText(proc.stderr, 65536), proc.exited,
    ]);
    if (code !== 0) throw new Error(`Isolation runtime failed (${code}): ${stderr.slice(0, 2048)}`);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

/** Opt-in trusted control-plane API. Never accept image/command selection from a participant. */
export async function runIsolatedProject(image: string, input: ProjectExecution, provider?: ProjectProvider): Promise<IsolatedResult> {
  if (input.providerModel) throw new Error("Model capability must come from the trusted provider grant");
  const payload = { ...input, ...(provider ? { providerModel: provider.model } : {}) };
  validateExecution(payload);
  const containerName = `wm-project-${randomUUID()}`;
  const args = containerArguments(containerName, image);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let deadlineKill: Promise<string> | undefined;
  const abort = new AbortController();
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const runtime = await docker(["info", "--format", "{{.OSType}} {{.MemoryLimit}} {{.SwapLimit}} {{.CPUCfsQuota}} {{.PidsLimit}} {{json .SecurityOptions}}"]);
    if (!runtime.startsWith("linux true true true true ") || !runtime.includes("name=seccomp,profile=builtin")) {
      throw new Error("Isolation requires Linux cgroup resource limits and builtin seccomp");
    }
    const volumes = await docker(["image", "inspect", image, "--format", "{{json .Config.Volumes}}"]);
    if (volumes !== "null" && volumes !== "{}") throw new Error("Isolation image-declared volumes are forbidden");
    await docker(args);
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort(new Error("Isolation deadline exceeded"));
      deadlineKill = docker(["kill", containerName]);
      // Observe rejection immediately; still require successful removal below.
      void deadlineKill.catch(() => undefined);
      proc?.kill();
    }, input.durationMs);
    proc = Bun.spawn(["docker", "start", "--attach", "--interactive", containerName], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    if (!proc.stdin || typeof proc.stdin === "number" || !proc.stdout || typeof proc.stdout === "number" ||
      !proc.stderr || typeof proc.stderr === "number") throw new Error("Missing isolation transport pipes");
    const sink = proc.stdin;
    sink.write(JSON.stringify(payload) + "\n");
    if (!provider) sink.end();
    const receive = async (): Promise<IsolatedResult | undefined> => {
      let result: IsolatedResult | undefined;
      let requests = 0;
      const ids = new Set<number>();
      for await (const value of jsonLines(proc!.stdout as ReadableStream<Uint8Array>, PROJECT_PROFILE.outputBytes)) {
        const frame = value as { type: string; id: number; body: unknown; result: IsolatedResult };
        if (result) throw new Error("Unexpected frame after isolation result");
        if (frame.type === "result") { result = frame.result; sink.end(); }
        else if (frame.type === "provider" && provider && ++requests <= PROVIDER_LIMITS.requests &&
          Number.isInteger(frame.id) && frame.id > 0 && !ids.has(frame.id)) {
          ids.add(frame.id);
          const body = validateProviderRequest(frame.body, provider.model);
          const reply = await callProvider(provider, body, abort.signal);
          validateProviderReply(reply);
          sink.write(JSON.stringify({ id: frame.id, reply }) + "\n");
        } else throw new Error("Unauthorized isolation transport capability");
      }
      return result;
    };
    const [result, stderr, code] = await Promise.all([
      receive(), boundedText(proc.stderr, 65536), proc.exited,
    ]);
    if (timedOut) throw new Error("Isolation deadline exceeded");
    if (code !== 0) throw new Error(`Isolated execution failed (${code}): ${stderr.slice(0, 2048)}`);
    if (!result) throw new Error("Missing isolation result");
    validateSnapshot(result.project);
    validateSnapshot(result.continuity);
    if (result.exitCode !== 0 || typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 65536) {
      throw new Error("Invalid isolation result");
    }
    return { ...result, containerName, image };
  } catch (error) {
    if (timedOut) throw new Error("Isolation deadline exceeded");
    throw error;
  } finally {
    abort.abort();
    if (timer) clearTimeout(timer);
    proc?.kill();
    if (deadlineKill) await deadlineKill.catch(() => undefined);
    // Remove even if create returned uncertain failure; names are unique and scoped.
    // A failed cleanup is an explicit runtime fault, never successful acceptance.
    try {
      await docker(["rm", "--force", containerName]);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("No such container")) throw error;
    }
  }
}

async function callProvider(provider: ProjectProvider, body: Record<string, unknown>, signal: AbortSignal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  deadline.throwIfAborted();
  let rejectAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(deadline.reason);
    deadline.addEventListener("abort", rejectAbort, { once: true });
  });
  try { return await Promise.race([provider.responses(body, deadline), timeout]); }
  finally { if (rejectAbort) deadline.removeEventListener("abort", rejectAbort); }
}

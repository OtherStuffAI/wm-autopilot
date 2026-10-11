import { jsonLines } from "./json-lines.ts";
import { startContainerGateway } from "./container-gateway.ts";
import type { ProviderReply } from "./provider-policy.ts";
import { mkdir, readdir, lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_PROFILE, validateExecution, validateSnapshot } from "./project-profile.ts";
import type { ProjectExecution, ProjectFile } from "./project-profile.ts";

async function restore(root: string, files: ProjectFile[]): Promise<void> {
  for (const file of files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(file.base64, "base64"), { mode: 0o600 });
  }
}

async function snapshot(root: string): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  let bytes = 0;
  let entries = 0;
  async function walk(relative: string): Promise<void> {
    for (const name of await readdir(join(root, relative))) {
      if (++entries > PROJECT_PROFILE.maxFiles) throw new Error("Snapshot entry limit exceeded");
      const path = relative ? `${relative}/${name}` : name;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && info.nlink === 1) {
        bytes += info.size;
        if (bytes > PROJECT_PROFILE.snapshotBytes) throw new Error("Snapshot byte limit exceeded");
        files.push({ path, base64: (await readFile(join(root, path))).toString("base64") });
      } else throw new Error("Isolation output contains links or special files");
    }
  }
  await walk("");
  validateSnapshot(files);
  return files;
}

async function main(): Promise<void> {
  const frames = jsonLines(Bun.stdin.stream(), 80 * 1024 * 1024);
  const first = await frames.next();
  if (first.done) throw new Error("Missing isolation input");
  const input = first.value as ProjectExecution;
  validateExecution(input);
  const deadline = setTimeout(() => process.exit(124), input.durationMs);
  await restore("/workspace", input.project);
  await restore("/continuity", input.continuity);
  const gateway = input.providerModel ? startContainerGateway(input.providerModel) : undefined;
  if (gateway) {
    void (async () => {
      for await (const frame of frames) gateway.receive(frame as { id: number; reply: ProviderReply | null });
    })().catch(() => process.exit(125));
  }
  const child = Bun.spawn(input.command, {
    cwd: "/workspace",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/continuity", CODEX_HOME: "/continuity/.codex", TMPDIR: "/tmp",
      ...(gateway ? { OPENAI_BASE_URL: gateway.baseUrl } : {}) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let outputBytes = 0;
  async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      outputBytes += chunk.length;
      if (outputBytes > 65536) {
        child.kill();
        throw new Error("Command output limit exceeded");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const [stdout, stderr, exitCode] = await Promise.all([collect(child.stdout), collect(child.stderr), child.exited]);
  // The trusted host kills the entire container at the deadline, including descendants.
  if (exitCode !== 0) throw new Error(`Isolated command failed (${exitCode}): ${stderr.slice(0, 2048)}`);
  gateway?.stop();
  console.log(JSON.stringify({ type: "result", result: { exitCode, stdout, stderr, project: await snapshot("/workspace"), continuity: await snapshot("/continuity") } }));
  clearTimeout(deadline);
}

await main();

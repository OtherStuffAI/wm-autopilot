import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const upstream = "https://github.com/coder/agentapi.git";
const commit = "9ff117e231822f670305254ef24f6389f75953f4";
const root = resolve(import.meta.dir, "..");
const patchPath = join(root, "vendor", "agentapi", "loopback-listener.patch");
const outputPath = join(root, "out", "agentapi");
const provenancePath = `${outputPath}.provenance.json`;

async function run(command: string[], cwd?: string): Promise<string> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "wingman-agentapi-"));
const source = join(temporaryRoot, "source");
await run(["git", "clone", "--quiet", upstream, source]);
await run(["git", "checkout", "--quiet", commit], source);
const resolvedCommit = await run(["git", "rev-parse", "HEAD"], source);
if (resolvedCommit !== commit) throw new Error(`Unexpected AgentAPI commit: ${resolvedCommit}`);
await run(["git", "apply", "--check", patchPath], source);
await run(["git", "apply", patchPath], source);
await run(["go", "build", "-trimpath", "-o", outputPath, "."], source);

const digest = createHash("sha256").update(await readFile(outputPath)).digest("hex");
await writeFile(provenancePath, `${JSON.stringify({
  upstream,
  upstream_commit: commit,
  patch: "vendor/agentapi/loopback-listener.patch",
  sha256: digest,
}, null, 2)}\n`, { mode: 0o644 });
console.log(`Built loopback-only AgentAPI: ${digest}`);
